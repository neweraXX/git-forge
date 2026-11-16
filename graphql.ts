import { Store, Repository, requireValue, changedIssue } from './store.ts';

type Field = { name: string; alias: string; args: any; selections: Field[]; condition?: string; directives?: { name: string; args: any }[] };
type Operation = { name?: string; kind: string; selections: Field[]; defaults: any };
class Parser {
  tokens: string[];
  index = 0;
  fragments = new Map<string, Field>();
  constructor(source: string) {
    this.tokens = [];
    const re = /\s+|#[^\n]*|,|\.\.\.|"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[_A-Za-z][_0-9A-Za-z]*|[!$():=@\[\]{|}]/gy;
    let pos = 0;
    while (pos < source.length) {
      re.lastIndex = pos; const match = re.exec(source);
      if (!match) throw new Error(`Unexpected character at ${pos}`);
      pos = re.lastIndex;
      if (!/^(?:\s|#|,)/.test(match[0])) this.tokens.push(match[0]);
    }
  }
  peek(): string { return this.tokens[this.index]; }
  take(expected?: string): string {
    const token = this.tokens[this.index++];
    if (token === undefined || expected && token !== expected) throw new Error(`Expected ${expected || 'token'}, received ${token || 'end of document'}`);
    return token;
  }
  value(): any {
    const t = this.take();
    if (t === '$') return { variable: this.take() };
    if (t === '[') { const values = []; while (this.peek() !== ']') values.push(this.value()); this.take(']'); return values; }
    if (t === '{') { const values: any = {}; while (this.peek() !== '}') { const key = this.take(); this.take(':'); values[key] = this.value(); } this.take('}'); return values; }
    if (t.startsWith('"')) return JSON.parse(t);
    if (t === 'null') return null;
    if (t === 'true' || t === 'false') return t === 'true';
    return /^-?\d/.test(t) ? Number(t) : t;
  }
  arguments(): any {
    const args: any = {};
    if (this.peek() !== '(') return args;
    this.take('(');
    while (this.peek() !== ')') { const key = this.take(); this.take(':'); args[key] = this.value(); }
    this.take(')'); return args;
  }
  directives(): any[] {
    const result = [];
    while (this.peek() === '@') { this.take(); result.push({ name: this.take(), args: this.arguments() }); }
    return result;
  }
  selections(): Field[] {
    this.take('{'); const fields: Field[] = [];
    while (this.peek() !== '}') {
      let name = this.take(), alias = name, args: any = {}, condition: string | undefined;
      if (name === '...') {
        name = this.take();
        if (name === 'on') { condition = this.take(); name = '...'; }
        else { fields.push({ name: '...spread', alias: name, args: {}, selections: [], directives: this.directives() }); continue; }
      } else {
        if (this.peek() === ':') { this.take(); alias = name; name = this.take(); }
        args = this.arguments();
      }
      const directives = this.directives();
      const selections = this.peek() === '{' ? this.selections() : [];
      fields.push({ name, alias, args, condition, selections, directives });
    }
    this.take('}'); return fields;
  }
  document(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek()) {
      if (this.peek() === 'fragment') {
        this.take(); const name = this.take(); this.take('on'); const condition = this.take(); this.directives();
        this.fragments.set(name, { name: '...', alias: name, condition, args: {}, selections: this.selections() }); continue;
      }
      let kind = 'query', name: string | undefined; const defaults: any = {};
      if (this.peek() !== '{') {
        kind = this.take(); if (kind !== 'query' && kind !== 'mutation') throw new Error('Unsupported operation type');
        if (this.peek() !== '(' && this.peek() !== '{') name = this.take();
        if (this.peek() === '(') {
          this.take();
          while (this.peek() !== ')') {
            this.take('$'); const variable = this.take(); this.take(':');
            while (this.peek() && !['$', ')', '='].includes(this.peek())) this.take();
            if (this.peek() === '=') { this.take(); defaults[variable] = this.value(); }
          }
          this.take(')');
        }
        this.directives();
      }
      operations.push({ name, kind, defaults, selections: this.selections() });
    }
    return operations;
  }
}
function evaluate(value: any, variables: any): any {
  if (Array.isArray(value)) return value.map(x => evaluate(x, variables));
  if (value && typeof value === 'object') {
    if (Object.keys(value).length === 1 && value.variable) return variables[value.variable];
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, evaluate(v, variables)]));
  }
  return value;
}
type Node = { kind: string; value: any; repo?: Repository };
const node = (kind: string, value: any, repo?: Repository): Node | null => value == null ? null : ({ kind, value, repo });
const schema: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'reopenIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'databaseId'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'comments'],
  PullRequest: ['id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'mergeCommit', 'author'],
  Ref: ['name', 'target'], Commit: ['oid', 'message'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  Connection: ['nodes', 'edges', 'pageInfo', 'totalCount'], Edge: ['node', 'cursor'], PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Payload: ['issue', 'pullRequest', 'commentEdge', 'clientMutationId'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'ofType'], __Field: ['name', 'description', 'isDeprecated'], __EnumValue: ['name'], __Schema: ['queryType', 'mutationType', 'types'],
};
function connection(values: any[], args: any): Node {
  const count = values.length, after = args.after ? Number(Buffer.from(args.after, 'base64').toString().split(':')[1]) : 0;
  const start = Math.min(count, Math.max(0, after || 0));
  const size = Math.max(0, Math.min(100, args.first ?? 30)), end = Math.min(count, start + size);
  const cursor = (index: number) => Buffer.from(`cursor:${index}`).toString('base64');
  return node('Connection', {
    nodes: values.slice(start, end), totalCount: count,
    edges: values.slice(start, end).map((value, i) => node('Edge', { node: value, cursor: cursor(start + i + 1) })),
    pageInfo: node('PageInfo', { hasNextPage: end < count, hasPreviousPage: start > 0, startCursor: start < end ? cursor(start + 1) : null, endCursor: start < end ? cursor(end) : null }),
  })!;
}
function resolver(store: Store, parent: Node, field: string, args: any): any {
  if (field === '__typename') return parent.kind;
  if (!schema[parent.kind]?.includes(field)) throw new Error(`Cannot query field "${field}" on type "${parent.kind}".`);
  const { value: v, repo: r } = parent;
  if (parent.kind === 'Query') {
    if (field === 'viewer') return node('User', store.user());
    if (field === 'repository') return node('Repository', args.owner === store.user().login ? store.repos.get(args.name) : null);
    if (field === 'node') { const found = store.nodes.get(args.id); return found ? node(found.kind, found.item || found.repo, found.repo) : null; }
    if (field === '__type') return schema[args.name] || args.name === 'SearchType' ? node('__Type', { name: args.name }) : null;
    if (field === '__schema') return node('__Schema', {});
  }
  if (parent.kind === 'Mutation') {
    const input = args.input || {}, record = (id: string) => requireValue(store.nodes.get(id), 422, 'Unknown global ID');
    if (field === 'createIssue' || field === 'createPullRequest') {
      const repository = record(input.repositoryId).repo;
      const item = field === 'createIssue' ? store.createIssue(repository, input) : store.createPull(repository, { ...input, head: input.headRefName, base: input.baseRefName });
      return node('Payload', { [field === 'createIssue' ? 'issue' : 'pullRequest']: node(field === 'createIssue' ? 'Issue' : 'PullRequest', item, repository), clientMutationId: input.clientMutationId || null });
    }
    if (field === 'closeIssue' || field === 'reopenIssue') {
      const found = record(input.issueId); found.item.state = field === 'closeIssue' ? 'closed' : 'open';
      changedIssue(found.item);
      return node('Payload', { issue: node('Issue', found.item, found.repo) });
    }
    if (field === 'mergePullRequest') {
      const found = record(input.pullRequestId); store.merge(found.repo, found.item);
      return node('Payload', { pullRequest: node('PullRequest', found.item, found.repo) });
    }
    if (field === 'addComment') {
      const found = record(input.subjectId), comment = store.comment(found.item, input.body || '');
      return node('Payload', { commentEdge: node('Edge', { node: node('IssueComment', comment, found.repo) }) });
    }
  }
  if (parent.kind === 'Repository') {
    const repository: Repository = v;
    if (field === 'id') return store.repository(repository).node_id;
    if (field === 'databaseId') return repository.id;
    if (field === 'nameWithOwner') return `${store.user().login}/${repository.name}`;
    if (field === 'owner') return node('User', store.user());
    if (field === 'viewerPermission') return 'ADMIN';
    if (field === 'hasIssuesEnabled') return true;
    if (field === 'defaultBranchRef') return repository.resolve() ? node('Ref', { name: repository.default_branch, target: node('Commit', { oid: repository.resolve() }) }) : null;
    if (field === 'issue') return node('Issue', repository.issues.get(args.number), repository);
    if (field === 'pullRequest') return node('PullRequest', repository.pulls.get(args.number), repository);
    if (field === 'issues' || field === 'pullRequests') {
      let list = [...(field === 'issues' ? repository.issues : repository.pulls).values()];
      if (args.states) list = list.filter(item => args.states.includes(item.merged ? 'MERGED' : item.state.toUpperCase()));
      list.sort((a, b) => args.orderBy?.direction === 'DESC' ? b.number - a.number : a.number - b.number);
      return connection(list.map(item => node(field === 'issues' ? 'Issue' : 'PullRequest', item, repository)), args);
    }
    return (repository as any)[field] ?? null;
  }
  if (parent.kind === 'Issue' || parent.kind === 'PullRequest' || parent.kind === 'IssueComment') {
    if (field === 'id') return v.node_id;
    if (field === 'state') return v.merged ? 'MERGED' : v.state.toUpperCase();
    if (field === 'createdAt') return v.created_at;
    if (field === 'updatedAt') return v.updated_at;
    if (field === 'author') return node('User', v.user);
    if (field === 'headRefName') return v.head.ref;
    if (field === 'baseRefName') return v.base.ref;
    if (field === 'mergeable') return v.mergeable ? 'MERGEABLE' : 'CONFLICTING';
    if (field === 'mergeCommit') return v.merge_commit_sha ? node('Commit', { oid: v.merge_commit_sha }) : null;
    if (field === 'files') return connection(r!.changes(v).map(f => node('PullRequestChangedFile', { path: f.filename, additions: f.additions, deletions: f.deletions, changeType: f.status.toUpperCase() })), args);
    if (field === 'comments') return connection(store.nodes.get(v.node_id).comments.map((c: any) => node('IssueComment', c, r)), args);
    return v[field] ?? null;
  }
  if (parent.kind === 'User') return field === 'id' ? v.node_id : field === 'databaseId' ? v.id : v[field] || null;
  if (parent.kind === '__Type') {
    if (field === 'fields') return (schema[v.name] || []).map(name => node('__Field', { name, description: name, isDeprecated: false }));
    if (field === 'enumValues') return (v.name === 'SearchType' ? ['ISSUE', 'REPOSITORY', 'USER'] : []).map(name => node('__EnumValue', { name }));
    if (field === 'kind') return v.name === 'SearchType' ? 'ENUM' : 'OBJECT';
    return v[field] ?? null;
  }
  if (parent.kind === '__Schema') {
    if (field === 'queryType') return node('__Type', { name: 'Query' });
    if (field === 'mutationType') return node('__Type', { name: 'Mutation' });
    if (field === 'types') return Object.keys(schema).map(name => node('__Type', { name }));
  }
  return v[field] ?? null;
}
export function graphql(store: Store, request: any): any {
  if (Array.isArray(request)) return request.map(item => graphql(store, item));
  try {
    if (typeof request?.query !== 'string') throw new Error('Query must be a string');
    const parser = new Parser(request.query), operations = parser.document();
    const operation = request.operationName ? operations.find(op => op.name === request.operationName) : operations.length === 1 ? operations[0] : undefined;
    if (!operation) throw new Error('Operation name is required or unknown');
    const variables = { ...operation.defaults, ...(request.variables || {}) };
    const project = (parent: any, selections: Field[], active = new Set<string>()): any => {
      if (parent == null) return null;
      if (Array.isArray(parent)) return parent.map(item => project(item, selections, active));
      if (!selections.length) return parent;
      const out: any = {};
      for (const field of selections) {
        if (field.directives?.some(d => d.name === 'skip' && evaluate(d.args, variables).if || d.name === 'include' && !evaluate(d.args, variables).if)) continue;
        if (field.name === '...spread') {
          if (active.has(field.alias)) throw new Error('Recursive fragment');
          const fragment = requireValue(parser.fragments.get(field.alias), 400, 'Unknown fragment');
          const next = new Set(active); next.add(field.alias);
          if (!fragment.condition || fragment.condition === parent.kind || fragment.condition === 'Node') Object.assign(out, project(parent, fragment.selections, next));
        } else if (field.name === '...') {
          if (!field.condition || field.condition === parent.kind || field.condition === 'Node') Object.assign(out, project(parent, field.selections, active));
        } else {
          const value = resolver(store, parent, field.name, evaluate(field.args, variables));
          out[field.alias] = project(value, field.selections, active);
        }
      }
      return out;
    };
    return { data: project(node(operation.kind === 'mutation' ? 'Mutation' : 'Query', {}), operation.selections) };
  } catch (error) { return { data: null, errors: [{ message: error instanceof Error ? error.message : 'GraphQL execution error' }] }; }
}
