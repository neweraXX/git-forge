package main

import (
	"bytes"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

type M = map[string]any

var stamp = env("MAKEFUN_TRIAL_NOW", "2026-01-01T00:00:00.000Z")

const zero = "0000000000000000000000000000000000000000"

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

type failure struct {
	status  int
	message string
}

func (f failure) Error() string { return f.message }
func need(ok bool, status int, message string) {
	if !ok {
		panic(failure{status, message})
	}
}
func found(ok bool) { need(ok, 404, "Not Found") }
func str(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprint(v)
}
func num(v any) int {
	switch n := v.(type) {
	case int:
		return n
	case float64:
		return int(n)
	case string:
		i, _ := strconv.Atoi(n)
		return i
	}
	return 0
}
func truth(v any) bool {
	if v == nil {
		return false
	}
	switch x := v.(type) {
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0
	case int:
		return x != 0
	}
	return true
}
func fallback(v any, d string) string {
	if truth(v) {
		return str(v)
	}
	return d
}
func obj(v any) M {
	if m, ok := v.(map[string]any); ok && m != nil {
		return m
	}
	return M{}
}
func arr(v any) []any {
	if a, ok := v.([]any); ok {
		return a
	}
	return nil
}
func jsonBytes(v any) []byte {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	if err := e.Encode(v); err != nil {
		panic(err)
	}
	return bytes.TrimSuffix(b.Bytes(), []byte{'\n'})
}
func global(kind string, id int) string {
	return base64.StdEncoding.EncodeToString([]byte(fmt.Sprintf("%s:%d", kind, id)))
}
func hashObject(kind string, data []byte) string {
	var header [96]byte
	bytes := append(header[:0], kind...)
	bytes = append(bytes, ' ')
	bytes = strconv.AppendInt(bytes, int64(len(data)), 10)
	bytes = append(bytes, 0)
	if len(data) <= 4096 {
		var combined [4192]byte
		n := copy(combined[:], bytes)
		n += copy(combined[n:], data)
		sum := sha1.Sum(combined[:n])
		return hex.EncodeToString(sum[:])
	}
	h := sha1.New()
	h.Write(bytes)
	h.Write(data)
	return hex.EncodeToString(h.Sum(nil))
}

type Object struct {
	kind         string
	data, packed []byte
	commit       *Commit
	entries      []Entry
}
type Commit struct {
	tree    string
	parents []string
	message string
}
type Entry struct{ mode, name, oid string }
type Repository struct {
	id                                       int
	name, description, branch                string
	private                                  bool
	refs                                     map[string]string
	objects                                  map[string]*Object
	issues, pulls                            map[int]M
	labels                                   map[string]M
	labelOrder                               []string
	nextNumber                               int
	fetchCache, refResponses, receiveReports map[string][]byte
	validated                                map[string]bool
	issueBytes                               map[int][]byte
}

func newRepository(id int, in M) *Repository {
	return &Repository{id: id, name: str(in["name"]), description: fallback(in["description"], ""), branch: fallback(in["default_branch"], "main"), private: truth(in["private"]), refs: map[string]string{}, objects: map[string]*Object{}, issues: map[int]M{}, pulls: map[int]M{}, labels: map[string]M{}, nextNumber: 1, fetchCache: map[string][]byte{}, refResponses: map[string][]byte{}, receiveReports: map[string][]byte{}, validated: map[string]bool{}, issueBytes: map[int][]byte{}}
}
func (r *Repository) put(kind string, data []byte) string {
	oid := hashObject(kind, data)
	if r.objects[oid] == nil {
		r.objects[oid] = &Object{kind: kind, data: data}
	}
	return oid
}
func (r *Repository) resolve(ref string) string {
	if ref == "" {
		ref = "refs/heads/" + r.branch
	}
	if s := r.refs[ref]; s != "" {
		return s
	}
	if s := r.refs["refs/heads/"+ref]; s != "" {
		return s
	}
	if s := r.refs["refs/tags/"+ref]; s != "" {
		return s
	}
	if r.objects[ref] != nil {
		return ref
	}
	return ""
}
func (r *Repository) setRef(ref, oid string) {
	if oid == zero {
		delete(r.refs, ref)
	} else {
		r.refs[ref] = oid
	}
	clear(r.refResponses)
}
func (r *Repository) commit(oid string) *Commit {
	o := r.objects[oid]
	if o == nil || o.kind != "commit" {
		return nil
	}
	if o.commit != nil {
		return o.commit
	}
	t := string(o.data)
	c := &Commit{parents: []string{}}
	for _, line := range strings.Split(t, "\n") {
		if strings.HasPrefix(line, "tree ") && len(line) >= 45 {
			c.tree = line[5:45]
		}
		if strings.HasPrefix(line, "parent ") && len(line) >= 47 {
			c.parents = append(c.parents, line[7:47])
		}
	}
	p := strings.Index(t, "\n\n")
	if p < 0 {
		p = -1
	}
	c.message = strings.TrimSuffix(t[p+2:], "\n")
	o.commit = c
	return c
}
func (r *Repository) tree(oid string) []Entry {
	o := r.objects[oid]
	if o == nil {
		return nil
	}
	if o.entries != nil {
		return o.entries
	}
	es := []Entry{}
	d := o.data
	for p := 0; p < len(d); {
		s := bytes.IndexByte(d[p:], ' ')
		need(s >= 0, 400, "Invalid tree")
		s += p
		n := bytes.IndexByte(d[s:], 0)
		need(n >= 0, 400, "Invalid tree")
		n += s
		need(n+21 <= len(d), 400, "Invalid tree")
		es = append(es, Entry{string(d[p:s]), string(d[s+1 : n]), hex.EncodeToString(d[n+1 : n+21])})
		p = n + 21
	}
	o.entries = es
	return es
}
func (r *Repository) files(tip string) map[string]string {
	files := map[string]string{}
	var walk func(string, string)
	walk = func(tree, prefix string) {
		for _, e := range r.tree(tree) {
			if e.mode == "40000" || e.mode == "040000" {
				walk(e.oid, prefix+e.name+"/")
			} else {
				files[prefix+e.name] = e.oid
			}
		}
	}
	if c := r.commit(tip); c != nil {
		walk(c.tree, "")
	}
	return files
}
func (r *Repository) buildTree(files map[string]string) string {
	var build func(string) string
	build = func(prefix string) string {
		es := []Entry{}
		dirs := map[string]bool{}
		for path, oid := range files {
			if !strings.HasPrefix(path, prefix) {
				continue
			}
			rest := path[len(prefix):]
			if s := strings.IndexByte(rest, '/'); s < 0 {
				es = append(es, Entry{"100644", rest, oid})
			} else {
				dirs[rest[:s]] = true
			}
		}
		for name := range dirs {
			es = append(es, Entry{"40000", name, build(prefix + name + "/")})
		}
		sort.Slice(es, func(i, j int) bool {
			a, b := es[i].name, es[j].name
			if es[i].mode == "40000" {
				a += "/"
			}
			if es[j].mode == "40000" {
				b += "/"
			}
			return a < b
		})
		var data []byte
		for _, e := range es {
			data = append(data, []byte(e.mode+" "+e.name+"\x00")...)
			raw, _ := hex.DecodeString(e.oid)
			data = append(data, raw...)
		}
		return r.put("tree", data)
	}
	return build("")
}
func (r *Repository) writeCommit(files map[string]string, parents []string, message string) string {
	tree := r.buildTree(files)
	t, err := time.Parse(time.RFC3339Nano, stamp)
	epoch := int64(1700000000)
	if err == nil && t.Unix() != 0 {
		epoch = t.Unix()
	}
	var b strings.Builder
	b.WriteString("tree " + tree + "\n")
	for _, p := range parents {
		b.WriteString("parent " + p + "\n")
	}
	fmt.Fprintf(&b, "author Forge <forge@example.invalid> %d +0000\ncommitter Forge <forge@example.invalid> %d +0000\n\n%s\n", epoch, epoch, message)
	return r.put("commit", []byte(b.String()))
}
func (r *Repository) ancestor(older, newer string) bool {
	if older == newer {
		return true
	}
	c := r.commit(newer)
	if c == nil {
		return false
	}
	for _, p := range c.parents {
		if p == older {
			return true
		}
	}
	q := []string{newer}
	seen := map[string]bool{}
	for len(q) > 0 {
		n := q[len(q)-1]
		q = q[:len(q)-1]
		if n == older {
			return true
		}
		if seen[n] {
			continue
		}
		seen[n] = true
		if c := r.commit(n); c != nil {
			q = append(q, c.parents...)
		}
	}
	return false
}
func (r *Repository) mergeBase(a, b string) string {
	seen := map[string]bool{}
	q := []string{a}
	for len(q) > 0 {
		n := q[len(q)-1]
		q = q[:len(q)-1]
		if seen[n] {
			continue
		}
		seen[n] = true
		if c := r.commit(n); c != nil {
			q = append(q, c.parents...)
		}
	}
	other := map[string]bool{}
	q = []string{b}
	for len(q) > 0 {
		n := q[0]
		q = q[1:]
		if seen[n] {
			return n
		}
		if other[n] {
			continue
		}
		other[n] = true
		if c := r.commit(n); c != nil {
			q = append(q, c.parents...)
		}
	}
	return ""
}
func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
func itemList(m map[int]M) []any {
	keys := make([]int, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Ints(keys)
	a := make([]any, 0, len(m))
	for _, k := range keys {
		a = append(a, m[k])
	}
	return a
}
func (r *Repository) changes(pull M) []any {
	h, b := obj(pull["head"]), obj(pull["base"])
	head, base := r.files(str(h["sha"])), r.files(r.mergeBase(str(h["sha"]), str(b["sha"])))
	all := map[string]bool{}
	for k := range base {
		all[k] = true
	}
	for k := range head {
		all[k] = true
	}
	result := []any{}
	lines := func(oid string) int {
		n := 0
		if o := r.objects[oid]; o != nil {
			for _, s := range strings.Split(string(o.data), "\n") {
				if s != "" {
					n++
				}
			}
		}
		return n
	}
	for _, path := range sortedKeys(all) {
		before, after := base[path], head[path]
		if before == after {
			continue
		}
		status := "modified"
		if before == "" {
			status = "added"
		} else if after == "" {
			status = "removed"
		}
		a, d := lines(after), lines(before)
		sha := after
		if sha == "" {
			sha = before
		}
		result = append(result, M{"filename": path, "status": status, "additions": a, "deletions": d, "changes": a + d, "sha": sha})
	}
	return result
}

type NodeRecord struct {
	kind     string
	repo     *Repository
	item     M
	comments []any
}
type Store struct {
	login     string
	repos     map[string]*Repository
	repoOrder []string
	nodes     map[string]*NodeRecord
	nextID    int
}

func newStore() *Store {
	return &Store{login: os.Getenv("FORGE_LOGIN"), repos: map[string]*Repository{}, nodes: map[string]*NodeRecord{}, nextID: 1}
}
func (s *Store) user() M {
	return M{"login": fallback(s.login, "forge"), "id": 1, "node_id": global("User", 1), "type": "User"}
}
func (s *Store) repo(owner, name string) *Repository {
	if s.login == "" {
		s.login = owner
	}
	r := s.repos[name]
	found(owner == s.login && r != nil)
	return r
}
func (s *Store) repository(r *Repository) M {
	nodeID := global("Repository", r.id)
	s.nodes[nodeID] = &NodeRecord{kind: "Repository", repo: r}
	return M{"id": r.id, "node_id": nodeID, "name": r.name, "full_name": str(s.user()["login"]) + "/" + r.name, "owner": s.user(), "private": r.private, "description": r.description, "default_branch": r.branch, "has_issues": true, "created_at": stamp, "updated_at": stamp}
}
func (s *Store) createRepo(in M) M {
	name, ok := in["name"].(string)
	need(ok && name != "", 422, "Repository name required")
	need(s.repos[name] == nil, 422, "Repository already exists")
	r := newRepository(s.nextID, in)
	s.nextID++
	s.repos[name] = r
	s.repoOrder = append(s.repoOrder, name)
	return s.repository(r)
}
func (s *Store) createIssue(r *Repository, in M) M {
	title, ok := in["title"].(string)
	need(ok && title != "", 422, "Title required")
	labels := []any{}
	for _, v := range arr(in["labels"]) {
		name := str(v)
		if m, ok := v.(map[string]any); ok {
			name = str(m["name"])
		}
		l := r.labels[name]
		need(l != nil, 422, "Unknown label")
		labels = append(labels, l)
	}
	id, number := s.nextID, r.nextNumber
	s.nextID++
	r.nextNumber++
	issue := M{"id": id, "node_id": global("Issue", id), "number": number, "title": title, "body": fallback(in["body"], ""), "state": "open", "labels": labels, "user": s.user(), "created_at": stamp, "updated_at": stamp, "comments": 0}
	r.issues[number] = issue
	s.nodes[str(issue["node_id"])] = &NodeRecord{kind: "Issue", repo: r, item: issue, comments: []any{}}
	return issue
}
func (s *Store) createPull(r *Repository, in M) M {
	head := str(in["head"])
	parts := strings.Split(head, ":")
	head = parts[len(parts)-1]
	base := fallback(in["base"], r.branch)
	hs, bs := r.resolve(head), r.resolve(base)
	need(hs != "", 422, "Unknown head branch")
	need(bs != "", 422, "Unknown base branch")
	id, number := s.nextID, r.nextNumber
	s.nextID++
	r.nextNumber++
	p := M{"id": id, "node_id": global("PullRequest", id), "number": number, "title": fallback(in["title"], ""), "body": fallback(in["body"], ""), "state": "open", "head": M{"ref": head, "sha": hs}, "base": M{"ref": base, "sha": bs}, "merged": false, "mergeable": true, "merged_at": nil, "merge_commit_sha": nil, "created_at": stamp, "updated_at": stamp, "user": s.user()}
	r.pulls[number] = p
	s.nodes[str(p["node_id"])] = &NodeRecord{kind: "PullRequest", repo: r, item: p}
	return p
}
func (s *Store) merge(r *Repository, p M) M {
	found(p != nil)
	need(!truth(p["merged"]), 405, "Already merged")
	h, b := obj(p["head"]), obj(p["base"])
	current := r.resolve(str(b["ref"]))
	common := r.files(r.mergeBase(str(h["sha"]), str(b["sha"])))
	head, merged := r.files(str(h["sha"])), r.files(current)
	all := map[string]bool{}
	for k := range common {
		all[k] = true
	}
	for k := range head {
		all[k] = true
	}
	for path := range all {
		old, next, base := common[path], head[path], merged[path]
		if old == next {
			continue
		}
		need(base == old || base == next, 405, "Pull request has conflicts")
		if next != "" {
			merged[path] = next
		} else {
			delete(merged, path)
		}
	}
	sha := r.writeCommit(merged, []string{current}, str(p["title"]))
	r.setRef("refs/heads/"+str(b["ref"]), sha)
	p["state"] = "closed"
	p["merged"] = true
	p["merged_at"] = stamp
	p["merge_commit_sha"] = sha
	return M{"sha": sha, "merged": true, "message": "Pull request successfully merged"}
}
func (s *Store) changedIssue(issue M) {
	if n := s.nodes[str(issue["node_id"])]; n != nil {
		delete(n.repo.issueBytes, num(issue["number"]))
	}
}
func (s *Store) comment(issue M, body string) M {
	n := s.nodes[str(issue["node_id"])]
	found(n != nil)
	id := s.nextID
	s.nextID++
	c := M{"id": id, "node_id": global("IssueComment", id), "body": body, "user": s.user(), "created_at": stamp, "updated_at": stamp}
	n.comments = append(n.comments, c)
	issue["comments"] = num(issue["comments"]) + 1
	s.changedIssue(issue)
	return c
}
