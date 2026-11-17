import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHandler, type Reply } from './router.ts';
import { createTransport } from './transport.ts';

const empty = Buffer.alloc(0);
function send(res: ServerResponse, result: Reply): void {
  const headers = ['content-type', result.type, 'content-length', String(Buffer.byteLength(result.data)), 'x-github-request-id', 'forge'];
  if (result.headers) for (const key in result.headers) headers.push(key, result.headers[key]);
  res.writeHead(result.status, headers); res.end(result.data);
}
export function createApp() {
  if (process.env.FORGE_HTTP !== 'node') return createTransport();
  const handle = createHandler();
  function dispatch(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
    send(res, handle({ method: req.method || 'GET', url: req.url || '/', authorization: req.headers.authorization, gitProtocol: req.headers['git-protocol'] as string, host: req.headers.host, body }));
  }
  const server = createServer((req, res) => {
    if (req.method === 'GET' || req.method === 'HEAD') { req.resume(); dispatch(req, res, empty); return; }
    let first: Buffer | undefined, chunks: Buffer[] | undefined;
    req.on('data', (chunk: Buffer) => {
      if (!first) first = chunk;
      else if (chunks) chunks.push(chunk);
      else chunks = [first, chunk];
    });
    req.on('end', () => dispatch(req, res, chunks ? Buffer.concat(chunks) : first || empty));
    req.on('error', () => res.destroy());
  });
  server.keepAliveTimeout = 60000;
  server.on('connection', socket => socket.setNoDelay(true));
  return server;
}
