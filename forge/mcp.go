package main

import (
	"math"
	"strings"
)

type Tool struct {
	name, description string
	required          []string
	properties        map[string]string
}

var toolDefs = []Tool{
	{"create_repo", "Create a repository owned by the authenticated user", []string{"name"}, map[string]string{"name": "string", "description": "string", "private": "boolean"}},
	{"get_repo", "Read a repository", []string{"owner", "repo"}, map[string]string{"owner": "string", "repo": "string"}},
	{"create_issue", "Open an issue in a repository", []string{"owner", "repo", "title"}, map[string]string{"owner": "string", "repo": "string", "title": "string", "body": "string"}},
	{"list_issues", "List repository issues by state", []string{"owner", "repo"}, map[string]string{"owner": "string", "repo": "string", "state": "string"}},
	{"create_pull_request", "Open a pull request between branches", []string{"owner", "repo", "title", "head", "base"}, map[string]string{"owner": "string", "repo": "string", "title": "string", "body": "string", "head": "string", "base": "string"}},
	{"merge_pull_request", "Squash a pull request into its base branch", []string{"owner", "repo", "pull_number"}, map[string]string{"owner": "string", "repo": "string", "pull_number": "integer"}},
}
var toolList = func() []any {
	tools := []any{}
	for _, t := range toolDefs {
		props := M{}
		for k, v := range t.properties {
			props[k] = M{"type": v}
		}
		tools = append(tools, M{"name": t.name, "description": t.description, "inputSchema": M{"type": "object", "required": t.required, "properties": props}})
	}
	return tools
}()

func (s *Store) mcp(call M) any {
	reply := func(result any) M { return M{"jsonrpc": "2.0", "id": call["id"], "result": result} }
	rpcError := func(code int, message string) M {
		return M{"jsonrpc": "2.0", "id": call["id"], "error": M{"code": code, "message": message}}
	}
	method, isString := call["method"].(string)
	if call["jsonrpc"] != "2.0" || !isString {
		return rpcError(-32600, "Invalid Request")
	}
	if method == "server/discover" || method == "initialize" {
		identity := M{"serverInfo": M{"name": "forge", "version": "1.0.0"}, "capabilities": M{"tools": M{}}}
		if method == "server/discover" {
			identity["supportedVersions"] = []string{"2026-07-28", "2025-11-25"}
		} else {
			identity["protocolVersion"] = "2025-11-25"
		}
		return reply(identity)
	}
	if strings.HasPrefix(method, "notifications/") {
		return nil
	}
	if method == "ping" {
		return reply(M{})
	}
	if method == "tools/list" {
		return reply(M{"tools": toolList})
	}
	if method != "tools/call" {
		return rpcError(-32601, "Method not found")
	}
	params := obj(call["params"])
	var tool *Tool
	for i := range toolDefs {
		if toolDefs[i].name == str(params["name"]) {
			tool = &toolDefs[i]
			break
		}
	}
	if tool == nil {
		return rpcError(-32602, "Unknown tool")
	}
	args := M{}
	if truth(params["arguments"]) {
		var yes bool
		args, yes = params["arguments"].(map[string]any)
		if !yes {
			return rpcError(-32602, "Arguments must be an object")
		}
	}
	for _, key := range tool.required {
		if v, yes := args[key]; !yes || v == "" {
			return rpcError(-32602, "Missing argument: "+key)
		}
	}
	for _, key := range sortedKeys(tool.properties) {
		v, yes := args[key]
		if !yes {
			continue
		}
		valid := false
		switch tool.properties[key] {
		case "integer":
			n, ok := v.(float64)
			valid = ok && math.Trunc(n) == n && math.Abs(n) <= 9007199254740991
		case "string":
			_, valid = v.(string)
		case "boolean":
			_, valid = v.(bool)
		}
		if !valid {
			return rpcError(-32602, "Invalid argument: "+key)
		}
	}
	return func() (answer any) {
		defer func() {
			if e := recover(); e != nil {
				answer = reply(M{"isError": true, "content": []any{M{"type": "text", "text": errorMessage(e)}}})
			}
		}()
		var value any
		if tool.name == "create_repo" {
			value = s.createRepo(args)
		} else {
			r := s.repo(str(args["owner"]), str(args["repo"]))
			switch tool.name {
			case "get_repo":
				value = s.repository(r)
			case "create_issue":
				value = s.createIssue(r, args)
			case "list_issues":
				list := []any{}
				for _, v := range r.issueList() {
					if !truth(args["state"]) || args["state"] == "all" || obj(v)["state"] == args["state"] {
						list = append(list, v)
					}
				}
				value = list
			case "create_pull_request":
				value = s.createPull(r, args)
			case "merge_pull_request":
				p := r.pulls[num(args["pull_number"])]
				found(p != nil)
				value = s.merge(r, p)
			}
		}
		structured := value
		if list, ok := value.([]any); ok {
			structured = M{"issues": list}
		}
		return reply(M{"content": []any{M{"type": "text", "text": string(jsonBytes(value))}}, "structuredContent": structured, "isError": false})
	}()
}
