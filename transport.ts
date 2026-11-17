import { createServer, type Socket } from 'node:net';
import { createHandler, type Request, type Reply } from './router.ts';

const empty = Buffer.alloc(0);
const reasons: Record<number, string> = { 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 400: 'Bad Request', 401: 'Unauthorized', 404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 413: 'Content Too Large', 422: 'Unprocessable Entity', 500: 'Internal Server Error' };
const maxBody = 128 * 1024 * 1024;
// Immutable body buffers identify cached issues, advertisements and negotiated packs. A mutation
// replaces its body buffer, so this cache cannot retain stale store data or keep deleted objects alive.
const encoded = new WeakMap<Buffer, { status: number; type: string; bytes: Buffer }>();
function encode(reply: Reply, close: boolean): Buffer {
  const { data, status, type } = reply;
  const cacheable = !close && !reply.headers && Buffer.isBuffer(data);
  if (cacheable) { const prior = encoded.get(data); if (prior?.status === status && prior.type === type) return prior.bytes; }
  const body = typeof data === 'string' ? Buffer.from(data) : data;
  let headers = `HTTP/1.1 ${status} ${reasons[status] || 'Response'}\r\nContent-Type: ${type}\r\nContent-Length: ${body.length}\r\nX-GitHub-Request-Id: forge\r\nConnection: ${close ? 'close' : 'keep-alive'}\r\n`;
  if (reply.headers) for (const name in reply.headers) headers += `${name}: ${reply.headers[name]}\r\n`;
  const bytes = Buffer.concat([Buffer.from(headers + '\r\n'), body]);
  if (cacheable) encoded.set(data, { status, type, bytes });
  return bytes;
}
export function createTransport() {
  const handle = createHandler();
  return createServer(socket => {
    socket.setNoDelay(true); socket.setTimeout(60000, () => socket.destroy());
    let pending: Buffer = empty, hasHeaders = false;
    const request: Request = { method: '', url: '', body: empty, authorization: undefined, gitProtocol: undefined, host: undefined };
    let lastGet: Buffer | undefined;
    let remaining = 0, close = false, chunked = false, waiting = false, ended = false;
    let chunks: Buffer[] = [], total = 0, chunkRemaining = -1, trailers = false;
    function reject(status = 400): void {
      if (ended) return;
      ended = true;
      socket.end(encode({ status, type: 'application/json', data: JSON.stringify({ message: status === 413 ? 'Request too large' : 'Bad Request' }) }, true));
    }
    function respond(body: Buffer): boolean {
      request.body = body;
      const result = handle(request); hasHeaders = false;
      const bytes = encode(result, close);
      if (close) { ended = true; socket.end(bytes); return false; }
      if (!socket.write(bytes)) { waiting = true; socket.pause(); return false; }
      return true;
    }
    function parseHeaders(bytes: Buffer): boolean {
      lastGet = undefined;
      const head = bytes.toString('latin1'), first = head.indexOf('\r\n');
      const line = head.slice(0, first), space = line.indexOf(' '), last = line.lastIndexOf(' ');
      if (space < 1 || last <= space || line.slice(last + 1) !== 'HTTP/1.1' && line.slice(last + 1) !== 'HTTP/1.0') { reject(); return false; }
      request.method = line.slice(0, space); request.url = line.slice(space + 1, last);
      request.authorization = request.gitProtocol = request.host = undefined;
      close = line.endsWith('HTTP/1.0'); remaining = 0; chunked = false;
      let contentLength = false, transfer = false;
      for (let pos = first + 2; pos < head.length;) {
        const end = head.indexOf('\r\n', pos), colon = head.indexOf(':', pos);
        if (end === pos) break;
        if (end < 0 || colon <= pos || colon >= end) { reject(); return false; }
        // Skip values of headers the forge never uses. Still validate every line and
        // process framing fields on every request, including duplicate length checks.
        const length = colon - pos;
        if (length !== 4 && length !== 6 && length !== 10 && length !== 12 && length !== 13 && length !== 14 && length !== 17) { pos = end + 2; continue; }
        const name = head.slice(pos, colon).toLowerCase();
        if (name !== 'authorization' && name !== 'git-protocol' && name !== 'host' && name !== 'content-length' && name !== 'connection' && name !== 'transfer-encoding' && name !== 'expect') { pos = end + 2; continue; }
        const value = head.slice(colon + 1, end).trim();
        if (name === 'authorization') request.authorization = value;
        else if (name === 'git-protocol') request.gitProtocol = value;
        else if (name === 'host') request.host = value;
        else if (name === 'content-length') {
          if (contentLength || !/^\d+$/.test(value)) { reject(); return false; }
          contentLength = true; remaining = Number(value);
          if (!Number.isSafeInteger(remaining) || remaining > maxBody) { reject(413); return false; }
        } else if (name === 'connection') {
          const lower = value.toLowerCase();
          if (lower === 'close') close = true; else if (lower === 'keep-alive') close = false;
        } else if (name === 'transfer-encoding') {
          if (transfer || value.toLowerCase() !== 'chunked') { reject(); return false; }
          transfer = true; chunked = true;
        } else if (name === 'expect' && value.toLowerCase() === '100-continue') socket.write('HTTP/1.1 100 Continue\r\n\r\n');
        pos = end + 2;
      }
      if (contentLength && transfer) { reject(); return false; }
      if (chunked) { chunks = []; total = 0; chunkRemaining = -1; trailers = false; }
      hasHeaders = true;
      return true;
    }
    function consume(): void {
      try {
        while (!waiting && !ended) {
          if (!hasHeaders) {
            const end = pending.indexOf('\r\n\r\n');
            if (end < 0) { if (pending.length > 65536) reject(); return; }
            if (!parseHeaders(pending.subarray(0, end + 4))) return;
            pending = pending.subarray(end + 4);
          }
          if (!chunked) {
            if (pending.length < remaining) return;
            const body = remaining ? pending.subarray(0, remaining) : empty;
            pending = pending.length === remaining ? empty : pending.subarray(remaining);
            if (!respond(body)) return;
          } else {
            let complete = false;
            while (!complete) {
              if (trailers) {
                if (pending.length >= 2 && pending[0] === 13 && pending[1] === 10) { pending = pending.subarray(2); complete = true; }
                else { const end = pending.indexOf('\r\n\r\n'); if (end < 0) return; pending = pending.subarray(end + 4); complete = true; }
                continue;
              }
              if (chunkRemaining < 0) {
                const end = pending.indexOf('\r\n'); if (end < 0) return;
                const size = pending.toString('ascii', 0, end).split(';', 1)[0];
                if (!/^[0-9a-fA-F]+$/.test(size)) { reject(); return; }
                chunkRemaining = parseInt(size, 16); pending = pending.subarray(end + 2);
                if (!Number.isSafeInteger(chunkRemaining) || total + chunkRemaining > maxBody) { reject(413); return; }
                if (!chunkRemaining) { trailers = true; continue; }
              }
              if (pending.length < chunkRemaining + 2) return;
              if (pending[chunkRemaining] !== 13 || pending[chunkRemaining + 1] !== 10) { reject(); return; }
              chunks.push(pending.subarray(0, chunkRemaining)); total += chunkRemaining;
              pending = pending.subarray(chunkRemaining + 2); chunkRemaining = -1;
            }
            if (!respond(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total))) return;
          }
          if (!pending.length) return;
        }
      } catch { reject(); }
    }
    socket.on('data', (data: Buffer) => {
      // A byte-identical, bodyless GET on this socket has identical framing and
      // credentials. Reuse its parsed fields, but route again so mutations and
      // repository deletion/recreation remain visible immediately.
      if (lastGet && !pending.length && !hasHeaders && !waiting && !ended && data.equals(lastGet)) { respond(empty); return; }
      const whole = !pending.length && !hasHeaders;
      pending = pending.length ? Buffer.concat([pending, data]) : data; consume();
      if (whole && !pending.length && !hasHeaders && !ended && !chunked && !remaining && request.method === 'GET' && data.indexOf('\r\n\r\n') === data.length - 4) lastGet = data;
    });
    socket.on('drain', () => { waiting = false; socket.resume(); consume(); });
    socket.on('error', () => socket.destroy());
    socket.on('end', () => { if (!ended) { ended = true; socket.end(); } });
  });
}
