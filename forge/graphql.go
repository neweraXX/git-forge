package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

type Field struct {
	name, alias, condition string
	args                   M
	selections             []Field
	directives             []Directive
}
type Directive struct {
	name string
	args M
}
type Operation struct {
	name, kind string
	selections []Field
	defaults   M
}
type Parser struct {
	tokens    []string
	index     int
	fragments map[string]Field
}

var gqlToken = regexp.MustCompile(`^(?:\s+|#[^\n]*|,|\.\.\.|"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[_A-Za-z][_0-9A-Za-z]*|[!$():=@\[\]{|}])`)

func newParser(source string) *Parser {
	p := &Parser{fragments: map[string]Field{}}
	for pos := 0; pos < len(source); {
		s := gqlToken.FindString(source[pos:])
		if s == "" {
			panic(fmt.Errorf("Unexpected character at %d", pos))
		}
		pos += len(s)
		if strings.TrimSpace(s) == "" || s[0] == '#' || s == "," {
			continue
		}
		p.tokens = append(p.tokens, s)
	}
	return p
}
func (p *Parser) peek() string {
	if p.index >= len(p.tokens) {
		return ""
	}
	return p.tokens[p.index]
}
func (p *Parser) take(expected ...string) string {
	t := p.peek()
	p.index++
	e := ""
	if len(expected) > 0 {
		e = expected[0]
	}
	if t == "" || (e != "" && t != e) {
		if e == "" {
			e = "token"
		}
		if t == "" {
			t = "end of document"
		}
		panic(fmt.Errorf("Expected %s, received %s", e, t))
	}
	return t
}
func (p *Parser) value() any {
	t := p.take()
	switch t {
	case "$":
		return M{"variable": p.take()}
	case "[":
		a := []any{}
		for p.peek() != "]" {
			a = append(a, p.value())
		}
		p.take("]")
		return a
	case "{":
		m := M{}
		for p.peek() != "}" {
			k := p.take()
			p.take(":")
			m[k] = p.value()
		}
		p.take("}")
		return m
	case "null":
		return nil
	case "true":
		return true
	case "false":
		return false
	}
	if strings.HasPrefix(t, "\"") {
		var s string
		if e := json.Unmarshal([]byte(t), &s); e != nil {
			panic(e)
		}
		return s
	}
	if t[0] == '-' || (t[0] >= '0' && t[0] <= '9') {
		n, _ := strconv.ParseFloat(t, 64)
		return n
	}
	return t
}
func (p *Parser) arguments() M {
	args := M{}
	if p.peek() != "(" {
		return args
	}
	p.take("(")
	for p.peek() != ")" {
		k := p.take()
		p.take(":")
		args[k] = p.value()
	}
	p.take(")")
	return args
}
func (p *Parser) directives() []Directive {
	ds := []Directive{}
	for p.peek() == "@" {
		p.take()
		name := p.take()
		ds = append(ds, Directive{name, p.arguments()})
	}
	return ds
}
func (p *Parser) selections() []Field {
	p.take("{")
	fields := []Field{}
	for p.peek() != "}" {
		name := p.take()
		f := Field{name: name, alias: name, args: M{}}
		if name == "..." {
			f.name = p.take()
			if f.name == "on" {
				f.condition = p.take()
				f.name = "..."
			} else {
				f.alias = f.name
				f.name = "...spread"
				f.directives = p.directives()
				fields = append(fields, f)
				continue
			}
		} else {
			if p.peek() == ":" {
				p.take()
				f.name = p.take()
			}
			f.args = p.arguments()
		}
		f.directives = p.directives()
		if p.peek() == "{" {
			f.selections = p.selections()
		}
		fields = append(fields, f)
	}
	p.take("}")
	return fields
}
func (p *Parser) document() []Operation {
	ops := []Operation{}
	for p.peek() != "" {
		if p.peek() == "fragment" {
			p.take()
			name := p.take()
			p.take("on")
			condition := p.take()
			p.directives()
			p.fragments[name] = Field{name: "...", alias: name, condition: condition, args: M{}, selections: p.selections()}
			continue
		}
		op := Operation{kind: "query", defaults: M{}}
		if p.peek() != "{" {
			op.kind = p.take()
			if op.kind != "query" && op.kind != "mutation" {
				panic(fmt.Errorf("Unsupported operation type"))
			}
			if p.peek() != "(" && p.peek() != "{" {
				op.name = p.take()
			}
			if p.peek() == "(" {
				p.take()
				for p.peek() != ")" {
					p.take("$")
					v := p.take()
					p.take(":")
					for p.peek() != "" && p.peek() != "$" && p.peek() != ")" && p.peek() != "=" {
						p.take()
					}
					if p.peek() == "=" {
						p.take()
						op.defaults[v] = p.value()
					}
				}
				p.take(")")
			}
			p.directives()
		}
		op.selections = p.selections()
		ops = append(ops, op)
	}
	return ops
}
func evaluate(v any, vars M) any {
	switch x := v.(type) {
	case []any:
		a := make([]any, len(x))
		for i, v := range x {
			a[i] = evaluate(v, vars)
		}
		return a
	case map[string]any:
		if len(x) == 1 && truth(x["variable"]) {
			return vars[str(x["variable"])]
		}
		m := M{}
		for k, v := range x {
			m[k] = evaluate(v, vars)
		}
		return m
	}
	return v
}

type GNode struct {
	kind  string
	value any
	repo  *Repository
}

func node(kind string, v any, r ...*Repository) any {
	if v == nil {
		return nil
	}
	switch x := v.(type) {
	case M:
		if x == nil {
			return nil
		}
	case *Repository:
		if x == nil {
			return nil
		}
	}
	n := &GNode{kind: kind, value: v}
	if len(r) > 0 {
		n.repo = r[0]
	}
	return n
}

var schemaOrder = []string{"Query", "Mutation", "User", "Repository", "Issue", "PullRequest", "Ref", "Commit", "IssueComment", "PullRequestChangedFile", "Connection", "Edge", "PageInfo", "Payload", "__Type", "__Field", "__EnumValue", "__Schema"}
var schema = map[string][]string{
	"Query":       {"viewer", "repository", "node", "__type", "__schema"},
	"Mutation":    {"createIssue", "closeIssue", "reopenIssue", "createPullRequest", "mergePullRequest", "addComment"},
	"User":        {"id", "login", "name", "databaseId"},
	"Repository":  {"id", "databaseId", "name", "nameWithOwner", "owner", "description", "defaultBranchRef", "viewerPermission", "hasIssuesEnabled", "issue", "issues", "pullRequests", "pullRequest"},
	"Issue":       {"id", "number", "title", "state", "body", "createdAt", "updatedAt", "author", "comments"},
	"PullRequest": {"id", "number", "title", "state", "body", "headRefName", "baseRefName", "mergeable", "merged", "files", "mergeCommit", "author"},
	"Ref":         {"name", "target"}, "Commit": {"oid", "message"},
	"IssueComment": {"id", "body", "author", "createdAt"}, "PullRequestChangedFile": {"path", "additions", "deletions", "changeType"},
	"Connection": {"nodes", "edges", "pageInfo", "totalCount"}, "Edge": {"node", "cursor"}, "PageInfo": {"hasNextPage", "hasPreviousPage", "startCursor", "endCursor"},
	"Payload": {"issue", "pullRequest", "commentEdge", "clientMutationId"}, "__Type": {"name", "kind", "fields", "enumValues", "ofType"}, "__Field": {"name", "description", "isDeprecated"}, "__EnumValue": {"name"}, "__Schema": {"queryType", "mutationType", "types"},
}

func connection(values []any, args M) any {
	count := len(values)
	after := 0
	if truth(args["after"]) {
		b, _ := base64.StdEncoding.DecodeString(str(args["after"]))
		p := strings.Split(string(b), ":")
		if len(p) > 1 {
			after = num(p[1])
		}
	}
	start := after
	if start < 0 {
		start = 0
	}
	if start > count {
		start = count
	}
	size := 30
	if v, yes := args["first"]; yes && v != nil {
		size = num(v)
	}
	if size < 0 {
		size = 0
	}
	if size > 100 {
		size = 100
	}
	end := start + size
	if end > count {
		end = count
	}
	cursor := func(i int) string { return base64.StdEncoding.EncodeToString([]byte(fmt.Sprintf("cursor:%d", i))) }
	edges := []any{}
	for i, v := range values[start:end] {
		edges = append(edges, node("Edge", M{"node": v, "cursor": cursor(start + i + 1)}))
	}
	var first, last any
	if start < end {
		first = cursor(start + 1)
		last = cursor(end)
	}
	return node("Connection", M{"nodes": values[start:end], "totalCount": count, "edges": edges, "pageInfo": node("PageInfo", M{"hasNextPage": end < count, "hasPreviousPage": start > 0, "startCursor": first, "endCursor": last})})
}
func (s *Store) resolveField(parent *GNode, field string, args M) any {
	if field == "__typename" {
		return parent.kind
	}
	valid := false
	for _, f := range schema[parent.kind] {
		if f == field {
			valid = true
		}
	}
	if !valid {
		panic(fmt.Errorf("Cannot query field \"%s\" on type \"%s\".", field, parent.kind))
	}
	v, r := obj(parent.value), parent.repo
	switch parent.kind {
	case "Query":
		switch field {
		case "viewer":
			return node("User", s.user())
		case "repository":
			if args["owner"] == s.user()["login"] {
				return node("Repository", s.repos[str(args["name"])])
			}
			return nil
		case "node":
			if f := s.nodes[str(args["id"])]; f != nil {
				if item := f.itemValue(); item != nil {
					return node(f.kind, item, f.repo)
				}
				return node(f.kind, f.repo, f.repo)
			}
			return nil
		case "__type":
			if schema[str(args["name"])] != nil || args["name"] == "SearchType" {
				return node("__Type", M{"name": args["name"]})
			}
			return nil
		case "__schema":
			return node("__Schema", M{})
		}
	case "Mutation":
		in := obj(args["input"])
		record := func(id any) *NodeRecord {
			n := s.nodes[str(id)]
			need(n != nil, 422, "Unknown global ID")
			n.itemValue()
			return n
		}
		switch field {
		case "createIssue", "createPullRequest":
			repository := record(in["repositoryId"]).repo
			kind, key := "Issue", "issue"
			var item M
			if field == "createIssue" {
				item = s.createIssue(repository, in)
			} else {
				copyIn := M{}
				for k, v := range in {
					copyIn[k] = v
				}
				copyIn["head"] = in["headRefName"]
				copyIn["base"] = in["baseRefName"]
				item = s.createPull(repository, copyIn)
				kind, key = "PullRequest", "pullRequest"
			}
			var mutationID any
			if truth(in["clientMutationId"]) {
				mutationID = in["clientMutationId"]
			}
			return node("Payload", M{key: node(kind, item, repository), "clientMutationId": mutationID})
		case "closeIssue", "reopenIssue":
			f := record(in["issueId"])
			state := "open"
			if field == "closeIssue" {
				state = "closed"
			}
			f.item["state"] = state
			s.changedIssue(f.item)
			return node("Payload", M{"issue": node("Issue", f.item, f.repo)})
		case "mergePullRequest":
			f := record(in["pullRequestId"])
			s.merge(f.repo, f.item)
			return node("Payload", M{"pullRequest": node("PullRequest", f.item, f.repo)})
		case "addComment":
			f := record(in["subjectId"])
			c := s.comment(f.item, fallback(in["body"], ""))
			return node("Payload", M{"commentEdge": node("Edge", M{"node": node("IssueComment", c, f.repo)})})
		}
	case "Repository":
		repository := parent.value.(*Repository)
		switch field {
		case "id":
			return s.repository(repository)["node_id"]
		case "databaseId":
			return repository.id
		case "name":
			return repository.name
		case "description":
			return repository.description
		case "nameWithOwner":
			return str(s.user()["login"]) + "/" + repository.name
		case "owner":
			return node("User", s.user())
		case "viewerPermission":
			return "ADMIN"
		case "hasIssuesEnabled":
			return true
		case "defaultBranchRef":
			if sha := repository.resolve(""); sha != "" {
				return node("Ref", M{"name": repository.branch, "target": node("Commit", M{"oid": sha})})
			}
			return nil
		case "issue":
			return node("Issue", repository.issue(num(args["number"])), repository)
		case "pullRequest":
			return node("PullRequest", repository.pulls[num(args["number"])], repository)
		case "issues", "pullRequests":
			list := repository.issueList()
			kind := "Issue"
			if field == "pullRequests" {
				list = itemList(repository.pulls)
				kind = "PullRequest"
			}
			if truth(args["states"]) {
				filtered := []any{}
				for _, v := range list {
					item := obj(v)
					state := strings.ToUpper(str(item["state"]))
					if truth(item["merged"]) {
						state = "MERGED"
					}
					for _, allowed := range arr(args["states"]) {
						if allowed == state {
							filtered = append(filtered, item)
							break
						}
					}
				}
				list = filtered
			}
			if obj(args["orderBy"])["direction"] == "DESC" {
				sort.Slice(list, func(i, j int) bool { return num(obj(list[i])["number"]) > num(obj(list[j])["number"]) })
			}
			values := []any{}
			for _, item := range list {
				values = append(values, node(kind, item, repository))
			}
			return connection(values, args)
		}
		return nil
	case "Issue", "PullRequest", "IssueComment":
		switch field {
		case "id":
			return v["node_id"]
		case "state":
			if truth(v["merged"]) {
				return "MERGED"
			}
			return strings.ToUpper(str(v["state"]))
		case "createdAt":
			return v["created_at"]
		case "updatedAt":
			return v["updated_at"]
		case "author":
			return node("User", v["user"])
		case "headRefName":
			return obj(v["head"])["ref"]
		case "baseRefName":
			return obj(v["base"])["ref"]
		case "mergeable":
			if truth(v["mergeable"]) {
				return "MERGEABLE"
			}
			return "CONFLICTING"
		case "mergeCommit":
			if truth(v["merge_commit_sha"]) {
				return node("Commit", M{"oid": v["merge_commit_sha"]})
			}
			return nil
		case "files":
			values := []any{}
			for _, item := range r.changes(v) {
				f := obj(item)
				values = append(values, node("PullRequestChangedFile", M{"path": f["filename"], "additions": f["additions"], "deletions": f["deletions"], "changeType": strings.ToUpper(str(f["status"]))}))
			}
			return connection(values, args)
		case "comments":
			values := []any{}
			for _, c := range s.nodes[str(v["node_id"])].comments {
				values = append(values, node("IssueComment", c, r))
			}
			return connection(values, args)
		}
		return v[field]
	case "User":
		if field == "id" {
			return v["node_id"]
		}
		if field == "databaseId" {
			return v["id"]
		}
		if truth(v[field]) {
			return v[field]
		}
		return nil
	case "__Type":
		switch field {
		case "fields":
			values := []any{}
			for _, name := range schema[str(v["name"])] {
				values = append(values, node("__Field", M{"name": name, "description": name, "isDeprecated": false}))
			}
			return values
		case "enumValues":
			values := []any{}
			if v["name"] == "SearchType" {
				for _, name := range []string{"ISSUE", "REPOSITORY", "USER"} {
					values = append(values, node("__EnumValue", M{"name": name}))
				}
			}
			return values
		case "kind":
			if v["name"] == "SearchType" {
				return "ENUM"
			}
			return "OBJECT"
		}
		return v[field]
	case "__Schema":
		switch field {
		case "queryType":
			return node("__Type", M{"name": "Query"})
		case "mutationType":
			return node("__Type", M{"name": "Mutation"})
		case "types":
			values := []any{}
			for _, name := range schemaOrder {
				values = append(values, node("__Type", M{"name": name}))
			}
			return values
		}
	}
	return v[field]
}
func (s *Store) graphql(request any) (answer any) {
	if batch, yes := request.([]any); yes {
		values := []any{}
		for _, r := range batch {
			values = append(values, s.graphql(r))
		}
		return values
	}
	defer func() {
		if e := recover(); e != nil {
			answer = M{"data": nil, "errors": []any{M{"message": errorMessage(e)}}}
		}
	}()
	req := obj(request)
	query, yes := req["query"].(string)
	if !yes {
		panic(fmt.Errorf("Query must be a string"))
	}
	parser := newParser(query)
	ops := parser.document()
	var op *Operation
	if truth(req["operationName"]) {
		for i := range ops {
			if ops[i].name == str(req["operationName"]) {
				op = &ops[i]
				break
			}
		}
	} else if len(ops) == 1 {
		op = &ops[0]
	}
	if op == nil {
		panic(fmt.Errorf("Operation name is required or unknown"))
	}
	vars := op.defaults
	for k, v := range obj(req["variables"]) {
		vars[k] = v
	}
	var project func(any, []Field, map[string]bool) any
	project = func(parent any, selections []Field, active map[string]bool) any {
		if parent == nil {
			return nil
		}
		if list, yes := parent.([]any); yes {
			values := []any{}
			for _, item := range list {
				values = append(values, project(item, selections, active))
			}
			return values
		}
		if len(selections) == 0 {
			return parent
		}
		p := parent.(*GNode)
		out := M{}
		for _, f := range selections {
			skip := false
			for _, d := range f.directives {
				condition := truth(obj(evaluate(d.args, vars))["if"])
				if d.name == "skip" && condition || d.name == "include" && !condition {
					skip = true
				}
			}
			if skip {
				continue
			}
			if f.name == "...spread" {
				if active[f.alias] {
					panic(fmt.Errorf("Recursive fragment"))
				}
				fragment, yes := parser.fragments[f.alias]
				need(yes, 400, "Unknown fragment")
				next := map[string]bool{}
				for k, v := range active {
					next[k] = v
				}
				next[f.alias] = true
				if fragment.condition == "" || fragment.condition == p.kind || fragment.condition == "Node" {
					for k, v := range obj(project(parent, fragment.selections, next)) {
						out[k] = v
					}
				}
			} else if f.name == "..." {
				if f.condition == "" || f.condition == p.kind || f.condition == "Node" {
					for k, v := range obj(project(parent, f.selections, active)) {
						out[k] = v
					}
				}
			} else {
				value := s.resolveField(p, f.name, obj(evaluate(f.args, vars)))
				out[f.alias] = project(value, f.selections, active)
			}
		}
		return out
	}
	kind := "Query"
	if op.kind == "mutation" {
		kind = "Mutation"
	}
	return M{"data": project(node(kind, M{}), op.selections, map[string]bool{})}
}
