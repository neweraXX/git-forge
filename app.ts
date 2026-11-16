import { createServer, type ServerResponse } from 'node:http';
import { Store, Failure } from './store.ts';
import { rest } from './rest.ts';
import { mcp } from './mcp.ts';
import { advertise, receive, upload } from './git.ts';
import { graphql } from './graphql.ts';

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
      const gitPath = path.match(/^\/([^/]+)\/([^/]+)\.git\/(.*)$/);
      if (gitPath) {
        const r = store.repo(decodeURIComponent(gitPath[1]), decodeURIComponent(gitPath[2])), route = gitPath[3];
        const v2 = req.headers['git-protocol'] === 'version=2';
        let data: Buffer, type: string;
        if (route === 'info/refs' && method === 'GET') {
          const service = url.searchParams.get('service');
          if (service !== 'git-upload-pack' && service !== 'git-receive-pack') throw new Failure(400, 'Unknown git service');
          data = advertise(r, service, v2); type = `application/x-${service}-advertisement`;
        } else if ((route === 'git-upload-pack' || route === 'git-receive-pack') && method === 'POST') {
          const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
          const body = Buffer.concat(chunks);
          data = route === 'git-upload-pack' ? upload(r, body, v2) : receive(r, body);
          type = `application/x-${route}-result`;
        } else throw new Failure(404, 'Not Found');
        res.writeHead(200, { 'content-type': type, 'content-length': data.length, 'cache-control': 'no-cache' });
        res.end(data); return;
      }
      if (method === 'GET' && (path === '/api/v3' || path.startsWith('/api/v3/'))) {
        const result = rest(store, method, url, {});
        return json(res, result.status, result.body, result.headers);
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      let input: any = {};
      if (raw.length) {
        try { input = JSON.parse(raw.toString()); }
        catch { return json(res, 400, path === '/mcp' ? { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } : { message: 'Invalid JSON' }); }
      }
      if (path === '/mcp') { const result = mcp(store, input); return json(res, result === undefined ? 202 : 200, result); }
      if (path === '/api/graphql' && method === 'POST') return json(res, 200, graphql(store, input));
      if (path === '/api/v3' || path.startsWith('/api/v3/')) { const result = rest(store, method, url, input); return json(res, result.status, result.body, result.headers); }
      return json(res, 404, { message: 'Not Found' });
    } catch (error) {
      if (!(error instanceof Failure)) process.stderr.write(`Request error: ${error instanceof Error ? error.stack : error}\n`);
      json(res, error instanceof Failure ? error.status : 500, { message: error instanceof Error ? error.message : 'Internal error' });
    }
  });
}
