import type { Socket } from 'node:net';

let binding: any;
try { binding = (process as any).binding('stream_wrap'); } catch {}

// Small, pre-encoded responses usually complete synchronously in libuv. Avoid
// passing each one through Writable's chunk queue and allocating another write
// wrapper. A queued native write retains its bytes and pauses request processing
// until completion. Unsupported runtimes use Socket.write normally.
export function createWriter(socket: Socket): (bytes: Buffer) => boolean {
  const handle = (socket as any)._handle;
  if (process.env.FORGE_WRITER === 'stream' || !binding?.WriteWrap || !binding.streamBaseState || !handle?.writeBuffer) return bytes => socket.write(bytes);
  function completion(this: any, status: number) {
    this.buffer = null;
    // Native ownership is released only after this callback returns. A drain
    // handler may write immediately, so it must receive a fresh wrapper.
    request = allocate();
    if (status < 0) socket.destroy();
    else socket.emit('drain');
  }
  function allocate(): any {
    const next = new binding.WriteWrap(); next.handle = handle;
    next.buffer = null; next.oncomplete = completion; return next;
  }
  let request = allocate();
  return bytes => {
    if (socket.destroyed) return false;
    const status = handle.writeBuffer(request, bytes);
    if (status !== 0) { socket.destroy(); return false; }
    if (binding.streamBaseState[binding.kLastWriteWasAsync]) { request.buffer = bytes; return false; }
    return true;
  };
}
