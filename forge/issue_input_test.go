package main

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestSimpleIssueInputParity(t *testing.T) {
	samples := []string{"plain", "", `quotes " \\ /`, "\b\f\n\r\t\x00\x1f", "🌿 é <&> \u2028\u2029", string([]byte{0xff, 0xfe})}
	for _, title := range samples {
		for _, body := range samples {
			data := jsonBytes(M{"title": title, "body": body})
			gotTitle, gotBody, ok := simpleIssueInput(data)
			var expected M
			if err := json.Unmarshal(data, &expected); err != nil {
				t.Fatal(err)
			}
			if !ok || gotTitle != expected["title"] || gotBody != expected["body"] {
				t.Fatalf("input mismatch for %q: %q %q %t", data, gotTitle, gotBody, ok)
			}
		}
	}
	for _, data := range []string{`{ "title":"first", "body":"body", "title":"last" }`, `{"\u0074itle":"title"}`, `{"title":"\ud800"}`, "{\"title\":\"\xff\"}"} {
		title, body, ok := simpleIssueInput([]byte(data))
		var expected M
		if err := json.Unmarshal([]byte(data), &expected); err != nil {
			t.Fatal(err)
		}
		if !ok || title != expected["title"] || body != fallback(expected["body"], "") {
			t.Fatalf("JSON parity: %q", data)
		}
	}
	for _, data := range []string{`{}`, `[]`, `null`, `{"title":null}`, `{"title":3}`, `{"title":"x","labels":[]}`, `{"title":"x","body":null}`, `{"title":"x",}`, `{"title":"x"}x`, `{"title":"\q"}`, `{"title":"\uZZZZ"}`, "{\"title\":\"unescaped\ncontrol\"}"} {
		if _, _, ok := simpleIssueInput([]byte(data)); ok {
			t.Fatalf("should use general decoder: %q", data)
		}
	}
}

func TestCompactIssueMutationAndInputOwnership(t *testing.T) {
	t.Setenv("MAKEFUN_SHOP_TOKEN", "compact")
	s := newServer()
	s.store.login = "alice"
	s.store.createRepo(M{"name": "issues"})
	r := s.store.repo("alice", "issues")
	body := []byte(`{"title":"original","body":"text"}`)
	req := Request{method: "POST", path: "/api/v3/repos/alice/issues/issues", authorization: "Bearer compact", body: body}
	created := s.handle(req)
	if created.status != 201 || r.issues[1].value != nil {
		t.Fatal("creation materialized the generic map")
	}
	if !bytes.Equal(s.encode(created, false), s.encode(Reply{status: 201, data: created.data, contentType: created.contentType}, false)) {
		t.Fatal("combined HTTP encoding differs")
	}
	clear(body)
	req.method, req.path, req.body = "GET", req.path+"/1", nil
	read := s.handle(req)
	if r.issues[1].value != nil || !bytes.Contains(read.data, []byte(`"title":"original"`)) {
		t.Fatal("cached read or input ownership failed")
	}
	nodeID := r.issues[1].nodeID
	result := s.store.graphql(M{"query": `mutation($id:ID!){closeIssue(input:{issueId:$id}){issue{state}}}`, "variables": M{"id": nodeID}})
	if bytes.Contains(jsonBytes(result), []byte(`"errors"`)) {
		t.Fatalf("mutation failed: %s", jsonBytes(result))
	}
	read = s.handle(req)
	if !bytes.Contains(read.data, []byte(`"state":"closed"`)) {
		t.Fatal("GraphQL mutation did not invalidate cached read")
	}
	s.store.comment(r.issue(1), "comment")
	if !bytes.Contains(s.handle(req).data, []byte(`"comments":1`)) {
		t.Fatal("comment did not invalidate cached read")
	}
	if len(r.issueList()) != 1 || s.store.nodes[nodeID].itemValue()["title"] != "original" {
		t.Fatal("generic surfaces lost issue")
	}
}
