import assert from 'node:assert/strict';
import { hash as digest, createHash } from 'node:crypto';
const values = [Buffer.alloc(1024, 97), Buffer.from('100644 file.txt\0' + 'a'.repeat(20)), Buffer.from('tree ' + 'a'.repeat(40) + '\nparent ' + 'b'.repeat(40) + '\nauthor Test\ncommitter Test\n\nchange\n')];
function one(type: string, data: Buffer): string {
  const header = `${type} ${data.length}\0`, bytes = Buffer.allocUnsafe(Buffer.byteLength(header) + data.length);
  const offset = bytes.write(header); data.copy(bytes, offset); return digest('sha1', bytes);
}
function old(type: string, data: Buffer): string { return createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex'); }
for (const value of values) {
  assert.equal(one('blob', value), old('blob', value));
  assert.deepEqual(digest('sha1', value, 'buffer'), createHash('sha1').update(value).digest());
}
for (const fast of [false, true, true, false, false, true]) {
  const start = process.cpuUsage(), time = performance.now();
  for (let i = 0; i < 100000; i++) (fast ? one : old)(['blob', 'tree', 'commit'][i % 3], values[i % 3]);
  const used = process.cpuUsage(start);
  console.log(JSON.stringify({ fast, cpu_ms: (used.user + used.system) / 1000, wall_ms: performance.now() - time }));
}
