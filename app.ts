import { createServer, type ServerResponse } from 'node:http';
import { Store, Failure } from './store.ts';
import { rest } from './rest.ts';
import { mcp } from './mcp.ts';

function json(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': 'forge', 'content-length': Buffer.byteLength(data), ...headers });
  res.end(data);
}
export function createApp() {
  const store = new Store(), token = process.env.MAKEFUN_SHOP_TOKEN;
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'forge'}`), path = url.pathname, method = req.method || 'GET';
      if (path === '/healthz' && method === 'GET') return json(res, 200, { ok: true });
      if (!token || req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { message: 'Bad credentials' });
      const gitPath = path.match(/^\/([^/]+)\/([^/]+)\.git\//);
      if (gitPath) { store.repo(decodeURIComponent(gitPath[1]), decodeURIComponent(gitPath[2])); return json(res, 404, { message: 'Git transport not implemented yet' }); }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      let input: any = {};
      if (raw.length) {
        try { input = JSON.parse(raw.toString()); }
        catch { return json(res, 400, path === '/mcp' ? { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } : { message: 'Invalid JSON' }); }
      }
      if (path === '/mcp') { const result = mcp(store, input); return json(res, result === undefined ? 202 : 200, result); }
      if (path === '/api/v3' || path.startsWith('/api/v3/')) { const result = rest(store, method, url, input); return json(res, result.status, result.body, result.headers); }
      return json(res, 404, { message: 'Not Found' });
    } catch (error) {
      if (!(error instanceof Failure)) process.stderr.write(`Request error: ${error instanceof Error ? error.stack : error}\n`);
      json(res, error instanceof Failure ? error.status : 500, { message: error instanceof Error ? error.message : 'Internal error' });
    }
  });
}
