import { Store, Failure, requireValue, responseBytes } from './store.ts';
import { rest } from './rest.ts';
import { mcp } from './mcp.ts';
import { advertise, receive, upload } from './git.ts';
import { graphql } from './graphql.ts';

export type Request = { method: string; url: string; authorization?: string; gitProtocol?: string; host?: string; body: Buffer };
export type Reply = { status: number; data: Buffer | string; type: string; headers?: Record<string, string> };
type Route = { kind: string; owner?: string; repo?: string; number?: number; service?: string };
const jsonType = 'application/json; charset=utf-8';
function json(status: number, value?: any, headers?: Record<string, string>): Reply {
  return { status, data: responseBytes(value), type: jsonType, headers };
}
const health = json(200, { ok: true }), unauthorized = json(401, { message: 'Bad credentials' });
const notFound = json(404, { message: 'Not Found' });
const invalidJson = json(400, { message: 'Invalid JSON' });
const invalidRpc = json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });

export function createHandler(): (request: Request) => Reply {
  const store = new Store(), credential = process.env.MAKEFUN_SHOP_TOKEN ? `Bearer ${process.env.MAKEFUN_SHOP_TOKEN}` : '';
  const routes = new Map<string, Route>();
  function route(path: string): Route {
    const cached = routes.get(path); if (cached) return cached;
    let result: Route = { kind: 'other' };
    const git = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs\?service=(git-upload-pack|git-receive-pack)|git-upload-pack|git-receive-pack)$/.exec(path);
    if (git) result = { kind: git[4] ? 'advertise' : git[3], owner: decodeURIComponent(git[1]), repo: decodeURIComponent(git[2]), service: git[4] };
    else {
      const issue = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues(?:\/(\d+))?(?:\?.*)?$/.exec(path);
      if (issue) result = { kind: issue[3] ? 'issue' : 'issues', owner: decodeURIComponent(issue[1]), repo: decodeURIComponent(issue[2]), number: Number(issue[3]) };
    }
    if (routes.size >= 1024) routes.clear();
    routes.set(path, result); return result;
  }
  return request => {
    try {
      const { method, url, body } = request;
      if (url === '/healthz' && method === 'GET') return health;
      if (!credential || request.authorization !== credential) return unauthorized;
      const target = route(url), v2 = request.gitProtocol === 'version=2';
      if (target.kind === 'advertise' && method === 'GET') {
        const r = store.repo(target.owner!, target.repo!);
        return { status: 200, data: advertise(r, target.service!, v2), type: `application/x-${target.service}-advertisement` };
      }
      if ((target.kind === 'git-upload-pack' || target.kind === 'git-receive-pack') && method === 'POST') {
        const r = store.repo(target.owner!, target.repo!);
        return { status: 200, data: target.kind === 'git-upload-pack' ? upload(r, body, v2) : receive(r, body), type: `application/x-${target.kind}-result` };
      }
      if (target.kind === 'issue' && method === 'GET') {
        const r = store.repo(target.owner!, target.repo!);
        return json(200, requireValue(r.issues.get(target.number!)));
      }
      let input: any = {};
      if (body.length) {
        try { input = JSON.parse(body.toString()); }
        catch { return url === '/mcp' ? invalidRpc : invalidJson; }
      }
      if (target.kind === 'issues' && method === 'POST') return json(201, store.createIssue(store.repo(target.owner!, target.repo!), input));
      if (url === '/mcp') { const result = mcp(store, input); return json(result === undefined ? 202 : 200, result); }
      if (url === '/api/graphql' && method === 'POST') return json(200, graphql(store, input));
      const parsed = new URL(url, `http://${request.host || 'forge'}`);
      if (parsed.pathname === '/api/v3' || parsed.pathname.startsWith('/api/v3/')) {
        const result = rest(store, method, parsed, input); return json(result.status, result.body, result.headers);
      }
      // Unusual query-string ordering uses the full URL parser without burdening normal Git calls.
      const git = /^\/([^/]+)\/([^/]+)\.git\/info\/refs$/.exec(parsed.pathname);
      if (git && method === 'GET') {
        const service = parsed.searchParams.get('service');
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') throw new Failure(400, 'Unknown git service');
        return { status: 200, data: advertise(store.repo(decodeURIComponent(git[1]), decodeURIComponent(git[2])), service, v2), type: `application/x-${service}-advertisement` };
      }
      return notFound;
    } catch (error) {
      if (!(error instanceof Failure)) process.stderr.write(`Request error: ${String(error)}\n`);
      return json(error instanceof Failure ? error.status : 500, { message: error instanceof Error ? error.message : 'Internal error' });
    }
  };
}
