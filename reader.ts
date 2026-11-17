import type { Socket } from 'node:net';

let binding: any, eof: number;
try { binding = (process as any).binding('stream_wrap'); eof = (process as any).binding('uv').UV_EOF; } catch {}
export function readDirect(socket: Socket, onData: (bytes: Buffer) => void): boolean {
  const handle = (socket as any)._handle;
  if (process.env.FORGE_READER === 'stream' || !binding?.streamBaseState || !handle || typeof eof !== 'number') return false;
  const state = binding.streamBaseState, read = binding.kReadBytesOrError, offset = binding.kArrayBufferOffset;
  if (typeof read !== 'number' || typeof offset !== 'number') return false;
  // The HTTP parser consumes each read synchronously. It owns buffering and
  // backpressure, so no intermediate Readable queue is needed for data chunks.
  handle.onread = (buffer: ArrayBuffer) => {
    const size = state[read];
    if (size > 0 && !socket.destroyed) {
      socket.setTimeout(60000);
      onData(Buffer.from(buffer, state[offset], size));
    } else if (size === eof) socket.push(null);
    else if (size < 0) socket.destroy();
  };
  return true;
}
