import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { Repository, Store, hash, zero } from '../store.ts';
import { unpack, receive, upload, pkt, advertise } from '../git.ts';
import { graphql } from '../graphql.ts';
import { createApp } from '../app.ts';
import { goServer } from './go-serve.ts';

// Independently construct small pack entries to exercise delta input, which the suite's
// optional output-delta check does not require a server to generate.
function entry(type: number, bytes: Buffer, reference = Buffer.alloc(0)): Buffer {
  let remaining = Math.floor(bytes.length / 16);
  const header = [(type << 4) | (bytes.length & 15)];
  while (remaining > 0) { header[header.length - 1] |= 128; header.push(remaining & 127); remaining = Math.floor(remaining / 128); }
  return Buffer.concat([Buffer.from(header), reference, deflateSync(bytes)]);
}
function pack(entries: Buffer[]): Buffer {
  const prefix = Buffer.alloc(12); prefix.write('PACK'); prefix.writeUInt32BE(2, 4); prefix.writeUInt32BE(entries.length, 8);
  const content = Buffer.concat([prefix, ...entries]);
  return Buffer.concat([content, createHash('sha1').update(content).digest()]);
}
const base = Buffer.from('hello world\n'), target = Buffer.from('hello forge\n');
// Copy the first six bytes, then insert six replacement bytes.
const delta = Buffer.concat([Buffer.from([base.length, target.length, 0x90, 6, 6]), Buffer.from('forge\n')]);
const baseOid = hash('blob', base), targetOid = hash('blob', target);
for (const mode of ['reference', 'offset', 'thin', 'forward']) {
  const r = new Repository(1, { name: mode });
  const original = entry(3, base), reference = entry(7, delta, Buffer.from(baseOid, 'hex'));
  let data: Buffer;
  if (mode === 'thin') { r.put('blob', base); data = pack([reference]); }
  else if (mode === 'offset') data = pack([original, entry(6, delta, Buffer.from([original.length]))]);
  else if (mode === 'forward') data = pack([reference, original]);
  else data = pack([original, reference]);
  unpack(r, data);
  assert.deepEqual(r.objects.get(targetOid)?.data, target, mode);
}
const r = new Repository(2, { name: 'validation' });
const badChecksum = pack([entry(3, base)]); badChecksum[badChecksum.length - 1] ^= 1;
assert.throws(() => unpack(r, badChecksum), /checksum/);
assert.equal(r.objects.size, 0, 'checksum errors must not install objects');
const brokenCommit = r.put('commit', `tree ${'a'.repeat(40)}\nauthor x\ncommitter x\n\nbroken\n`);
const command = Buffer.concat([pkt(`${zero} ${brokenCommit} refs/heads/main\0report-status\n`), Buffer.from('0000'), pack([])]);
assert.match(receive(r, command).toString(), /unpacker error/);
assert.equal(r.refs.size, 0, 'missing objects must not create refs');
const blob = r.put('blob', base), tree = r.buildTree(new Map([['hello.txt', blob]]));
const root = r.put('commit', `tree ${tree}\nauthor x\ncommitter x\n\nroot\n`);
const pushed = Buffer.concat([pkt(`${zero} ${root} refs/heads/main\0report-status side-band-64k\n`), Buffer.from('0000'), pack([])]);
assert.match(receive(r, pushed).toString(), /ok refs\/heads\/main/);
const firstClone = Buffer.concat([pkt('command=fetch\n'), Buffer.from('0001'), pkt(`want ${root}\n`), pkt('deepen 1\n'), pkt('done\n'), Buffer.from('0000')]);
assert.deepEqual(upload(r, firstClone, true), upload(r, firstClone, true));
assert.match(advertise(r, 'git-upload-pack', true).toString(), /version 2/);

const store = new Store(); store.bind('alice'); store.createRepo({ name: 'demo' });
const repository = store.repos.get('demo')!, issue = store.createIssue(repository, { title: 'test', body: 'body' });
const result = graphql(store, { query: 'query Named($o: String! = "alice") { x: repository(owner: $o, name: "demo") { ...Info issue(number: 1) { title hidden: body @skip(if: true) } } } fragment Info on Repository { name nameWithOwner }' });
assert.deepEqual(result, { data: { x: { name: 'demo', nameWithOwner: 'alice/demo', issue: { title: 'test' } } } });
assert.match(graphql(store, { query: '{ viewer { unexpected } }' }).errors[0].message, /unexpected/);

process.env.MAKEFUN_SHOP_TOKEN = 'protocol-test-token'; process.env.FORGE_LOGIN = 'alice';
const go = process.env.FORGE_TEST_GO ? await goServer() : undefined;
const server = go ? undefined : createApp();
if (server) await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${go?.port || (server!.address() as any).port}`;
async function call(path: string, method = 'GET', body?: any, token = 'protocol-test-token') {
  const reply = await fetch(origin + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: reply.status, body: await reply.json() };
}
try {
  assert.equal((await call('/api/v3/user', 'GET', undefined, 'wrong-token')).status, 401);
  await call('/api/v3/user/repos', 'POST', { name: 'cache' });
  const created = await call('/api/v3/repos/alice/cache/issues', 'POST', { title: 'old', body: 'v1' });
  const path = '/api/v3/repos/alice/cache/issues/1';
  assert.equal((await call(path)).body.title, 'old');
  await call(path, 'PATCH', { title: 'new', body: 'v2' });
  assert.equal((await call(path)).body.title, 'new');
  await call('/api/graphql', 'POST', { query: 'mutation($input: CloseIssueInput!) { closeIssue(input: $input) { issue { state } } }', variables: { input: { issueId: created.body.node_id } } });
  assert.equal((await call(path)).body.state, 'closed');
  await call(path + '/comments', 'POST', { body: 'a comment' });
  assert.equal((await call(path)).body.comments, 1);
  assert.equal((await call('/api/v3/repos/bob/cache')).status, 404);
  assert.equal((await call('/mcp', 'POST', null)).body.error.code, -32600);
  assert.equal((await call('/mcp', 'POST', { jsonrpc: '2.0', id: 'bad', method: 'tools/call', params: { name: 'create_repo', arguments: { name: 12 } } })).body.error.code, -32602);
  console.log('Protocol tests passed: delta packs, checksum/closure rejection, GraphQL parsing, auth, shared-store cache invalidation');
} finally { server?.close(); await go?.stop(); }
