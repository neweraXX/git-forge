import { Store, Failure, requireValue, stamp, changedIssue } from './store.ts';

type Reply = { status: number; body?: any; headers?: Record<string, string> };
const ok = (body: any, status = 200): Reply => ({ status, body });
export function rest(store: Store, method: string, url: URL, input: any): Reply {
  const path = decodeURIComponent(url.pathname.replace(/^\/api\/v3\/?/, ''));
  const q = url.searchParams;
  const page = Math.max(1, Number(q.get('page')) || 1), perPage = Math.min(100, Math.max(1, Number(q.get('per_page')) || 30));
  const paginate = (list: any[]): Reply => {
    const result = ok(list.slice((page - 1) * perPage, page * perPage));
    if (list.length > page * perPage) {
      const next = new URL(url); next.searchParams.set('page', String(page + 1));
      result.headers = { link: `<${next}>; rel="next"` };
    }
    return result;
  };
  if (method === 'GET' && !path) return { ...ok({ current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}' }), headers: { 'x-oauth-scopes': 'repo, read:org' } };
  if (method === 'GET' && path === 'meta') return ok({ installed_version: 'forge-1.0' });
  if (method === 'GET' && path === 'user') return ok(store.user());
  if (path === 'user/repos') {
    if (method === 'POST') return ok(store.createRepo(input), 201);
    if (method === 'GET') return paginate([...store.repos.values()].map(r => store.repository(r)));
  }
  const match = path.match(/^repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
  if (!match) throw new Failure(404, 'Not Found');
  const [, owner, name, tail = ''] = match, r = store.repo(owner, name);
  if (!tail) {
    if (method === 'GET') return ok(store.repository(r));
    if (method === 'PATCH') { if (input.description !== undefined) r.description = input.description; if (input.default_branch) { r.default_branch = input.default_branch; r.refResponses.clear(); } return ok(store.repository(r)); }
    if (method === 'DELETE') { store.repos.delete(name); return { status: 204 }; }
  }
  const refBody = (ref: string) => ({ ref, node_id: store.global('Ref', r.id), object: { sha: requireValue(r.refs.get(ref)), type: 'commit' } });
  if (tail === 'git/refs' && method === 'POST') {
    requireValue(input.ref?.startsWith('refs/') && r.objects.has(input.sha), 422, 'Invalid ref or object');
    if (r.refs.has(input.ref)) throw new Failure(422, 'Reference already exists');
    r.setRef(input.ref, input.sha); return ok(refBody(input.ref), 201);
  }
  if (/^git\/refs?\//.test(tail) && method === 'GET') return ok(refBody(tail.replace(/^git\/refs?\//, 'refs/')));
  if (tail === 'branches' && method === 'GET') return paginate([...r.refs].filter(([ref]) => ref.startsWith('refs/heads/')).map(([ref, sha]) => ({ name: ref.slice(11), commit: { sha }, protected: false })));
  if (tail.startsWith('branches/') && method === 'GET') return ok({ name: tail.slice(9), commit: { sha: requireValue(r.resolve(tail.slice(9))) } });
  if ((tail === 'commits' || tail.startsWith('commits/')) && method === 'GET') {
    const tip = r.resolve(tail === 'commits' ? q.get('sha') || undefined : tail.slice(8));
    const list = [], seen = new Set<string>(), queue = tip ? [tip] : [];
    while (queue.length) {
      const sha = queue.shift()!; if (seen.has(sha)) continue; seen.add(sha);
      const c = r.commit(sha); if (!c) continue;
      list.push({ sha, commit: { message: c.message, tree: { sha: c.tree } }, parents: c.parents.map((sha: string) => ({ sha })) });
      queue.push(...c.parents);
    }
    return tail === 'commits' ? paginate(list) : ok(requireValue(list[0]));
  }
  if (tail === 'contents' || tail.startsWith('contents/')) {
    const filePath = tail.slice(9), branch = input.branch || q.get('ref') || r.default_branch;
    const tip = r.resolve(branch), files = r.files(tip), old = files.get(filePath);
    const content = (path: string, sha: string): any => ({ type: 'file', name: path.split('/').pop(), path, sha, size: r.objects.get(sha)!.data.length, encoding: 'base64', content: r.objects.get(sha)!.data.toString('base64') });
    if (method === 'GET') {
      if (old) return ok(content(filePath, old));
      const prefix = filePath ? filePath.replace(/\/$/, '') + '/' : '', listed = new Map<string, any>();
      for (const [path, sha] of files) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length), slash = rest.indexOf('/');
        if (slash < 0) listed.set(rest, content(path, sha));
        else { const child = rest.slice(0, slash); listed.set(child, { type: 'dir', name: child, path: prefix + child, sha: r.commit(tip)?.tree }); }
      }
      requireValue(listed.size); return ok([...listed.values()]);
    }
    if (method === 'PUT' || method === 'DELETE') {
      if (method === 'DELETE') requireValue(old);
      if (old && input.sha !== old || !old && input.sha) throw new Failure(409, 'File SHA does not match');
      if (method === 'DELETE') files.delete(filePath);
      else { requireValue(typeof input.content === 'string', 422, 'Content required'); files.set(filePath, r.put('blob', Buffer.from(input.content, 'base64'))); }
      const sha = r.writeCommit(files, tip ? [tip] : [], input.message || 'Update file');
      r.setRef(`refs/heads/${branch}`, sha);
      return ok({ content: method === 'DELETE' ? null : content(filePath, files.get(filePath)!), commit: { sha, message: input.message || 'Update file' } }, method === 'PUT' && !old ? 201 : 200);
    }
  }
  if (tail === 'labels') {
    if (method === 'POST') { requireValue(input.name, 422, 'Label name required'); const label = { id: store.nextId++, name: input.name, color: input.color || 'ededed', description: input.description || '' }; r.labels.set(label.name, label); return ok(label, 201); }
    if (method === 'GET') return paginate([...r.labels.values()]);
  }
  if (tail === 'issues') {
    if (method === 'POST') return ok(store.createIssue(r, input), 201);
    if (method === 'GET') {
      const state = q.get('state') || 'open';
      const list = [...r.issues.values()].filter(i => state === 'all' || i.state === state).sort((a, b) => q.get('direction') === 'asc' ? a.number - b.number : b.number - a.number);
      return paginate(list);
    }
  }
  const issueMatch = tail.match(/^issues\/(\d+)(?:\/(comments))?$/);
  if (issueMatch) {
    const issue = requireValue(r.issues.get(Number(issueMatch[1])));
    if (issueMatch[2]) {
      if (method === 'POST') return ok(store.comment(issue, input.body || ''), 201);
      if (method === 'GET') return paginate(store.nodes.get(issue.node_id).comments);
    } else {
      if (method === 'PATCH') { for (const key of ['state', 'title', 'body']) if (input[key] !== undefined) issue[key] = input[key]; issue.updated_at = stamp; changedIssue(issue); }
      if (method === 'GET' || method === 'PATCH') return ok(issue);
    }
  }
  if (tail === 'pulls') {
    if (method === 'POST') return ok(store.createPull(r, input), 201);
    if (method === 'GET') { const state = q.get('state') || 'open'; return paginate([...r.pulls.values()].filter(p => state === 'all' || p.state === state)); }
  }
  const pullMatch = tail.match(/^pulls\/(\d+)(?:\/(files|merge))?$/);
  if (pullMatch) {
    const pull = requireValue(r.pulls.get(Number(pullMatch[1])));
    if (pullMatch[2] === 'merge' && method === 'PUT') return ok(store.merge(r, pull));
    if (pullMatch[2] === 'files' && method === 'GET') return paginate(r.changes(pull));
    if (!pullMatch[2] && method === 'GET') return ok(pull);
  }
  throw new Failure(404, 'Not Found');
}
