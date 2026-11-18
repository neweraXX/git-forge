package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestSharedStore(t *testing.T) {
	s := newStore()
	s.login = "alice"
	s.createRepo(M{"name": "demo"})
	r := s.repo("alice", "demo")
	issue := s.createIssue(r, M{"title": "test", "body": "body"})
	query := `query Named($o: String! = "alice") { x: repository(owner: $o, name: "demo") { ...Info issue(number: 1) { title hidden: body @skip(if: true) } } } fragment Info on Repository { name nameWithOwner }`
	data := jsonBytes(s.graphql(M{"query": query}))
	expected := `{"data":{"x":{"issue":{"title":"test"},"name":"demo","nameWithOwner":"alice/demo"}}}`
	if string(data) != expected {
		t.Fatalf("GraphQL: %s", data)
	}
	r.issueBytes[1] = jsonBytes(issue)
	s.graphql(M{"query": `mutation($input: CloseIssueInput!) { closeIssue(input: $input) { issue { state } } }`, "variables": M{"input": M{"issueId": issue["node_id"]}}})
	if issue["state"] != "closed" || r.issueBytes[1] != nil {
		t.Fatal("mutation did not invalidate issue")
	}
	s.comment(issue, "comment")
	if issue["comments"] != 1 {
		t.Fatal("comment count")
	}
	response := jsonBytes(s.mcp(M{"jsonrpc": "2.0", "id": "test", "method": "tools/call", "params": M{"name": "get_repo", "arguments": M{"owner": "alice", "repo": "demo"}}}))
	if !bytes.Contains(response, []byte(`"isError":false`)) {
		t.Fatalf("MCP: %s", response)
	}
}
func TestGitGraph(t *testing.T) {
	r := newRepository(1, M{"name": "demo"})
	blob := r.put("blob", []byte("hello world\n"))
	tip := r.writeCommit(map[string]string{"hello.txt": blob}, nil, "root")
	r.setRef("refs/heads/main", tip)
	ids, _ := closure(r, []string{tip}, nil, 1)
	p := packObjects(r, ids)
	other := newRepository(2, M{"name": "copy"})
	unpack(other, p)
	if string(other.objects[blob].data) != "hello world\n" {
		t.Fatal("pack round trip")
	}
	validateGraph(other, []string{tip})
	broken := other.put("commit", []byte("tree "+strings.Repeat("a", 40)+"\n\nbroken\n"))
	body := append(packet(zero+" "+broken+" refs/heads/main\x00report-status\n"), flush...)
	body = append(body, packObjects(other, nil)...)
	if !bytes.Contains(receive(other, body), []byte("unpacker error")) || len(other.refs) != 0 {
		t.Fatal("broken closure accepted")
	}
}
func TestDelta(t *testing.T) {
	base := []byte("hello world\n")
	delta := append([]byte{12, 12, 0x90, 6, 6}, []byte("forge\n")...)
	if got := deltaApply(base, delta); string(got) != "hello forge\n" {
		t.Fatalf("delta: %q", got)
	}
}
