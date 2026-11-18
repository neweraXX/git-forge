package main

import (
	"bytes"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const maxBody = 128 * 1024 * 1024

type cachedWire struct {
	status int
	kind   string
	wire   []byte
}

// Immutable reply bodies identify reusable responses. The bounded cache retains
// their backing storage; replacing an issue or ref response cannot reuse stale bytes.
func (s *Server) encode(reply Reply, close bool) []byte {
	var key *byte
	if len(reply.data) > 0 {
		key = &reply.data[0]
	}
	if !close && reply.headers == nil && key != nil {
		if c, ok := s.wire[key]; ok && c.status == reply.status && c.kind == reply.contentType {
			return c.wire
		}
	}
	connection := "keep-alive"
	if close {
		connection = "close"
	}
	out := make([]byte, 0, len(reply.data)+192)
	out = append(out, "HTTP/1.1 "...)
	out = strconv.AppendInt(out, int64(reply.status), 10)
	out = append(out, ' ')
	out = append(out, http.StatusText(reply.status)...)
	out = append(out, "\r\nContent-Type: "...)
	out = append(out, reply.contentType...)
	out = append(out, "\r\nContent-Length: "...)
	out = strconv.AppendInt(out, int64(len(reply.data)), 10)
	out = append(out, "\r\nX-GitHub-Request-Id: forge\r\nConnection: "...)
	out = append(out, connection...)
	out = append(out, "\r\n"...)
	for _, k := range sortedKeys(reply.headers) {
		out = append(out, k...)
		out = append(out, ": "...)
		out = append(out, reply.headers[k]...)
		out = append(out, "\r\n"...)
	}
	out = append(out, "\r\n"...)
	out = append(out, reply.data...)
	if !close && reply.headers == nil && key != nil && len(out) < 8*1024*1024 {
		if len(s.wire) >= 2048 || s.wireBytes+len(out) > 16*1024*1024 {
			clear(s.wire)
			s.wireBytes = 0
		}
		s.wire[key] = cachedWire{reply.status, reply.contentType, out}
		s.wireBytes += len(out)
	}
	return out
}

type framing struct {
	length                 int
	chunked, close, expect bool
}

func parseHeaders(head []byte) (req Request, f framing) {
	end := bytes.Index(head, []byte("\r\n"))
	need(end >= 0, 400, "Bad Request")
	first := string(head[:end])
	a, b := strings.IndexByte(first, ' '), strings.LastIndexByte(first, ' ')
	need(a > 0 && b > a && (first[b+1:] == "HTTP/1.1" || first[b+1:] == "HTTP/1.0") && !strings.Contains(first[a+1:b], " "), 400, "Bad Request")
	req.method, req.path = first[:a], first[a+1:b]
	f.close = first[b+1:] == "HTTP/1.0"
	length, transfer := false, false
	for pos := end + 2; pos < len(head); {
		end = bytes.Index(head[pos:], []byte("\r\n"))
		need(end >= 0, 400, "Bad Request")
		end += pos
		line := head[pos:end]
		pos = end + 2
		if len(line) == 0 {
			break
		}
		colon := bytes.IndexByte(line, ':')
		need(colon > 0, 400, "Bad Request")
		switch colon {
		case 4, 6, 10, 12, 13, 14, 17:
		default:
			continue
		}
		name, value := line[:colon], bytes.TrimSpace(line[colon+1:])
		switch {
		case bytes.EqualFold(name, []byte("authorization")):
			req.authorization = string(value)
		case bytes.EqualFold(name, []byte("git-protocol")):
			req.gitProtocol = string(value)
		case bytes.EqualFold(name, []byte("host")):
			req.host = string(value)
		case bytes.EqualFold(name, []byte("content-length")):
			need(!length && len(value) > 0, 400, "Bad Request")
			n := 0
			overflow := false
			for _, b := range value {
				need(b >= '0' && b <= '9', 400, "Bad Request")
				if n > maxBody/10 {
					overflow = true
				} else {
					n = n*10 + int(b-'0')
					if n > maxBody {
						overflow = true
					}
				}
			}
			need(!overflow && n <= maxBody, 413, "Request too large")
			length = true
			f.length = n
		case bytes.EqualFold(name, []byte("connection")):
			if bytes.EqualFold(value, []byte("close")) {
				f.close = true
			} else if bytes.EqualFold(value, []byte("keep-alive")) {
				f.close = false
			}
		case bytes.EqualFold(name, []byte("transfer-encoding")):
			need(!transfer && bytes.EqualFold(value, []byte("chunked")), 400, "Bad Request")
			transfer = true
			f.chunked = true
		case bytes.EqualFold(name, []byte("expect")):
			f.expect = bytes.EqualFold(value, []byte("100-continue"))
		}
	}
	need(!(length && transfer), 400, "Bad Request")
	return
}
func (s *Server) serveConn(c net.Conn) {
	defer c.Close()
	defer func() {
		if e := recover(); e != nil {
			status := 400
			message := "Bad Request"
			if f, ok := e.(failure); ok {
				status, message = f.status, f.message
			}
			reply := jsonReply(status, M{"message": message})
			reply.contentType = "application/json"
			s.mu.Lock()
			wire := s.encode(reply, true)
			s.mu.Unlock()
			c.Write(wire)
		}
	}()
	buffer := make([]byte, 16384)
	pending := buffer[:0]
	var lastHead []byte
	var lastRequest Request
	// grow preserves the pending prefix and never changes data owned by the store.
	readMore := func() bool {
		if len(pending) == cap(pending) {
			size := cap(pending) * 2
			if size < 16384 {
				size = 16384
			}
			need(size <= maxBody*2, 413, "Request too large")
			next := make([]byte, len(pending), size)
			copy(next, pending)
			pending = next
		}
		c.SetReadDeadline(time.Now().Add(60 * time.Second))
		n, err := c.Read(pending[len(pending):cap(pending)])
		pending = pending[:len(pending)+n]
		return n > 0 || err == nil
	}
	for {
		end := bytes.Index(pending, []byte("\r\n\r\n"))
		for end < 0 {
			need(len(pending) <= 65536, 400, "Bad Request")
			if !readMore() {
				return
			}
			end = bytes.Index(pending, []byte("\r\n\r\n"))
		}
		headEnd := end + 4
		head := pending[:headEnd]
		var req Request
		var frame framing
		if lastHead != nil && bytes.Equal(head, lastHead) {
			req = lastRequest
		} else {
			req, frame = parseHeaders(head)
			if req.method == "GET" && !frame.close && !frame.chunked && frame.length == 0 {
				lastHead = append(lastHead[:0], head...)
				lastRequest = req
			} else {
				lastHead = nil
			}
		}
		if frame.expect {
			if _, err := c.Write([]byte("HTTP/1.1 100 Continue\r\n\r\n")); err != nil {
				return
			}
		}
		used := headEnd
		if !frame.chunked {
			for len(pending) < headEnd+frame.length {
				if !readMore() {
					return
				}
			}
			req.body = pending[headEnd : headEnd+frame.length]
			used += frame.length
		} else {
			body := []byte{}
			for {
				lineEnd := bytes.Index(pending[used:], []byte("\r\n"))
				for lineEnd < 0 {
					if !readMore() {
						return
					}
					lineEnd = bytes.Index(pending[used:], []byte("\r\n"))
				}
				sizeText := strings.SplitN(string(pending[used:used+lineEnd]), ";", 2)[0]
				need(sizeText != "", 400, "Bad Request")
				for _, c := range sizeText {
					need(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F', 400, "Bad Request")
				}
				size, err := strconv.ParseUint(sizeText, 16, 64)
				need(err == nil && size <= maxBody && uint64(len(body))+size <= maxBody, 413, "Request too large")
				used += lineEnd + 2
				if size == 0 {
					for {
						e := bytes.Index(pending[used:], []byte("\r\n"))
						for e < 0 {
							if !readMore() {
								return
							}
							e = bytes.Index(pending[used:], []byte("\r\n"))
						}
						used += e + 2
						if e == 0 {
							break
						}
					}
					break
				}
				for len(pending)-used < int(size)+2 {
					if !readMore() {
						return
					}
				}
				need(bytes.Equal(pending[used+int(size):used+int(size)+2], []byte("\r\n")), 400, "Bad Request")
				body = append(body, pending[used:used+int(size)]...)
				used += int(size) + 2
			}
			req.body = body
		}
		// Packed objects may retain slices of the request. Give receive-pack its own
		// backing storage before the connection's input buffer is reused.
		if len(req.body) > 0 && strings.HasSuffix(req.path, "/git-receive-pack") {
			req.body = bytes.Clone(req.body)
		}
		s.mu.Lock()
		reply := s.handle(req)
		wire := s.encode(reply, frame.close)
		s.mu.Unlock()
		if _, err := c.Write(wire); err != nil {
			return
		}
		if frame.close {
			return
		}
		copy(pending, pending[used:])
		pending = pending[:len(pending)-used]
		if cap(pending) > 1024*1024 && len(pending) == 0 {
			pending = buffer[:0]
		}
	}
}
func (s *Server) serveTCP(listener net.Listener) error {
	for {
		c, err := listener.Accept()
		if err != nil {
			return err
		}
		if tcp, ok := c.(*net.TCPConn); ok {
			tcp.SetNoDelay(true)
		}
		go s.serveConn(c)
	}
}
