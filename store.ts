import { createHash } from 'node:crypto';

export type Obj = { type: string; data: Buffer; packed?: Buffer; commit?: any; entries?: { mode: string; name: string; oid: string }[] };
export const stamp = process.env.MAKEFUN_TRIAL_NOW || '2026-01-01T00:00:00.000Z';
export const zero = '0'.repeat(40);
export function hash(type: string, data: Buffer): string {
  return createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
}
export class Failure extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export function requireValue(value: any, status = 404, message = 'Not Found'): any {
  if (!value) throw new Failure(status, message);
  return value;
}
export class Repository {
  id: number;
  name: string;
  description: string;
  private: boolean;
  default_branch: string;
  refs = new Map<string, string>();
  objects = new Map<string, Obj>();
  issues = new Map<number, any>();
  pulls = new Map<number, any>();
  labels = new Map<string, any>();
  nextNumber = 1;
  fetchCache = new Map<string, Buffer>();
  validated = new Set<string>();
  constructor(id: number, input: any) {
    this.id = id; this.name = input.name; this.description = input.description || '';
    this.private = !!input.private; this.default_branch = input.default_branch || 'main';
  }
  put(type: string, data: Buffer | string): string {
    const bytes = typeof data === 'string' ? Buffer.from(data) : data;
    const oid = hash(type, bytes);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data: bytes });
    return oid;
  }
  resolve(ref?: string): string | undefined {
    return this.refs.get(ref || `refs/heads/${this.default_branch}`) || this.refs.get(`refs/heads/${ref}`) || this.refs.get(`refs/tags/${ref}`) || (ref && this.objects.has(ref) ? ref : undefined);
  }
  commit(oid?: string): any {
    const obj = oid && this.objects.get(oid);
    if (!obj || obj.type !== 'commit') return null;
    if (obj.commit) return obj.commit;
    const text = obj.data.toString();
    obj.commit = { tree: text.match(/^tree ([a-f0-9]{40})/m)?.[1], parents: [...text.matchAll(/^parent ([a-f0-9]{40})/gm)].map(x => x[1]), message: text.slice(text.indexOf('\n\n') + 2).replace(/\n$/, '') };
    return obj.commit;
  }
  tree(oid: string): { mode: string; name: string; oid: string }[] {
    const object = this.objects.get(oid);
    if (!object) return [];
    if (object.entries) return object.entries;
    const data = object.data;
    const entries = [];
    for (let pos = 0; pos < data.length;) {
      const space = data.indexOf(32, pos), nul = data.indexOf(0, space);
      if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Failure(400, 'Invalid tree');
      entries.push({ mode: data.toString('utf8', pos, space), name: data.toString('utf8', space + 1, nul), oid: data.subarray(nul + 1, nul + 21).toString('hex') });
      pos = nul + 21;
    }
    object.entries = entries;
    return entries;
  }
  files(tip?: string): Map<string, string> {
    const files = new Map<string, string>();
    const walk = (tree: string, prefix: string) => {
      for (const entry of this.tree(tree)) {
        if (entry.mode === '40000' || entry.mode === '040000') walk(entry.oid, prefix + entry.name + '/');
        else files.set(prefix + entry.name, entry.oid);
      }
    };
    const c = this.commit(tip);
    if (c) walk(c.tree, '');
    return files;
  }
  buildTree(files: Map<string, string>): string {
    const build = (prefix: string): string => {
      const entries: { name: string; mode: string; oid: string }[] = [];
      const dirs = new Set<string>();
      for (const [path, oid] of files) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length), slash = rest.indexOf('/');
        if (slash < 0) entries.push({ name: rest, mode: '100644', oid });
        else dirs.add(rest.slice(0, slash));
      }
      for (const name of dirs) entries.push({ name, mode: '40000', oid: build(prefix + name + '/') });
      entries.sort((a, b) => Buffer.compare(Buffer.from(a.name + (a.mode === '40000' ? '/' : '')), Buffer.from(b.name + (b.mode === '40000' ? '/' : ''))));
      return this.put('tree', Buffer.concat(entries.map(e => Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.oid, 'hex')]))));
    };
    return build('');
  }
  writeCommit(files: Map<string, string>, parents: string[], message: string): string {
    const tree = this.buildTree(files);
    const epoch = Math.floor(Date.parse(stamp) / 1000) || 1700000000;
    return this.put('commit', `tree ${tree}\n${parents.map(p => `parent ${p}\n`).join('')}author Forge <forge@example.invalid> ${epoch} +0000\ncommitter Forge <forge@example.invalid> ${epoch} +0000\n\n${message}\n`);
  }
  ancestor(older: string, newer: string): boolean {
    const queue = [newer], seen = new Set<string>();
    while (queue.length) {
      const oid = queue.pop()!;
      if (oid === older) return true;
      if (seen.has(oid)) continue;
      seen.add(oid); queue.push(...(this.commit(oid)?.parents || []));
    }
    return false;
  }
  mergeBase(a: string, b: string): string | undefined {
    const ancestors = new Set<string>(), queue = [a];
    while (queue.length) { const oid = queue.pop()!; if (ancestors.has(oid)) continue; ancestors.add(oid); queue.push(...(this.commit(oid)?.parents || [])); }
    const other = [b], seen = new Set<string>();
    while (other.length) { const oid = other.shift()!; if (ancestors.has(oid)) return oid; if (seen.has(oid)) continue; seen.add(oid); other.push(...(this.commit(oid)?.parents || [])); }
    return undefined;
  }
  changes(pull: any): any[] {
    const head = this.files(pull.head.sha), base = this.files(this.mergeBase(pull.head.sha, pull.base.sha));
    const result = [];
    for (const path of new Set([...base.keys(), ...head.keys()])) {
      const before = base.get(path), after = head.get(path);
      if (before === after) continue;
      const lines = (oid?: string) => oid ? this.objects.get(oid)!.data.toString().split('\n').filter(Boolean).length : 0;
      const additions = lines(after), deletions = lines(before);
      result.push({ filename: path, status: !before ? 'added' : !after ? 'removed' : 'modified', additions, deletions, changes: additions + deletions, sha: after || before });
    }
    return result;
  }
}

export class Store {
  login = process.env.FORGE_LOGIN || '';
  repos = new Map<string, Repository>();
  nodes = new Map<string, any>();
  nextId = 1;
  user(): any { return { login: this.login || 'forge', id: 1, node_id: this.global('User', 1), type: 'User' }; }
  global(kind: string, id: number): string { return Buffer.from(`${kind}:${id}`).toString('base64'); }
  bind(owner: string): void { if (!this.login) this.login = owner; }
  repo(owner: string, name: string): Repository {
    this.bind(owner);
    return requireValue(owner === this.login && this.repos.get(name));
  }
  repository(r: Repository): any {
    const node_id = this.global('Repository', r.id);
    this.nodes.set(node_id, { kind: 'Repository', repo: r });
    return { id: r.id, node_id, name: r.name, full_name: `${this.user().login}/${r.name}`, owner: this.user(), private: r.private, description: r.description, default_branch: r.default_branch, has_issues: true, created_at: stamp, updated_at: stamp };
  }
  createRepo(input: any): any {
    requireValue(typeof input.name === 'string' && input.name.length, 422, 'Repository name required');
    if (this.repos.has(input.name)) throw new Failure(422, 'Repository already exists');
    const repo = new Repository(this.nextId++, input); this.repos.set(repo.name, repo);
    return this.repository(repo);
  }
  createIssue(r: Repository, input: any): any {
    requireValue(typeof input.title === 'string' && input.title.length, 422, 'Title required');
    const labels = (input.labels || []).map((name: any) => requireValue(r.labels.get(typeof name === 'string' ? name : name.name), 422, 'Unknown label'));
    const id = this.nextId++, number = r.nextNumber++;
    const issue = { id, node_id: this.global('Issue', id), number, title: input.title, body: input.body || '', state: 'open', labels, user: this.user(), created_at: stamp, updated_at: stamp, comments: 0 };
    r.issues.set(number, issue); this.nodes.set(issue.node_id, { kind: 'Issue', repo: r, item: issue, comments: [] });
    return issue;
  }
  createPull(r: Repository, input: any): any {
    const head = input.head?.split(':').pop(), base = input.base || r.default_branch;
    const headSha = requireValue(r.resolve(head), 422, 'Unknown head branch'), baseSha = requireValue(r.resolve(base), 422, 'Unknown base branch');
    const id = this.nextId++, number = r.nextNumber++;
    const pull = { id, node_id: this.global('PullRequest', id), number, title: input.title || '', body: input.body || '', state: 'open', head: { ref: head, sha: headSha }, base: { ref: base, sha: baseSha }, merged: false, mergeable: true, merged_at: null, merge_commit_sha: null, created_at: stamp, updated_at: stamp, user: this.user() };
    r.pulls.set(number, pull); this.nodes.set(pull.node_id, { kind: 'PullRequest', repo: r, item: pull });
    return pull;
  }
  merge(r: Repository, pull: any): any {
    requireValue(pull);
    if (pull.merged) throw new Failure(405, 'Already merged');
    const current = r.resolve(pull.base.ref)!;
    const common = r.files(r.mergeBase(pull.head.sha, pull.base.sha));
    const head = r.files(pull.head.sha), merged = r.files(current);
    for (const path of new Set([...common.keys(), ...head.keys()])) {
      const old = common.get(path), next = head.get(path), base = merged.get(path);
      if (old === next) continue;
      if (base !== old && base !== next) throw new Failure(405, 'Pull request has conflicts');
      if (next) merged.set(path, next); else merged.delete(path);
    }
    const sha = r.writeCommit(merged, [current], pull.title);
    r.refs.set(`refs/heads/${pull.base.ref}`, sha);
    Object.assign(pull, { state: 'closed', merged: true, merged_at: stamp, merge_commit_sha: sha });
    return { sha, merged: true, message: 'Pull request successfully merged' };
  }
  comment(issue: any, body: string): any {
    const node = requireValue(this.nodes.get(issue.node_id));
    const id = this.nextId++, comment = { id, node_id: this.global('IssueComment', id), body, user: this.user(), created_at: stamp, updated_at: stamp };
    node.comments.push(comment); issue.comments++;
    return comment;
  }
}
