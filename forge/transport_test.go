package main

import (
	"bytes"
	"testing"
)

func TestBorrowedHeadersAndRouteOwnership(t *testing.T) {
	t.Setenv("MAKEFUN_SHOP_TOKEN", "borrowed")
	s := newServer()
	s.store.login = "alice"
	s.store.createRepo(M{"name": "first"})
	s.store.createRepo(M{"name": "other"})
	head := []byte("GET /api/v3/repos/alice/first HTTP/1.1\r\nHost: forge\r\nAuthorization: Bearer borrowed\r\n\r\n")
	if n := testing.AllocsPerRun(100, func() { parseHeadersView(head) }); n != 0 {
		t.Fatalf("header views allocated %g times", n)
	}
	owned, _ := parseHeaders(head)
	borrowed, _ := parseHeadersView(head)
	if s.handle(borrowed).status != 200 {
		t.Fatal("initial route failed")
	}
	copy(head, bytes.ReplaceAll(head, []byte("first"), []byte("other")))
	if owned.path != "/api/v3/repos/alice/first" {
		t.Fatal("owned headers changed with input")
	}
	if borrowed.path != "/api/v3/repos/alice/other" {
		t.Fatal("borrowed request did not borrow input")
	}
	if got := s.handle(owned); got.status != 200 || !bytes.Contains(got.data, []byte(`"name":"first"`)) {
		t.Fatal("route retained mutable input")
	}
}
