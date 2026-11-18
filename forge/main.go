package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"time"
)

func errorMessage(e any) string {
	if err, ok := e.(error); ok {
		return err.Error()
	}
	return fmt.Sprint(e)
}

type Request struct {
	method, path, authorization, gitProtocol, host string
	body                                           []byte
}
type Server struct {
	store      *Store
	credential string
	mu         sync.Mutex
	wire       map[*byte]cachedWire
	wireBytes  int
	routes     map[string]*Route
}
type Route struct {
	u       *url.URL
	parts   []string
	service string
	number  int
}

func newServer() *Server {
	token := os.Getenv("MAKEFUN_SHOP_TOKEN")
	if token != "" {
		token = "Bearer " + token
	}
	return &Server{store: newStore(), credential: token, wire: map[*byte]cachedWire{}, routes: map[string]*Route{}}
}
func (s *Server) handle(req Request) (reply Reply) {
	defer func() {
		if e := recover(); e != nil {
			status := 500
			if f, ok := e.(failure); ok {
				status = f.status
			} else {
				fmt.Fprintln(os.Stderr, "Request error:", e)
			}
			reply = jsonReply(status, M{"message": errorMessage(e)})
		}
	}()
	if req.path == "/healthz" && req.method == "GET" {
		return ok(M{"ok": true})
	}
	if s.credential == "" || req.authorization != s.credential {
		return jsonReply(401, M{"message": "Bad credentials"})
	}
	store := s.store
	target := s.routes[req.path]
	if target == nil {
		u, err := url.ParseRequestURI(req.path)
		if err != nil {
			panic(err)
		}
		parts := strings.Split(u.EscapedPath(), "/")
		for i, p := range parts {
			decoded, err := url.PathUnescape(p)
			if err != nil {
				panic(err)
			}
			parts[i] = decoded
		}
		target = &Route{u: u, parts: parts, service: u.Query().Get("service"), number: -1}
		if len(parts) == 8 {
			digits := parts[7] != ""
			for _, b := range parts[7] {
				if b < '0' || b > '9' {
					digits = false
					break
				}
			}
			if n, e := strconv.Atoi(parts[7]); e == nil && digits {
				target.number = n
			}
		}
		if len(s.routes) >= 1024 {
			clear(s.routes)
		}
		s.routes[req.path] = target
	}
	u := target.u
	path := u.Path
	parts := target.parts
	v2 := req.gitProtocol == "version=2"
	if len(parts) >= 4 && strings.HasSuffix(parts[2], ".git") {
		owner, name := parts[1], strings.TrimSuffix(parts[2], ".git")
		service := target.service
		switch {
		case len(parts) == 5 && parts[3] == "info" && parts[4] == "refs" && req.method == "GET":
			need(service == "git-upload-pack" || service == "git-receive-pack", 400, "Unknown git service")
			return Reply{200, advertise(store.repo(owner, name), service, v2), "application/x-" + service + "-advertisement", nil}
		case len(parts) == 4 && req.method == "POST" && (parts[3] == "git-upload-pack" || parts[3] == "git-receive-pack"):
			r := store.repo(owner, name)
			var data []byte
			if parts[3] == "git-upload-pack" {
				data = upload(r, req.body, v2)
			} else {
				data = receive(r, req.body)
			}
			return Reply{200, data, "application/x-" + parts[3] + "-result", nil}
		}
	}
	if len(parts) == 8 && parts[1] == "api" && parts[2] == "v3" && parts[3] == "repos" && parts[6] == "issues" && req.method == "GET" {
		if n := target.number; n >= 0 {
			r := store.repo(parts[4], parts[5])
			issue := r.issues[n]
			found(issue != nil)
			data := r.issueBytes[n]
			if data == nil {
				data = jsonBytes(issue)
				r.issueBytes[n] = data
			}
			return Reply{200, data, "application/json; charset=utf-8", nil}
		}
	}
	var input any = M{}
	if len(req.body) > 0 {
		if err := json.Unmarshal(req.body, &input); err != nil {
			if req.path == "/mcp" {
				return jsonReply(400, M{"jsonrpc": "2.0", "id": nil, "error": M{"code": -32700, "message": "Parse error"}})
			}
			return jsonReply(400, M{"message": "Invalid JSON"})
		}
	}
	if req.path == "/mcp" {
		result := store.mcp(obj(input))
		if result == nil {
			return emptyReply(202)
		}
		return ok(result)
	}
	if req.path == "/api/graphql" && req.method == "POST" {
		return ok(store.graphql(input))
	}
	if path == "/api/v3" || strings.HasPrefix(path, "/api/v3/") {
		parsed := *u
		parsed.Scheme = "http"
		parsed.Host = req.host
		if parsed.Host == "" {
			parsed.Host = "forge"
		}
		return store.rest(req.method, &parsed, obj(input))
	}
	return jsonReply(404, M{"message": "Not Found"})
}
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 128*1024*1024+1))
	if err != nil {
		http.Error(w, "Bad Request", 400)
		return
	}
	if len(body) > 128*1024*1024 {
		http.Error(w, "Request too large", 413)
		return
	}
	s.mu.Lock()
	reply := s.handle(Request{r.Method, r.RequestURI, r.Header.Get("Authorization"), r.Header.Get("Git-Protocol"), r.Host, body})
	s.mu.Unlock()
	w.Header().Set("Content-Type", reply.contentType)
	w.Header().Set("Content-Length", strconv.Itoa(len(reply.data)))
	w.Header().Set("X-GitHub-Request-Id", "forge")
	for k, v := range reply.headers {
		w.Header().Set(k, v)
	}
	w.WriteHeader(reply.status)
	w.Write(reply.data)
}
func main() {
	if n, e := strconv.Atoi(env("FORGE_PROCS", "2")); e == nil && n > 0 {
		runtime.GOMAXPROCS(n)
	}
	if n, e := strconv.Atoi(env("FORGE_GOGC", "600")); e == nil {
		debug.SetGCPercent(n)
	}
	// The trial's measured working set is small; an aggressive soft limit makes
	// collection compete with requests. Keep an explicit override for diagnostics.
	if n, e := strconv.Atoi(env("FORGE_MEMORY_MB", "0")); e == nil && n > 0 {
		debug.SetMemoryLimit(int64(n) * 1024 * 1024)
	}
	if env("FORGE_GO_HTTP", "epoll") == "epoll" {
		fd, port, err := loopListener()
		if err != nil {
			panic(err)
		}
		fmt.Println(port)
		if err = newServer().serveLoop(fd); err != nil {
			panic(err)
		}
		return
	}
	listener, err := net.Listen("tcp4", "0.0.0.0:0")
	if err != nil {
		panic(err)
	}
	fmt.Println(listener.Addr().(*net.TCPAddr).Port)
	server := newServer()
	if os.Getenv("FORGE_GO_HTTP") != "http" {
		err = server.serveTCP(listener)
	} else {
		s := &http.Server{Handler: server, ReadHeaderTimeout: 60 * time.Second, IdleTimeout: 60 * time.Second}
		err = s.Serve(listener)
	}
	if err != nil {
		panic(err)
	}
}
