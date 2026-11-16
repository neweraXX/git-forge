import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { Repository, Failure, requireValue, zero, hash, type Obj } from './store.ts';

const names = ['', 'commit', 'tree', 'blob', 'tag'];
const flush = Buffer.from('0000'), delim = Buffer.from('0001');
export function pkt(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload) : payload;
  if (data.length > 65516) throw new Failure(400, 'Packet too large');
  return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, '0')), data]);
}
function packets(body: Buffer, stopAtFlush = false): { lines: Buffer[]; offset: number } {
  const lines: Buffer[] = [];
  let offset = 0;
  while (offset < body.length) {
    const head = body.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Failure(400, 'Invalid pkt-line');
    const length = parseInt(head, 16); offset += 4;
    if (length === 0) { if (stopAtFlush) break; continue; }
    if (length === 1 || length === 2) continue;
    if (length < 4 || length > 65520 || offset + length - 4 > body.length) throw new Failure(400, 'Truncated pkt-line');
    lines.push(body.subarray(offset, offset + length - 4)); offset += length - 4;
  }
  return { lines, offset };
}
function sideband(data: Buffer): Buffer {
  const chunks: Buffer[] = [];
  for (let pos = 0; pos < data.length; pos += 65515) chunks.push(pkt(Buffer.concat([Buffer.from([1]), data.subarray(pos, pos + 65515)])));
  chunks.push(flush); return Buffer.concat(chunks);
}
function deltaApply(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const variable = () => {
    let value = 0, scale = 1, byte: number;
    do { if (pos >= delta.length || scale > 2 ** 49) throw new Failure(400, 'Invalid delta size'); byte = delta[pos++]; value += (byte & 127) * scale; scale *= 128; } while (byte & 128);
    return value;
  };
  if (variable() !== base.length) throw new Failure(400, 'Delta base size mismatch');
  const size = variable();
  if (size > 64 * 1024 * 1024) throw new Failure(400, 'Delta too large');
  const out = Buffer.allocUnsafe(size); let dest = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (!op) throw new Failure(400, 'Invalid delta opcode');
    if (op & 128) {
      let start = 0, count = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) start += delta[pos++] * 2 ** (i * 8);
      for (let i = 0; i < 3; i++) if (op & (1 << (i + 4))) count += delta[pos++] * 2 ** (i * 8);
      if (!count) count = 65536;
      if (start + count > base.length || dest + count > size) throw new Failure(400, 'Delta copy out of range');
      base.copy(out, dest, start, start + count); dest += count;
    } else {
      if (pos + op > delta.length || dest + op > size) throw new Failure(400, 'Delta insert out of range');
      delta.copy(out, dest, pos, pos + op); pos += op; dest += op;
    }
  }
  if (dest !== size) throw new Failure(400, 'Delta result size mismatch');
  return out;
}
export function unpack(r: Repository, pack: Buffer): void {
  requireValue(pack.length >= 32 && pack.toString('ascii', 0, 4) === 'PACK', 400, 'Invalid pack header');
  const version = pack.readUInt32BE(4), count = pack.readUInt32BE(8);
  requireValue((version === 2 || version === 3) && count < 1000000, 400, 'Invalid pack version or count');
  const end = pack.length - 20;
  requireValue(createHash('sha1').update(pack.subarray(0, end)).digest().equals(pack.subarray(end)), 400, 'Pack checksum mismatch');
  let pos = 12;
  const offsets = new Map<number, Obj>(), staged = new Map<string, Obj>();
  const pending: { offset: number; baseOffset?: number; baseOid?: string; data: Buffer }[] = [];
  const save = (offset: number, object: Obj) => { offsets.set(offset, object); staged.set(hash(object.type, object.data), object); };
  for (let index = 0; index < count; index++) {
    const start = pos;
    let byte = pack[pos++], size = byte & 15, scale = 16;
    const type = (byte >> 4) & 7;
    while (byte & 128) { byte = pack[pos++]; size += (byte & 127) * scale; scale *= 128; if (scale > 2 ** 49) throw new Failure(400, 'Object size overflow'); }
    let baseOffset: number | undefined, baseOid: string | undefined;
    if (type === 6) {
      byte = pack[pos++]; let distance = byte & 127;
      while (byte & 128) { byte = pack[pos++]; distance = (distance + 1) * 128 + (byte & 127); }
      baseOffset = start - distance;
    } else if (type === 7) { baseOid = pack.subarray(pos, pos + 20).toString('hex'); pos += 20; }
    else if (!names[type]) throw new Failure(400, 'Unknown pack object type');
    requireValue(pos < end && size <= 64 * 1024 * 1024, 400, 'Invalid packed object');
    const result = inflateSync(pack.subarray(pos, end), { info: true, maxOutputLength: 64 * 1024 * 1024 }) as any;
    const data: Buffer = result.buffer;
    pos += result.engine.bytesWritten;
    requireValue(data.length === size, 400, 'Packed object size mismatch');
    if (type === 6 || type === 7) pending.push({ offset: start, baseOffset, baseOid, data });
    else save(start, { type: names[type], data, packed: pack.subarray(start, pos) });
  }
  requireValue(pos === end, 400, 'Extra pack data');
  while (pending.length) {
    let progress = false;
    for (let index = pending.length - 1; index >= 0; index--) {
      const item = pending[index], base = item.baseOffset !== undefined ? offsets.get(item.baseOffset) : staged.get(item.baseOid!) || r.objects.get(item.baseOid!);
      if (!base) continue;
      save(item.offset, { type: base.type, data: deltaApply(base.data, item.data) }); pending.splice(index, 1); progress = true;
    }
    requireValue(progress, 400, 'Missing delta base');
  }
  for (const [oid, obj] of staged) if (!r.objects.has(oid)) r.objects.set(oid, obj);
}
function packedObject(object: Obj): Buffer {
  if (object.packed) return object.packed;
  let size = object.data.length;
  const header = [(names.indexOf(object.type) << 4) | (size & 15)]; size = Math.floor(size / 16);
  while (size) { header[header.length - 1] |= 128; header.push(size & 127); size = Math.floor(size / 128); }
  object.packed = Buffer.concat([Buffer.from(header), deflateSync(object.data, { level: 1 })]);
  return object.packed;
}
function packObjects(r: Repository, ids: Set<string>): Buffer {
  const header = Buffer.alloc(12); header.write('PACK'); header.writeUInt32BE(2, 4); header.writeUInt32BE(ids.size, 8);
  const body = Buffer.concat([header, ...[...ids].map(oid => packedObject(requireValue(r.objects.get(oid))))]);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
function closure(r: Repository, tips: string[], boundaries = new Set<string>(), depth = Infinity): { ids: Set<string>; shallow: Set<string> } {
  const ids = new Set<string>(), shallow = new Set<string>(), commitDepth = new Map<string, number>();
  const queue: [string, number][] = tips.map(tip => [tip, 1]);
  for (let i = 0; i < queue.length; i++) {
    const [oid, generation] = queue[i], object = requireValue(r.objects.get(oid), 400, 'Missing object');
    if (ids.has(oid) && (object.type !== 'commit' || (commitDepth.get(oid) || 0) <= generation)) continue;
    ids.add(oid);
    if (object.type === 'commit') {
      commitDepth.set(oid, generation);
      const c = r.commit(oid); queue.push([c.tree, generation]);
      if (generation >= depth) { if (c.parents.length) shallow.add(oid); }
      else if (!boundaries.has(oid)) for (const p of c.parents) queue.push([p, generation + 1]);
    } else if (object.type === 'tree') {
      for (const entry of r.tree(oid)) if (entry.mode !== '160000') queue.push([entry.oid, generation]);
    } else if (object.type === 'tag') {
      const target = object.data.toString().match(/^object ([a-f0-9]{40})/m)?.[1]; if (target) queue.push([target, generation]);
    }
  }
  return { ids, shallow };
}
function peeled(r: Repository, oid: string): string | undefined {
  const object = r.objects.get(oid);
  if (object?.type !== 'tag') return undefined;
  return object.data.toString().match(/^object ([a-f0-9]{40})/m)?.[1];
}
function validateGraph(r: Repository, tips: string[]): void {
  const pending = [...tips], checked = new Set<string>();
  while (pending.length) {
    const oid = pending.pop()!;
    if (r.validated.has(oid) || checked.has(oid)) continue;
    const object = requireValue(r.objects.get(oid), 400, 'Missing object');
    checked.add(oid);
    if (object.type === 'commit') {
      const commit = r.commit(oid);
      pending.push(commit.tree, ...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of r.tree(oid)) if (entry.mode !== '160000') pending.push(entry.oid);
    } else if (object.type === 'tag') pending.push(requireValue(peeled(r, oid), 400, 'Invalid tag target'));
  }
  // Git objects are immutable: a validated closure remains valid across every ref update.
  for (const oid of checked) r.validated.add(oid);
}
function refs(r: Repository): [string, string][] {
  const list: [string, string][] = [...r.refs].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const head = r.resolve(); if (head) list.unshift(['HEAD', head]);
  return list;
}
const v2Advertisement = Buffer.concat(['version 2\n', 'agent=forge/1\n', 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n'].map(pkt).concat([flush]));
export function advertise(r: Repository, service: string, v2: boolean): Buffer {
  if (service === 'git-upload-pack' && v2) return v2Advertisement;
  const cacheKey = `advertise:${service}`, cached = r.refResponses.get(cacheKey);
  if (cached) return cached;
  const caps = service === 'git-receive-pack' ? 'report-status side-band-64k delete-refs ofs-delta agent=forge/1' : `multi_ack_detailed side-band-64k ofs-delta shallow symref=HEAD:refs/heads/${r.default_branch} agent=forge/1`;
  const list = refs(r), out = [pkt(`# service=${service}\n`), flush];
  if (!list.length) out.push(pkt(`${zero} capabilities^{}\0${caps}\n`));
  else list.forEach(([name, oid], index) => {
    out.push(pkt(`${oid} ${name}${index === 0 ? '\0' + caps : ''}\n`));
    const peel = peeled(r, oid); if (peel) out.push(pkt(`${peel} ${name}^{}\n`));
  });
  out.push(flush);
  const result = Buffer.concat(out); r.refResponses.set(cacheKey, result); return result;
}
export function receive(r: Repository, body: Buffer): Buffer {
  const parsed = packets(body, true), lines = parsed.lines.map(b => b.toString());
  const side = lines[0]?.split('\0')[1]?.includes('side-band-64k');
  const commands = lines.map(line => {
    const [old, next, ref] = line.split('\0')[0].trim().split(' ');
    requireValue(/^[a-f0-9]{40}$/.test(old) && /^[a-f0-9]{40}$/.test(next) && ref?.startsWith('refs/') && !/[\x00-\x20~^:?*\[\\]/.test(ref), 400, 'Invalid ref command');
    return { old, next, ref };
  });
  const report: Buffer[] = [];
  try {
    if (body.length > parsed.offset) unpack(r, body.subarray(parsed.offset));
    else requireValue(commands.every(c => c.next === zero), 400, 'Missing pack');
    // Check closure before updating refs, so corrupt/missing objects cannot create broken refs.
    validateGraph(r, commands.filter(c => c.next !== zero).map(c => c.next));
    report.push(pkt('unpack ok\n'));
    for (const c of commands) {
      const current = r.refs.get(c.ref) || zero;
      let reason = '';
      if (current !== c.old) reason = 'stale old object id';
      else if (c.next !== zero && c.old !== zero && !r.ancestor(c.old, c.next)) reason = 'non-fast-forward';
      if (reason) report.push(pkt(`ng ${c.ref} ${reason}\n`));
      else { r.setRef(c.ref, c.next); report.push(pkt(`ok ${c.ref}\n`)); }
    }
  } catch (error) {
    report.push(pkt('unpack invalid pack\n'));
    for (const c of commands) report.push(pkt(`ng ${c.ref} unpacker error\n`));
  }
  report.push(flush);
  return side ? sideband(Buffer.concat(report)) : Buffer.concat(report);
}
export function upload(r: Repository, body: Buffer, v2: boolean): Buffer {
  const key = `${v2 ? 2 : 0}:${body.toString('base64')}`;
  const cached = r.fetchCache.get(key) || r.refResponses.get(key); if (cached) return cached;
  const lines = packets(body).lines.map(b => b.toString().trim());
  if (lines.includes('command=ls-refs')) {
    const prefixes = lines.filter(l => l.startsWith('ref-prefix ')).map(l => l.slice(11));
    const out: Buffer[] = [];
    for (const [name, oid] of refs(r)) {
      if (prefixes.length && !prefixes.some(p => name.startsWith(p))) continue;
      const extra: string[] = [];
      if (name === 'HEAD' && lines.includes('symrefs')) extra.push(`symref-target:refs/heads/${r.default_branch}`);
      const peel = peeled(r, oid); if (peel && lines.includes('peel')) extra.push(`peeled:${peel}`);
      out.push(pkt(`${oid} ${name}${extra.length ? ' ' + extra.join(' ') : ''}\n`));
    }
    out.push(flush);
    const result = Buffer.concat(out);
    if (r.refResponses.size > 64) r.refResponses.clear();
    r.refResponses.set(key, result); return result;
  }
  const wants = lines.filter(l => l.startsWith('want ')).map(l => l.split(' ')[1]);
  const haves = lines.filter(l => l.startsWith('have ')).map(l => l.split(' ')[1]).filter(oid => r.objects.has(oid));
  const boundaries = new Set(lines.filter(l => l.startsWith('shallow ')).map(l => l.slice(8)));
  const depth = Number(lines.find(l => l.startsWith('deepen '))?.slice(7)) || Infinity;
  const wanted = closure(r, wants, new Set(), depth), held = closure(r, haves, boundaries).ids;
  for (const oid of held) wanted.ids.delete(oid);
  const out: Buffer[] = [];
  if (v2) {
    if (depth !== Infinity) {
      out.push(pkt('shallow-info\n'));
      for (const oid of wanted.shallow) out.push(pkt(`shallow ${oid}\n`));
      for (const oid of boundaries) if (!wanted.shallow.has(oid)) out.push(pkt(`unshallow ${oid}\n`));
      out.push(delim);
    }
    out.push(pkt('packfile\n'));
  } else {
    for (const oid of wanted.shallow) out.push(pkt(`shallow ${oid}\n`));
    if (depth !== Infinity) out.push(flush);
    out.push(pkt('NAK\n'));
  }
  out.push(sideband(packObjects(r, wanted.ids)));
  const result = Buffer.concat(out);
  if (r.fetchCache.size > 64) r.fetchCache.clear();
  r.fetchCache.set(key, result); return result;
}
