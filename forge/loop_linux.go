package main

import (
	"bytes"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

// The loop owns every store mutation and response cache. All descriptors are
// nonblocking; raw read/write syscalls never hand the goroutine to the scheduler.
type loopConn struct {
	fd                      int
	input, output, lastHead []byte
	request                 Request
	frame                   framing
	headEnd                 int
	lastRequest             Request
	closing                 bool
	eof, writing            bool
	touched                 int64
}

func loopListener() (int, int, error) {
	fd, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_STREAM|syscall.SOCK_NONBLOCK|syscall.SOCK_CLOEXEC, 0)
	if err != nil {
		return -1, 0, err
	}
	fail := func(err error) (int, int, error) { syscall.Close(fd); return -1, 0, err }
	if err = syscall.SetsockoptInt(fd, syscall.SOL_SOCKET, syscall.SO_REUSEADDR, 1); err != nil {
		return fail(err)
	}
	if err = syscall.Bind(fd, &syscall.SockaddrInet4{}); err != nil {
		return fail(err)
	}
	if err = syscall.Listen(fd, 256); err != nil {
		return fail(err)
	}
	addr, err := syscall.Getsockname(fd)
	if err != nil {
		return fail(err)
	}
	return fd, addr.(*syscall.SockaddrInet4).Port, nil
}
func rawRead(fd int, b []byte) (int, syscall.Errno) {
	n, _, e := syscall.RawSyscall(syscall.SYS_READ, uintptr(fd), uintptr(unsafe.Pointer(&b[0])), uintptr(len(b)))
	return int(n), e
}
func rawWrite(fd int, b []byte) (int, syscall.Errno) {
	n, _, e := syscall.RawSyscall(syscall.SYS_WRITE, uintptr(fd), uintptr(unsafe.Pointer(&b[0])), uintptr(len(b)))
	return int(n), e
}
func (c *loopConn) next() (req Request, used int, close, complete bool) {
	if c.headEnd == 0 {
		end := bytes.Index(c.input, []byte("\r\n\r\n"))
		if end < 0 {
			need(len(c.input) <= 65536, 400, "Bad Request")
			return
		}
		c.headEnd = end + 4
		head := c.input[:c.headEnd]
		if c.lastHead != nil && bytes.Equal(head, c.lastHead) {
			c.request = c.lastRequest
			c.frame = framing{}
		} else {
			c.request, c.frame = parseHeaders(head)
			if c.request.method == "GET" && !c.frame.close && !c.frame.chunked && c.frame.length == 0 {
				c.lastHead = append(c.lastHead[:0], head...)
				c.lastRequest = c.request
			} else {
				c.lastHead = nil
			}
		}
	}
	req = c.request
	f := c.frame
	used = c.headEnd
	close = f.close
	if f.expect {
		c.output = append(c.output, []byte("HTTP/1.1 100 Continue\r\n\r\n")...)
		c.frame.expect = false
	}
	if !f.chunked {
		if len(c.input) < used+f.length {
			return req, 0, close, false
		}
		req.body = c.input[used : used+f.length]
		used += f.length
	} else {
		body := []byte{}
		for {
			end := bytes.Index(c.input[used:], []byte("\r\n"))
			if end < 0 {
				return req, 0, close, false
			}
			text := strings.SplitN(string(c.input[used:used+end]), ";", 2)[0]
			need(text != "", 400, "Bad Request")
			for _, b := range text {
				need(b >= '0' && b <= '9' || b >= 'a' && b <= 'f' || b >= 'A' && b <= 'F', 400, "Bad Request")
			}
			n, err := strconv.ParseUint(text, 16, 64)
			need(err == nil && n <= maxBody && uint64(len(body))+n <= maxBody, 413, "Request too large")
			used += end + 2
			if n == 0 {
				for {
					end = bytes.Index(c.input[used:], []byte("\r\n"))
					if end < 0 {
						return req, 0, close, false
					}
					used += end + 2
					if end == 0 {
						break
					}
				}
				break
			}
			if len(c.input)-used < int(n)+2 {
				return req, 0, close, false
			}
			need(bytes.Equal(c.input[used+int(n):used+int(n)+2], []byte("\r\n")), 400, "Bad Request")
			body = append(body, c.input[used:used+int(n)]...)
			used += int(n) + 2
		}
		req.body = body
	}
	if len(req.body) > 0 && strings.HasSuffix(req.path, "/git-receive-pack") {
		req.body = bytes.Clone(req.body)
	}
	return req, used, close, true
}
func (s *Server) processLoop(c *loopConn) {
	defer func() {
		if e := recover(); e != nil {
			status, message := 400, "Bad Request"
			if f, ok := e.(failure); ok {
				status, message = f.status, f.message
			}
			r := jsonReply(status, M{"message": message})
			r.contentType = "application/json"
			c.output = s.encode(r, true)
			c.closing = true
		}
	}()
	if len(c.output) > 0 {
		return
	}
	if len(c.input) == 0 {
		return
	}
	req, used, close, complete := c.next()
	if !complete {
		return
	}
	reply := s.handle(req)
	wire := s.encode(reply, close)
	if len(c.output) == 0 {
		c.output = wire
	} else {
		c.output = append(c.output, wire...)
	}
	c.closing = close
	c.headEnd = 0
	copy(c.input, c.input[used:])
	c.input = c.input[:len(c.input)-used]
	if cap(c.input) > 1024*1024 && len(c.input) == 0 {
		c.input = make([]byte, 0, 16384)
	}
}
func (s *Server) serveLoop(listener int) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	epfd, err := syscall.EpollCreate1(syscall.EPOLL_CLOEXEC)
	if err != nil {
		return err
	}
	defer syscall.Close(epfd)
	defer syscall.Close(listener)
	if err = syscall.EpollCtl(epfd, syscall.EPOLL_CTL_ADD, listener, &syscall.EpollEvent{Events: syscall.EPOLLIN, Fd: int32(listener)}); err != nil {
		return err
	}
	connections := map[int]*loopConn{}
	drop := func(fd int) {
		syscall.EpollCtl(epfd, syscall.EPOLL_CTL_DEL, fd, nil)
		syscall.Close(fd)
		delete(connections, fd)
	}
	defer func() {
		for fd := range connections {
			drop(fd)
		}
	}()
	events := make([]syscall.EpollEvent, 256)
	lastSweep := time.Now().Unix()
	for {
		n, err := syscall.EpollWait(epfd, events, 1000)
		if err == syscall.EINTR {
			continue
		}
		if err != nil {
			return err
		}
		now := time.Now().Unix()
		for _, event := range events[:n] {
			fd := int(event.Fd)
			if fd == listener {
				for {
					accepted, _, e := syscall.Accept4(listener, syscall.SOCK_NONBLOCK|syscall.SOCK_CLOEXEC)
					if e == syscall.EAGAIN {
						break
					}
					if e == syscall.EINTR {
						continue
					}
					if e != nil {
						return e
					}
					syscall.SetsockoptInt(accepted, syscall.IPPROTO_TCP, syscall.TCP_NODELAY, 1)
					connections[accepted] = &loopConn{fd: accepted, input: make([]byte, 0, 16384), touched: now}
					if e = syscall.EpollCtl(epfd, syscall.EPOLL_CTL_ADD, accepted, &syscall.EpollEvent{Events: syscall.EPOLLIN | syscall.EPOLLRDHUP, Fd: int32(accepted)}); e != nil {
						drop(accepted)
					}
				}
				continue
			}
			c := connections[fd]
			if c == nil {
				continue
			}
			c.touched = now
			dead := event.Events&syscall.EPOLLERR != 0
			if event.Events&syscall.EPOLLIN != 0 && !dead {
				for {
					if len(c.input) == cap(c.input) {
						size := cap(c.input) * 2
						if size > maxBody+65536 {
							size = maxBody + 65536
						}
						if size <= len(c.input) {
							dead = true
							break
						}
						b := make([]byte, len(c.input), size)
						copy(b, c.input)
						c.input = b
					}
					read, e := rawRead(fd, c.input[len(c.input):cap(c.input)])
					if e == syscall.EAGAIN {
						break
					}
					if e == syscall.EINTR {
						continue
					}
					if e != 0 {
						dead = true
						break
					}
					if read == 0 {
						c.eof = true
						break
					}
					c.input = c.input[:len(c.input)+read]
				}
			}
			if dead {
				drop(fd)
				continue
			}
			for {
				if len(c.output) == 0 {
					s.processLoop(c)
				}
				if len(c.output) == 0 {
					break
				}
				written, e := rawWrite(fd, c.output)
				if e == syscall.EINTR {
					continue
				}
				if e == syscall.EAGAIN {
					break
				}
				if e != 0 {
					dead = true
					break
				}
				c.output = c.output[written:]
				if len(c.output) > 0 {
					break
				}
				if c.closing {
					dead = true
					break
				}
			}
			if dead {
				drop(fd)
				continue
			}
			flags := uint32(syscall.EPOLLIN | syscall.EPOLLRDHUP)
			if c.eof && len(c.output) == 0 {
				drop(fd)
				continue
			}
			if len(c.output) > 0 {
				flags = uint32(syscall.EPOLLOUT | syscall.EPOLLRDHUP)
			}
			writing := len(c.output) > 0
			if writing != c.writing {
				c.writing = writing
				if err = syscall.EpollCtl(epfd, syscall.EPOLL_CTL_MOD, fd, &syscall.EpollEvent{Events: flags, Fd: int32(fd)}); err != nil {
					drop(fd)
				}
			}
		}
		if now-lastSweep >= 30 {
			for fd, c := range connections {
				if now-c.touched >= 60 {
					drop(fd)
				}
			}
			lastSweep = now
		}
	}
}
