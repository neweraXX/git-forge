package main

import (
	"strconv"
	"unicode/utf8"
)

// Append JSON strings with the same escaping as encoding/json with HTML escaping
// disabled, including malformed UTF-8 and the two JavaScript line separators.
func appendJSONString(dst []byte, s string) []byte {
	dst = append(dst, '"')
	start := 0
	const hex = "0123456789abcdef"
	for i := 0; i < len(s); {
		b := s[i]
		if b >= utf8.RuneSelf {
			r, n := utf8.DecodeRuneInString(s[i:])
			if r == utf8.RuneError && n == 1 {
				dst = append(dst, s[start:i]...)
				dst = append(dst, `\ufffd`...)
				i++
				start = i
				continue
			}
			if r == '\u2028' || r == '\u2029' {
				dst = append(dst, s[start:i]...)
				dst = append(dst, '\\', 'u', '2', '0', '2', hex[r&15])
				i += n
				start = i
				continue
			}
			i += n
			continue
		}
		if b >= 0x20 && b != '"' && b != '\\' {
			i++
			continue
		}
		dst = append(dst, s[start:i]...)
		switch b {
		case '"', '\\':
			dst = append(dst, '\\', b)
		case '\n':
			dst = append(dst, `\n`...)
		case '\r':
			dst = append(dst, `\r`...)
		case '\t':
			dst = append(dst, `\t`...)
		case '\b':
			dst = append(dst, `\b`...)
		case '\f':
			dst = append(dst, `\f`...)
		default:
			dst = append(dst, '\\', 'u', '0', '0', hex[b>>4], hex[b&15])
		}
		i++
		start = i
	}
	dst = append(dst, s[start:]...)
	return append(dst, '"')
}

func (s *Server) createdIssue(r *Repository, issue M) Reply {
	return s.serializeCreatedIssue(r, num(issue["id"]), num(issue["number"]), str(issue["node_id"]), str(issue["title"]), str(issue["body"]), arr(issue["labels"]))
}
func (s *Server) createdIssueRecord(r *Repository, issue *IssueRecord) Reply {
	return s.serializeCreatedIssue(r, issue.id, issue.number, issue.nodeID, issue.title, issue.body, issue.labels)
}
func (s *Server) serializeCreatedIssue(r *Repository, id, number int, nodeID, title, body string, labels []any) Reply {
	// The store retains ordinary issue records for all APIs. Serialize the creation
	// response without reflection or sorting and give the cached body its own bytes.
	out := append(s.scratch[:0], `{"body":`...)
	out = appendJSONString(out, body)
	out = append(out, `,"comments":0,"created_at":`...)
	out = appendJSONString(out, stamp)
	out = append(out, `,"id":`...)
	out = strconv.AppendInt(out, int64(id), 10)
	out = append(out, `,"labels":`...)
	if len(labels) == 0 {
		out = append(out, '[', ']')
	} else {
		out = append(out, jsonBytes(labels)...)
	}
	out = append(out, `,"node_id":`...)
	out = appendJSONString(out, nodeID)
	out = append(out, `,"number":`...)
	out = strconv.AppendInt(out, int64(number), 10)
	out = append(out, `,"state":"open","title":`...)
	out = appendJSONString(out, title)
	out = append(out, `,"updated_at":`...)
	out = appendJSONString(out, stamp)
	out = append(out, `,"user":`...)
	out = append(out, s.store.userJSON...)
	out = append(out, '}')
	// Reserve header space before the owned body. Both slices share one backing
	// allocation; creation replies are not installed in the generic wire cache.
	storage := make([]byte, 192+len(out))
	data := storage[192:]
	copy(data, out)
	reply := Reply{status: 201, data: data, contentType: "application/json; charset=utf-8"}
	var header [192]byte
	head := appendResponseHead(header[:0], reply, false)
	copy(storage[192-len(head):], head)
	reply.wire = storage[192-len(head):]
	r.issueBytes[number] = data
	if issue := r.issues[number]; issue != nil {
		issue.read = Reply{status: 200, data: data, contentType: reply.contentType}
	}
	s.scratch = out
	if cap(s.scratch) > 1024*1024 {
		s.scratch = nil
	}
	return reply
}
