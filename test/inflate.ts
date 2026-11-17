import assert from 'node:assert/strict';
import { deflateSync, inflateSync } from 'node:zlib';
import { inflateObject, consumed } from '../inflate.ts';

const examples: { plain: Buffer; compressed: Buffer }[] = [];
let state = 1234567;
for (const size of [0, 1, 63, 64, 255, 1024, 32768, 1048576]) {
  for (const random of [false, true]) {
    const plain = Buffer.allocUnsafe(size);
    for (let i = 0; i < size; i++) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; plain[i] = random ? state & 255 : 97 + i % 3; }
    for (const level of [0, 1, 6, 9]) {
      const compressed = deflateSync(plain, { level }), input = Buffer.concat([Buffer.from('prefix'), compressed, Buffer.alloc(30, 42)]);
      assert.deepEqual(inflateObject(input, 6, input.length, size), plain);
      assert.equal(consumed, compressed.length);
      examples.push({ plain, compressed });
    }
  }
}
const good = deflateSync(Buffer.from('good data'));
const invalid = Buffer.from(good); invalid[invalid.length - 1] ^= 1;
for (const bad of [invalid, good.subarray(0, good.length - 1), Buffer.from('garbage')]) {
  assert.throws(() => inflateObject(bad, 0, bad.length, 9));
  assert.equal(inflateObject(good, 0, good.length, 9).toString(), 'good data');
}
assert.throws(() => inflateObject(good, 0, good.length, 8));
assert.throws(() => inflateObject(good, 0, good.length, 10));
for (const fast of [false, true, true, false, false, true]) {
  const cpu = process.cpuUsage(), start = performance.now();
  for (let i = 0; i < 30000; i++) {
    const { plain, compressed } = examples[(i % 32) + 8]; // Small objects, all levels/entropies.
    const output = fast ? inflateObject(compressed, 0, compressed.length, plain.length) : inflateSync(compressed, { info: true, chunkSize: Math.max(64, Math.min(16384, plain.length)) });
    assert.ok(output);
  }
  const used = process.cpuUsage(cpu);
  console.log(JSON.stringify({ fast, cpu_ms: (used.user + used.system) / 1000, wall_ms: performance.now() - start }));
}
console.log('Reusable inflate passed: sizes, levels, entropy, trailing input, checksum, truncation, overflow, recovery');
