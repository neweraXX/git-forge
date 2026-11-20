package main

import (
	"encoding/base64"
	"net/url"
	"sort"
	"strconv"
	"strings"
)

type Reply struct {
	status      int
	data        []byte
	contentType string
	headers     map[string]string
	wire        []byte
}

func jsonReply(status int, v any) Reply {
	return Reply{status: status, data: jsonBytes(v), contentType: "application/json; charset=utf-8"}
}
func emptyReply(status int) Reply {
	return Reply{status: status, contentType: "application/json; charset=utf-8"}
}
func ok(v any) Reply { return jsonReply(200, v) }
func setQueryParam(raw, key, value string) string {
	pairs := []string{}
	replaced := false
	escape := func(s string) string {
		return strings.ReplaceAll(strings.ReplaceAll(url.QueryEscape(s), "~", "%7E"), "%2A", "*")
	}
	for _, pair := range strings.Split(raw, "&") {
		if pair == "" {
			continue
		}
		parts := strings.SplitN(pair, "=", 2)
		k, _ := url.QueryUnescape(parts[0])
		v := ""
		if len(parts) > 1 {
			v, _ = url.QueryUnescape(parts[1])
		}
		if k == key {
			if replaced {
				continue
			}
			replaced = true
			v = value
		}
		pairs = append(pairs, escape(k)+"="+escape(v))
	}
	if !replaced {
		pairs = append(pairs, escape(key)+"="+escape(value))
	}
	return strings.Join(pairs, "&")
}
func (s *Store) rest(method string, u *url.URL, in M) Reply {
	path := strings.TrimPrefix(strings.TrimPrefix(u.Path, "/api/v3"), "/")
	q := u.Query()
	page, per := num(q.Get("page")), num(q.Get("per_page"))
	if page < 1 {
		page = 1
	}
	if per == 0 {
		per = 30
	}
	if per < 1 {
		per = 1
	}
	if per > 100 {
		per = 100
	}
	paginate := func(list []any) Reply {
		start, end := (page-1)*per, page*per
		if start > len(list) {
			start = len(list)
		}
		if end > len(list) {
			end = len(list)
		}
		if list == nil {
			list = []any{}
		}
		out := ok(list[start:end])
		if len(list) > page*per {
			next := *u
			next.RawQuery = setQueryParam(u.RawQuery, "page", strconv.Itoa(page+1))
			out.headers = map[string]string{"link": "<" + next.String() + ">; rel=\"next\""}
		}
		return out
	}
	if method == "GET" && path == "" {
		r := ok(M{"current_user_url": "/api/v3/user", "repository_url": "/api/v3/repos/{owner}/{repo}"})
		r.headers = map[string]string{"x-oauth-scopes": "repo, read:org"}
		return r
	}
	if method == "GET" && path == "meta" {
		return ok(M{"installed_version": "forge-1.0"})
	}
	if method == "GET" && path == "user" {
		return ok(s.user())
	}
	if path == "user/repos" {
		if method == "POST" {
			return jsonReply(201, s.createRepo(in))
		}
		if method == "GET" {
			list := []any{}
			for _, name := range s.repoOrder {
				if r := s.repos[name]; r != nil {
					list = append(list, s.repository(r))
				}
			}
			return paginate(list)
		}
	}
	parts := strings.SplitN(path, "/", 4)
	found(len(parts) >= 3 && parts[0] == "repos")
	owner, name := parts[1], parts[2]
	tail := ""
	if len(parts) == 4 {
		tail = parts[3]
	}
	r := s.repo(owner, name)
	if tail == "" {
		switch method {
		case "GET":
			return ok(s.repository(r))
		case "PATCH":
			if v, yes := in["description"]; yes {
				r.description = str(v)
			}
			if truth(in["default_branch"]) {
				r.branch = str(in["default_branch"])
				r.clearRefResponses()
			}
			return ok(s.repository(r))
		case "DELETE":
			delete(s.repos, name)
			for i, n := range s.repoOrder {
				if n == name {
					s.repoOrder = append(s.repoOrder[:i], s.repoOrder[i+1:]...)
					break
				}
			}
			return emptyReply(204)
		}
	}
	refBody := func(ref string) M {
		sha := r.refs[ref]
		found(sha != "")
		return M{"ref": ref, "node_id": global("Ref", r.id), "object": M{"sha": sha, "type": "commit"}}
	}
	if tail == "git/refs" && method == "POST" {
		ref, sha := str(in["ref"]), str(in["sha"])
		need(strings.HasPrefix(ref, "refs/") && r.objects[sha] != nil, 422, "Invalid ref or object")
		need(r.refs[ref] == "", 422, "Reference already exists")
		r.setRef(ref, sha)
		return jsonReply(201, refBody(ref))
	}
	if method == "GET" && (strings.HasPrefix(tail, "git/refs/") || strings.HasPrefix(tail, "git/ref/")) {
		return ok(refBody("refs/" + strings.SplitN(tail, "/", 3)[2]))
	}
	if tail == "branches" && method == "GET" {
		list := []any{}
		for _, ref := range r.refOrder {
			if strings.HasPrefix(ref, "refs/heads/") {
				list = append(list, M{"name": ref[11:], "commit": M{"sha": r.refs[ref]}, "protected": false})
			}
		}
		return paginate(list)
	}
	if strings.HasPrefix(tail, "branches/") && method == "GET" {
		sha := r.resolve(tail[9:])
		found(sha != "")
		return ok(M{"name": tail[9:], "commit": M{"sha": sha}})
	}
	if (tail == "commits" || strings.HasPrefix(tail, "commits/")) && method == "GET" {
		ref := q.Get("sha")
		if tail != "commits" {
			ref = tail[8:]
		}
		tip := r.resolve(ref)
		list := []any{}
		queue := []string{}
		if tip != "" {
			queue = append(queue, tip)
		}
		seen := map[string]bool{}
		for len(queue) > 0 {
			sha := queue[0]
			queue = queue[1:]
			if seen[sha] {
				continue
			}
			seen[sha] = true
			c := r.commit(sha)
			if c == nil {
				continue
			}
			parents := []any{}
			for _, p := range c.parents {
				parents = append(parents, M{"sha": p})
			}
			list = append(list, M{"sha": sha, "commit": M{"message": c.message, "tree": M{"sha": c.tree}}, "parents": parents})
			queue = append(queue, c.parents...)
		}
		if tail == "commits" {
			return paginate(list)
		}
		found(len(list) > 0)
		return ok(list[0])
	}
	if tail == "contents" || strings.HasPrefix(tail, "contents/") {
		filePath := ""
		if len(tail) > 8 {
			filePath = tail[9:]
		}
		branch := fallback(in["branch"], fallback(q.Get("ref"), r.branch))
		tip := r.resolve(branch)
		files := r.files(tip)
		old := files[filePath]
		content := func(path, sha string) M {
			o := r.objects[sha]
			return M{"type": "file", "name": path[strings.LastIndex(path, "/")+1:], "path": path, "sha": sha, "size": len(o.data), "encoding": "base64", "content": base64.StdEncoding.EncodeToString(o.data)}
		}
		if method == "GET" {
			if old != "" {
				return ok(content(filePath, old))
			}
			prefix := ""
			if filePath != "" {
				prefix = strings.TrimSuffix(filePath, "/") + "/"
			}
			listed := map[string]any{}
			order := []string{}
			for _, path := range r.fileOrder(tip) {
				if !strings.HasPrefix(path, prefix) {
					continue
				}
				rest := path[len(prefix):]
				slash := strings.IndexByte(rest, '/')
				child := rest
				var v any
				if slash < 0 {
					v = content(path, files[path])
				} else {
					child = rest[:slash]
					tree := ""
					if c := r.commit(tip); c != nil {
						tree = c.tree
					}
					v = M{"type": "dir", "name": child, "path": prefix + child, "sha": tree}
				}
				if listed[child] == nil {
					order = append(order, child)
				}
				listed[child] = v
			}
			found(len(listed) > 0)
			list := []any{}
			for _, k := range order {
				list = append(list, listed[k])
			}
			return ok(list)
		}
		if method == "PUT" || method == "DELETE" {
			if method == "DELETE" {
				found(old != "")
			}
			need(!((old != "" && str(in["sha"]) != old) || (old == "" && truth(in["sha"]))), 409, "File SHA does not match")
			if method == "DELETE" {
				delete(files, filePath)
			} else {
				v, yes := in["content"].(string)
				need(yes, 422, "Content required")
				data, _ := base64.StdEncoding.DecodeString(strings.TrimRight(v, "=") + strings.Repeat("=", (4-len(strings.TrimRight(v, "="))%4)%4))
				files[filePath] = r.put("blob", data)
			}
			parents := []string{}
			if tip != "" {
				parents = append(parents, tip)
			}
			message := fallback(in["message"], "Update file")
			sha := r.writeCommit(files, parents, message)
			r.setRef("refs/heads/"+branch, sha)
			var c any
			if method != "DELETE" {
				c = content(filePath, files[filePath])
			}
			status := 200
			if method == "PUT" && old == "" {
				status = 201
			}
			return jsonReply(status, M{"content": c, "commit": M{"sha": sha, "message": message}})
		}
	}
	if tail == "labels" {
		if method == "POST" {
			need(truth(in["name"]), 422, "Label name required")
			name := str(in["name"])
			label := M{"id": s.nextID, "name": name, "color": fallback(in["color"], "ededed"), "description": fallback(in["description"], "")}
			s.nextID++
			if r.labels[name] == nil {
				r.labelOrder = append(r.labelOrder, name)
			}
			r.labels[name] = label
			return jsonReply(201, label)
		}
		if method == "GET" {
			list := []any{}
			for _, name := range r.labelOrder {
				list = append(list, r.labels[name])
			}
			return paginate(list)
		}
	}
	if tail == "issues" {
		if method == "POST" {
			return jsonReply(201, s.createIssue(r, in))
		}
		if method == "GET" {
			state := fallback(q.Get("state"), "open")
			list := []any{}
			for _, v := range r.issueList() {
				i := obj(v)
				if state == "all" || i["state"] == state {
					list = append(list, i)
				}
			}
			if q.Get("direction") != "asc" {
				sort.Slice(list, func(i, j int) bool { return num(obj(list[i])["number"]) > num(obj(list[j])["number"]) })
			}
			return paginate(list)
		}
	}
	seg := strings.Split(tail, "/")
	if len(seg) >= 2 && seg[0] == "issues" {
		issue := r.issue(num(seg[1]))
		found(issue != nil)
		if len(seg) == 3 && seg[2] == "comments" {
			if method == "POST" {
				return jsonReply(201, s.comment(issue, fallback(in["body"], "")))
			}
			if method == "GET" {
				return paginate(s.nodes[str(issue["node_id"])].comments)
			}
		} else if len(seg) == 2 {
			if method == "PATCH" {
				for _, k := range []string{"state", "title", "body"} {
					if v, yes := in[k]; yes {
						issue[k] = v
					}
				}
				issue["updated_at"] = stamp
				s.changedIssue(issue)
			}
			if method == "GET" || method == "PATCH" {
				return ok(issue)
			}
		}
	}
	if tail == "pulls" {
		if method == "POST" {
			return jsonReply(201, s.createPull(r, in))
		}
		if method == "GET" {
			state := fallback(q.Get("state"), "open")
			list := []any{}
			for _, v := range itemList(r.pulls) {
				if state == "all" || obj(v)["state"] == state {
					list = append(list, v)
				}
			}
			return paginate(list)
		}
	}
	if len(seg) >= 2 && seg[0] == "pulls" {
		pull := r.pulls[num(seg[1])]
		found(pull != nil)
		if len(seg) == 3 && seg[2] == "merge" && method == "PUT" {
			return ok(s.merge(r, pull))
		}
		if len(seg) == 3 && seg[2] == "files" && method == "GET" {
			return paginate(r.changes(pull))
		}
		if len(seg) == 2 && method == "GET" {
			return ok(pull)
		}
	}
	panic(failure{404, "Not Found"})
}
