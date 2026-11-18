package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestIssueCreationSerialization(t *testing.T) {
	s := newServer()
	s.store.login = "alice"
	s.store.createRepo(M{"name": "issues"})
	r := s.store.repo("alice", "issues")
	r.labels["green"] = M{"id": 3, "name": "green", "color": "00ff00", "description": "<&>"}
	samples := []string{"ASCII", `quotes " and backslash \`, "tabs\tnewlines\ncontrol\x00\x01\x1f", "🌿 é <&> \u2028\u2029", string([]byte{0xff, 0xfe, 0x80})}
	for _, text := range samples {
		issue := s.store.createIssue(r, M{"title": text, "body": text, "labels": []any{"green"}})
		expected := jsonBytes(issue)
		reply := s.createdIssue(r, issue)
		if !bytes.Equal(reply.data, expected) {
			t.Fatalf("issue JSON\ngot %s\nwant %s", reply.data, expected)
		}
	}
	first := bytes.Clone(r.issueBytes[1])
	issue := s.store.createIssue(r, M{"title": "large", "body": strings.Repeat("x", 2*1024*1024)})
	s.createdIssue(r, issue)
	if !bytes.Equal(first, r.issueBytes[1]) {
		t.Fatal("response scratch overwrote an earlier issue")
	}
	if s.scratch != nil {
		t.Fatal("oversized scratch retained")
	}
}

func TestHotResponsesAllocateNothing(t *testing.T) {
	t.Setenv("MAKEFUN_SHOP_TOKEN", "hot-test")
	s := newServer()
	s.store.login = "alice"
	s.store.createRepo(M{"name": "hot"})
	r := s.store.repo("alice", "hot")
	s.store.createIssue(r, M{"title": "hot"})
	blob := r.put("blob", []byte("content\n"))
	tip := r.writeCommit(map[string]string{"file": blob}, nil, "root")
	r.setRef("refs/heads/main", tip)
	ls := append(packet("command=ls-refs\n"), []byte("00010000")...)
	fetch := append(packet("command=fetch\n"), []byte("0001")...)
	fetch = append(fetch, packet("want "+tip+"\n")...)
	fetch = append(fetch, packet("deepen 1\n")...)
	fetch = append(fetch, flush...)
	for _, test := range []struct {
		name    string
		request Request
	}{
		{"issue", Request{method: "GET", path: "/api/v3/repos/alice/hot/issues/1"}},
		{"advertisement", Request{method: "GET", path: "/alice/hot.git/info/refs?service=git-upload-pack"}},
		{"ls-refs", Request{method: "POST", path: "/alice/hot.git/git-upload-pack", gitProtocol: "version=2", body: ls}},
		{"fetch", Request{method: "POST", path: "/alice/hot.git/git-upload-pack", gitProtocol: "version=2", body: fetch}},
	} {
		t.Run(test.name, func(t *testing.T) {
			req := test.request
			req.authorization = "Bearer hot-test"
			reply := s.handle(req)
			if reply.status != 200 {
				t.Fatalf("status %d: %s", reply.status, reply.data)
			}
			s.encode(reply, false)
			allocs := testing.AllocsPerRun(100, func() { s.encode(s.handle(req), false) })
			if allocs != 0 {
				t.Fatalf("hot response allocated %g times", allocs)
			}
		})
	}
	// Ref packets must change even when the same ls-refs request remains cached.
	before := bytes.Clone(upload(r, ls, true))
	r.setRef("refs/heads/next", tip)
	if bytes.Equal(before, upload(r, ls, true)) {
		t.Fatal("stale ls-refs after mutation")
	}
}
