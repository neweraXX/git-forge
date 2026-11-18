import assert from 'node:assert/strict';
import { createApp } from '../app.ts';
import { goServer } from './go-serve.ts';
process.env.MAKEFUN_SHOP_TOKEN = 'parity-test'; process.env.FORGE_LOGIN = 'alice';
const node = createApp(); await new Promise<void>(resolve => node.listen(0, '127.0.0.1', resolve));
const go = await goServer();
const origins = [`http://127.0.0.1:${(node.address() as any).port}`, `http://127.0.0.1:${go.port}`];
// MCP text embeds JSON; compare its decoded value as well as structuredContent.
function normalize(value: any): any {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key === 'text' && typeof item === 'string') { try { return [key, normalize(JSON.parse(item))]; } catch {} }
    return [key, normalize(item)];
  }));
  return value;
}
let count = 0;
async function call(path: string, method = 'GET', input?: any, auth = 'parity-test') {
  const results = await Promise.all(origins.map(async origin => {
    const response = await fetch(origin + path, { method, headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: input === undefined ? undefined : JSON.stringify(input) });
    const text = await response.text();
    let body: any = text; try { body = JSON.parse(text); } catch {}
    const link = response.headers.get('link')?.replace(origin, '<origin>') || null;
    return { status: response.status, body, link, type: response.headers.get('content-type') };
  }));
  assert.deepEqual(normalize(results[1]), normalize(results[0]), `${method} ${path}`); count++;
  return results[0].body;
}
const repo = '/api/v3/repos/alice/parity';
try {
  await call('/healthz'); await call('/api/v3/user', 'GET', undefined, 'wrong');
  await call('/api/v3'); await call('/api/v3/meta'); await call('/api/v3/user');
  const repository = await call('/api/v3/user/repos', 'POST', { name: 'parity', description: '<🌿>', private: true });
  await call('/api/v3/user/repos', 'POST', { name: 'parity' });
  await call(repo, 'PATCH', { description: 'updated' });
  await call(repo + '/labels', 'POST', { name: 'green', color: '00ff00' });
  const issue = await call(repo + '/issues', 'POST', { title: 'first 🌿', body: '<&>', labels: ['green'] });
  await call(repo + '/issues', 'POST', {}); await call(repo + '/issues', 'POST', { title: 'bad-label', labels: ['absent'] });
  await call(repo + '/issues', 'POST', { title: 'second' }); await call(repo + '/issues?per_page=1&page=1');
  await call(repo + '/issues/1'); await call(repo + '/issues/1/comments', 'POST', { body: 'hello' });
  await call(repo + '/issues/1/comments'); await call(repo + '/issues/1', 'PATCH', { title: 'renamed', state: 'closed' });
  await call(repo + '/issues/1');
  await call('/api/graphql', 'POST', { query: 'query Q($owner:String! = "alice") { r:repository(owner:$owner,name:"parity") { ...Fields issues(first:1,states:[CLOSED]) { totalCount edges { cursor node { id title state comments(first:5) { nodes { body } } } } pageInfo { endCursor hasNextPage } } } } fragment Fields on Repository { id name nameWithOwner }' });
  await call('/api/graphql', 'POST', { query: 'mutation($i: ReopenIssueInput!) { reopenIssue(input:$i) { issue { state } } }', variables: { i: { issueId: issue.node_id } } });
  await call(repo + '/issues/1'); await call('/api/graphql', 'POST', { query: '{ viewer { impossible } }' });
  await call('/api/graphql', 'POST', [{ query: '{ viewer { login } }' }, { query: '{ __type(name:"SearchType") { kind enumValues { name } } }' }]);
  const content = await call(repo + '/contents/z.txt', 'PUT', { content: Buffer.from('one\n').toString('base64'), message: 'root' });
  await call(repo + '/git/refs', 'POST', { ref: 'refs/heads/feature', sha: content.commit.sha });
  await call(repo + '/contents/z.txt', 'DELETE', { sha: content.content.sha, branch: 'feature', message: 'remove' });
  await call(repo + '/contents/a.txt', 'PUT', { content: Buffer.from('two\n').toString('base64'), branch: 'feature', message: 'add' });
  await call(repo + '/branches'); await call(repo + '/contents'); await call(repo + '/commits');
  const pull = await call(repo + '/pulls', 'POST', { title: 'merge', head: 'feature', base: 'main' });
  await call(repo + `/pulls/${pull.number}/files`); await call(repo + `/pulls/${pull.number}/merge`, 'PUT', {});
  await call(repo + '/contents'); await call(repo + `/pulls/${pull.number}`);
  for (const [method, params] of [['initialize', {}], ['tools/list', {}], ['tools/call', { name: 'get_repo', arguments: { owner: 'alice', repo: 'parity' } }], ['tools/call', { name: 'list_issues', arguments: { owner: 'alice', repo: 'parity', state: 'all' } }], ['tools/call', { name: 'create_repo', arguments: { name: 12 } }], ['unknown', {}]] as const) await call('/mcp', 'POST', { jsonrpc: '2.0', id: 'same', method, params });
  await call('/api/graphql', 'POST', { query: 'query($id:ID!){node(id:$id){... on Repository{id name}}}', variables: { id: repository.node_id } });
  await call(repo, 'DELETE'); await call(repo + '/issues/1');
  await call('/api/v3/user/repos', 'POST', { name: 'parity' }); await call(repo + '/issues', 'POST', { title: 'recreated' }); await call(repo + '/issues/1');
  console.log(`Go/Node parity passed: ${count} requests, REST/Git objects, GraphQL, MCP, errors, order and cache invalidation`);
} finally { node.closeAllConnections?.(); node.close(); await go.stop(); }
