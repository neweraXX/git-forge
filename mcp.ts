import { Store, requireValue } from './store.ts';

const definitions = [
  ['create_repo', 'Create a repository owned by the authenticated user', ['name'], { name: 'string', description: 'string', private: 'boolean' }],
  ['get_repo', 'Read a repository', ['owner', 'repo'], { owner: 'string', repo: 'string' }],
  ['create_issue', 'Open an issue in a repository', ['owner', 'repo', 'title'], { owner: 'string', repo: 'string', title: 'string', body: 'string' }],
  ['list_issues', 'List repository issues by state', ['owner', 'repo'], { owner: 'string', repo: 'string', state: 'string' }],
  ['create_pull_request', 'Open a pull request between branches', ['owner', 'repo', 'title', 'head', 'base'], { owner: 'string', repo: 'string', title: 'string', body: 'string', head: 'string', base: 'string' }],
  ['merge_pull_request', 'Squash a pull request into its base branch', ['owner', 'repo', 'pull_number'], { owner: 'string', repo: 'string', pull_number: 'integer' }],
] as const;
const tools = definitions.map(([name, description, required, properties]) => ({ name, description, inputSchema: { type: 'object', required, properties: Object.fromEntries(Object.entries(properties).map(([key, type]) => [key, { type }])) } }));
const identity = { serverInfo: { name: 'forge', version: '1.0.0' }, capabilities: { tools: {} } };
export function mcp(store: Store, call: any): any {
  const reply = (result: any) => ({ jsonrpc: '2.0', id: call.id ?? null, result });
  const error = (code: number, message: string) => ({ jsonrpc: '2.0', id: call.id ?? null, error: { code, message } });
  if (!call || call.jsonrpc !== '2.0') return error(-32600, 'Invalid Request');
  if (call.method === 'server/discover') return reply({ ...identity, supportedVersions: ['2026-07-28', '2025-11-25'] });
  if (call.method === 'initialize') return reply({ ...identity, protocolVersion: '2025-11-25' });
  if (call.method?.startsWith('notifications/')) return undefined;
  if (call.method === 'ping') return reply({});
  if (call.method === 'tools/list') return reply({ tools });
  if (call.method !== 'tools/call') return error(-32601, 'Method not found');
  const tool = tools.find(t => t.name === call.params?.name);
  if (!tool) return error(-32602, 'Unknown tool');
  const args = call.params?.arguments || {};
  for (const key of tool.inputSchema.required) if (args[key] === undefined || args[key] === '') return error(-32602, `Missing argument: ${key}`);
  try {
    let value: any;
    if (tool.name === 'create_repo') value = store.createRepo(args);
    else {
      const r = store.repo(args.owner, args.repo);
      if (tool.name === 'get_repo') value = store.repository(r);
      if (tool.name === 'create_issue') value = store.createIssue(r, args);
      if (tool.name === 'list_issues') value = [...r.issues.values()].filter(i => !args.state || args.state === 'all' || i.state === args.state);
      if (tool.name === 'create_pull_request') value = store.createPull(r, args);
      if (tool.name === 'merge_pull_request') value = store.merge(r, requireValue(r.pulls.get(Number(args.pull_number))));
    }
    return reply({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: Array.isArray(value) ? { issues: value } : value, isError: false });
  } catch (err) { return reply({ isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] }); }
}
