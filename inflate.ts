import { Inflate, inflateSync, constants } from 'node:zlib';
import { Failure } from './store.ts';

// Pack entries are independent zlib streams. Keep one native context instead of
// constructing and asynchronously closing a Transform stream for every object.
// This optional fast path uses Node's synchronous binding; other layouts fall
// back to the public one-shot API. Calls are synchronous and cannot overlap.
let engine: any;
export let consumed = 0;
const ignoreError = () => {};
export function inflateObject(input: Buffer, start: number, end: number, size: number): Buffer {
  if (!engine || engine.destroyed) {
    engine = new Inflate(); engine.on('error', ignoreError);
  }
  if (!engine._handle?.writeSync || !engine._writeState) {
    const result = inflateSync(input.subarray(start, end), { info: true, chunkSize: Math.max(64, Math.min(16384, size)), maxOutputLength: 64 * 1024 * 1024 }) as any;
    consumed = result.engine.bytesWritten; return result.buffer;
  }
  engine.reset();
  // One spare byte distinguishes an exact-size stream from an overflowing one,
  // including zero-length objects. Z_FINISH also verifies the Adler checksum.
  const output = Buffer.allocUnsafe(size + 1);
  engine._handle.writeSync(constants.Z_FINISH, input, start, end - start, output, 0, output.length);
  if (engine.destroyed || engine.errored) throw new Failure(400, 'Invalid compressed object');
  const written = output.length - engine._writeState[0];
  consumed = end - start - engine._writeState[1];
  if (written !== size || consumed <= 0) throw new Failure(400, 'Packed object size mismatch');
  return output.subarray(0, size);
}
