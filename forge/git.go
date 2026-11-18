package main

import (
	"bytes"
	"compress/zlib"
	"crypto/sha1"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

var objectNames = []string{"", "commit", "tree", "blob", "tag"}
var flush = []byte("0000")

func pkt(data []byte) []byte {
	need(len(data) <= 65516, 400, "Packet too large")
	out := make([]byte, len(data)+4)
	const digits = "0123456789abcdef"
	n := len(out)
	out[0] = digits[n>>12&15]
	out[1] = digits[n>>8&15]
	out[2] = digits[n>>4&15]
	out[3] = digits[n&15]
	copy(out[4:], data)
	return out
}
func packet(s string) []byte { return pkt([]byte(s)) }
func packets(body []byte, stop bool) (lines []string, offset int) {
	for offset < len(body) {
		need(offset+4 <= len(body), 400, "Invalid pkt-line")
		n, e := strconv.ParseUint(string(body[offset:offset+4]), 16, 16)
		need(e == nil, 400, "Invalid pkt-line")
		offset += 4
		if n == 0 {
			if stop {
				break
			}
			continue
		}
		if n == 1 || n == 2 {
			continue
		}
		need(n >= 4 && n <= 65520 && offset+int(n)-4 <= len(body), 400, "Truncated pkt-line")
		lines = append(lines, string(body[offset:offset+int(n)-4]))
		offset += int(n) - 4
	}
	return
}
func sideband(data []byte) []byte {
	out := make([]byte, len(data)+((len(data)+65514)/65515)*5+4)
	dest := 0
	const digits = "0123456789abcdef"
	for pos := 0; pos < len(data); pos += 65515 {
		end := pos + 65515
		if end > len(data) {
			end = len(data)
		}
		n := end - pos + 5
		out[dest] = digits[n>>12&15]
		out[dest+1] = digits[n>>8&15]
		out[dest+2] = digits[n>>4&15]
		out[dest+3] = digits[n&15]
		out[dest+4] = 1
		copy(out[dest+5:], data[pos:end])
		dest += n
	}
	copy(out[dest:], flush)
	return out
}
func deltaApply(base, delta []byte) []byte {
	pos := 0
	read := func() byte { need(pos < len(delta), 400, "Invalid delta size"); b := delta[pos]; pos++; return b }
	variable := func() int {
		value, scale := 0, 1
		for {
			need(scale <= 1<<49, 400, "Invalid delta size")
			b := read()
			value += int(b&127) * scale
			scale *= 128
			if b&128 == 0 {
				return value
			}
		}
	}
	need(variable() == len(base), 400, "Delta base size mismatch")
	size := variable()
	need(size <= 64*1024*1024, 400, "Delta too large")
	out := make([]byte, size)
	dest := 0
	for pos < len(delta) {
		op := read()
		need(op != 0, 400, "Invalid delta opcode")
		if op&128 != 0 {
			start, count := 0, 0
			for i := 0; i < 4; i++ {
				if op&(1<<i) != 0 {
					start += int(read()) << (i * 8)
				}
			}
			for i := 0; i < 3; i++ {
				if op&(1<<(i+4)) != 0 {
					count += int(read()) << (i * 8)
				}
			}
			if count == 0 {
				count = 65536
			}
			need(start+count <= len(base) && dest+count <= size, 400, "Delta copy out of range")
			copy(out[dest:], base[start:start+count])
			dest += count
		} else {
			n := int(op)
			need(pos+n <= len(delta) && dest+n <= size, 400, "Delta insert out of range")
			copy(out[dest:], delta[pos:pos+n])
			pos += n
			dest += n
		}
	}
	need(dest == size, 400, "Delta result size mismatch")
	return out
}

type pendingDelta struct {
	offset, baseOffset int
	baseOID            string
	data               []byte
}

type packInflater struct {
	source bytes.Reader
	reader io.ReadCloser
}

var inflaterPool = sync.Pool{New: func() any { return &packInflater{} }}

// bytes.Reader implements io.ByteReader, so zlib consumes exactly one stream and
// leaves the next packed object untouched. Reuse inflater state across requests.
func unpack(r *Repository, pack []byte) {
	need(len(pack) >= 32 && string(pack[:4]) == "PACK", 400, "Invalid pack header")
	version, count := binary.BigEndian.Uint32(pack[4:8]), binary.BigEndian.Uint32(pack[8:12])
	need((version == 2 || version == 3) && count < 1000000, 400, "Invalid pack version or count")
	end := len(pack) - 20
	sum := sha1.Sum(pack[:end])
	need(bytes.Equal(sum[:], pack[end:]), 400, "Pack checksum mismatch")
	pos := 12
	offsets := map[int]*Object{}
	staged := map[string]*Object{}
	pending := []pendingDelta{}
	save := func(offset int, o *Object) { offsets[offset] = o; staged[hashObject(o.kind, o.data)] = o }
	read := func() byte { need(pos < end, 400, "Invalid packed object"); b := pack[pos]; pos++; return b }
	state := inflaterPool.Get().(*packInflater)
	defer func() {
		if state.reader != nil {
			state.reader.Close()
		}
		state.source.Reset(nil)
		inflaterPool.Put(state)
	}()
	for i := uint32(0); i < count; i++ {
		start := pos
		b := read()
		size, scale := int(b&15), 16
		kind := int(b >> 4 & 7)
		for b&128 != 0 {
			b = read()
			size += int(b&127) * scale
			scale *= 128
			need(scale <= 1<<49, 400, "Object size overflow")
		}
		baseOffset := -1
		baseOID := ""
		if kind == 6 {
			b = read()
			distance := int(b & 127)
			for b&128 != 0 {
				b = read()
				distance = (distance+1)*128 + int(b&127)
				need(distance <= len(pack), 400, "Invalid packed object")
			}
			baseOffset = start - distance
		} else if kind == 7 {
			need(pos+20 <= end, 400, "Invalid packed object")
			baseOID = hex.EncodeToString(pack[pos : pos+20])
			pos += 20
		} else {
			need(kind > 0 && kind < len(objectNames), 400, "Unknown pack object type")
		}
		need(pos < end && size <= 64*1024*1024, 400, "Invalid packed object")
		state.source.Reset(pack[pos:end])
		var err error
		if state.reader == nil {
			state.reader, err = zlib.NewReader(&state.source)
		} else {
			err = state.reader.(zlib.Resetter).Reset(&state.source, nil)
		}
		need(err == nil, 400, "Invalid compressed object")
		data := make([]byte, size)
		_, err = io.ReadFull(state.reader, data)
		need(err == nil || (size == 0 && err == io.EOF), 400, "Packed object size mismatch")
		var extra [1]byte
		n, err := state.reader.Read(extra[:])
		need(n == 0 && err == io.EOF, 400, "Invalid compressed object")
		pos = end - state.source.Len()
		if kind == 6 || kind == 7 {
			pending = append(pending, pendingDelta{start, baseOffset, baseOID, data})
		} else {
			save(start, &Object{kind: objectNames[kind], data: data, packed: pack[start:pos]})
		}
	}
	need(pos == end, 400, "Extra pack data")
	for len(pending) > 0 {
		progress := false
		for i := len(pending) - 1; i >= 0; i-- {
			p := pending[i]
			var base *Object
			if p.baseOffset >= 0 {
				base = offsets[p.baseOffset]
			} else {
				base = staged[p.baseOID]
				if base == nil {
					base = r.objects[p.baseOID]
				}
			}
			if base == nil {
				continue
			}
			save(p.offset, &Object{kind: base.kind, data: deltaApply(base.data, p.data)})
			pending = append(pending[:i], pending[i+1:]...)
			progress = true
		}
		need(progress, 400, "Missing delta base")
	}
	for oid, o := range staged {
		if r.objects[oid] == nil {
			r.objects[oid] = o
		}
	}
}

type packDeflater struct {
	output bytes.Buffer
	writer *zlib.Writer
}

var deflaterPool = sync.Pool{New: func() any {
	state := &packDeflater{}
	state.writer, _ = zlib.NewWriterLevel(&state.output, 1)
	return state
}}

func packedObject(o *Object) []byte {
	if o.packed != nil {
		return o.packed
	}
	kind := 0
	for i, n := range objectNames {
		if n == o.kind {
			kind = i
		}
	}
	size := len(o.data)
	header := []byte{byte(kind<<4 | size&15)}
	size >>= 4
	for size > 0 {
		header[len(header)-1] |= 128
		header = append(header, byte(size&127))
		size >>= 7
	}
	state := deflaterPool.Get().(*packDeflater)
	state.output.Reset()
	state.output.Write(header)
	state.writer.Reset(&state.output)
	state.writer.Write(o.data)
	state.writer.Close()
	// The object owns these bytes; resetting the pooled output must not alter it.
	o.packed = bytes.Clone(state.output.Bytes())
	if state.output.Cap() > 1024*1024 {
		state.output = bytes.Buffer{}
	}
	deflaterPool.Put(state)
	return o.packed
}
func packObjects(r *Repository, ids []string) []byte {
	size := 12
	for _, oid := range ids {
		o := r.objects[oid]
		found(o != nil)
		size += len(packedObject(o))
	}
	body := make([]byte, size+20)
	copy(body, "PACK")
	binary.BigEndian.PutUint32(body[4:], 2)
	binary.BigEndian.PutUint32(body[8:], uint32(len(ids)))
	pos := 12
	for _, oid := range ids {
		pos += copy(body[pos:], r.objects[oid].packed)
	}
	sum := sha1.Sum(body[:size])
	copy(body[size:], sum[:])
	return body
}

type graphItem struct {
	oid        string
	generation int
}

func closure(r *Repository, tips []string, boundaries map[string]bool, depth int) ([]string, []string) {
	ids, shallow := []string{}, []string{}
	seen, shallows := map[string]bool{}, map[string]bool{}
	commitDepth := map[string]int{}
	queue := []graphItem{}
	for _, tip := range tips {
		queue = append(queue, graphItem{tip, 1})
	}
	for i := 0; i < len(queue); i++ {
		oid, g := queue[i].oid, queue[i].generation
		o := r.objects[oid]
		need(o != nil, 400, "Missing object")
		if seen[oid] && (o.kind != "commit" || commitDepth[oid] <= g) {
			continue
		}
		if !seen[oid] {
			ids = append(ids, oid)
			seen[oid] = true
		}
		switch o.kind {
		case "commit":
			commitDepth[oid] = g
			c := r.commit(oid)
			queue = append(queue, graphItem{c.tree, g})
			if g >= depth {
				if len(c.parents) > 0 && !shallows[oid] {
					shallow = append(shallow, oid)
					shallows[oid] = true
				}
			} else if !boundaries[oid] {
				for _, p := range c.parents {
					queue = append(queue, graphItem{p, g + 1})
				}
			}
		case "tree":
			for _, e := range r.tree(oid) {
				if e.mode != "160000" {
					queue = append(queue, graphItem{e.oid, g})
				}
			}
		case "tag":
			if target := peeled(r, oid); target != "" {
				queue = append(queue, graphItem{target, g})
			}
		}
	}
	return ids, shallow
}
func peeled(r *Repository, oid string) string {
	o := r.objects[oid]
	if o == nil || o.kind != "tag" {
		return ""
	}
	for _, line := range strings.Split(string(o.data), "\n") {
		if strings.HasPrefix(line, "object ") && len(line) >= 47 {
			return line[7:47]
		}
	}
	return ""
}
func validateGraph(r *Repository, tips []string) {
	pending := append([]string{}, tips...)
	checked := map[string]bool{}
	for len(pending) > 0 {
		oid := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		if r.validated[oid] || checked[oid] {
			continue
		}
		o := r.objects[oid]
		need(o != nil, 400, "Missing object")
		checked[oid] = true
		switch o.kind {
		case "commit":
			c := r.commit(oid)
			pending = append(pending, c.tree)
			pending = append(pending, c.parents...)
		case "tree":
			for _, e := range r.tree(oid) {
				if e.mode != "160000" {
					pending = append(pending, e.oid)
				}
			}
		case "tag":
			target := peeled(r, oid)
			need(target != "", 400, "Invalid tag target")
			pending = append(pending, target)
		}
	}
	for oid := range checked {
		r.validated[oid] = true
	}
}

type Ref struct{ name, oid string }

func refs(r *Repository) []Ref {
	list := []Ref{}
	if head := r.resolve(""); head != "" {
		list = append(list, Ref{"HEAD", head})
	}
	for _, name := range sortedKeys(r.refs) {
		list = append(list, Ref{name, r.refs[name]})
	}
	return list
}

var v2Advertisement = func() []byte {
	out := []byte{}
	for _, s := range []string{"version 2\n", "agent=forge/1\n", "ls-refs=unborn\n", "fetch=shallow\n", "object-format=sha1\n"} {
		out = append(out, packet(s)...)
	}
	return append(out, flush...)
}()

func advertise(r *Repository, service string, v2 bool) []byte {
	if service == "git-upload-pack" && v2 {
		return v2Advertisement
	}
	key := "advertise:" + service
	if b := r.refResponses[key]; b != nil {
		return b
	}
	caps := "report-status side-band-64k delete-refs ofs-delta agent=forge/1"
	if service != "git-receive-pack" {
		caps = "multi_ack_detailed side-band-64k ofs-delta shallow symref=HEAD:refs/heads/" + r.branch + " agent=forge/1"
	}
	out := append(packet("# service="+service+"\n"), flush...)
	list := refs(r)
	if len(list) == 0 {
		out = append(out, packet(zero+" capabilities^{}\x00"+caps+"\n")...)
	} else {
		for i, ref := range list {
			extra := ""
			if i == 0 {
				extra = "\x00" + caps
			}
			out = append(out, packet(ref.oid+" "+ref.name+extra+"\n")...)
			if peel := peeled(r, ref.oid); peel != "" {
				out = append(out, packet(peel+" "+ref.name+"^{}\n")...)
			}
		}
	}
	out = append(out, flush...)
	r.refResponses[key] = out
	return out
}

var oidPattern = regexp.MustCompile(`^[a-f0-9]{40}$`)
var badRef = regexp.MustCompile("[\x00-\x20~^:?*\\[\\\\]")

func receive(r *Repository, body []byte) []byte {
	lines, offset := packets(body, true)
	side := false
	if len(lines) > 0 {
		p := strings.SplitN(lines[0], "\x00", 2)
		side = len(p) > 1 && strings.Contains(p[1], "side-band-64k")
	}
	type command struct{ old, next, ref string }
	commands := []command{}
	for _, line := range lines {
		p := strings.Split(strings.TrimSpace(strings.SplitN(line, "\x00", 2)[0]), " ")
		need(len(p) >= 3 && oidPattern.MatchString(p[0]) && oidPattern.MatchString(p[1]) && strings.HasPrefix(p[2], "refs/") && !badRef.MatchString(p[2]), 400, "Invalid ref command")
		commands = append(commands, command{p[0], p[1], p[2]})
	}
	report := []string{}
	func() {
		defer func() {
			if recover() != nil {
				report = append(report, "unpack invalid pack\n")
				for _, c := range commands {
					report = append(report, "ng "+c.ref+" unpacker error\n")
				}
			}
		}()
		if len(body) > offset {
			unpack(r, body[offset:])
		} else {
			for _, c := range commands {
				need(c.next == zero, 400, "Missing pack")
			}
		}
		tips := []string{}
		for _, c := range commands {
			if c.next != zero {
				tips = append(tips, c.next)
			}
		}
		validateGraph(r, tips)
		report = append(report, "unpack ok\n")
		for _, c := range commands {
			current := r.refs[c.ref]
			if current == "" {
				current = zero
			}
			reason := ""
			if current != c.old {
				reason = "stale old object id"
			} else if c.next != zero && c.old != zero && !r.ancestor(c.old, c.next) {
				reason = "non-fast-forward"
			}
			if reason != "" {
				report = append(report, "ng "+c.ref+" "+reason+"\n")
			} else {
				r.setRef(c.ref, c.next)
				report = append(report, "ok "+c.ref+"\n")
			}
		}
	}()
	key := fmt.Sprintf("%t:%s", side, strings.Join(report, ""))
	if b := r.receiveReports[key]; b != nil {
		return b
	}
	stream := []byte{}
	for _, line := range report {
		stream = append(stream, packet(line)...)
	}
	stream = append(stream, flush...)
	if side {
		stream = sideband(stream)
	}
	if len(r.receiveReports) >= 64 {
		clear(r.receiveReports)
	}
	r.receiveReports[key] = stream
	return stream
}
func upload(r *Repository, body []byte, v2 bool) []byte {
	var key string
	if v2 {
		key = "2:" + string(body)
	} else {
		key = "0:" + string(body)
	}
	if b := r.fetchCache[key]; b != nil {
		return b
	}
	if b := r.refResponses[key]; b != nil {
		return b
	}
	lines, _ := packets(body, false)
	has := map[string]bool{}
	for i, line := range lines {
		lines[i] = strings.TrimSpace(line)
		has[lines[i]] = true
	}
	if has["command=ls-refs"] {
		prefixes := []string{}
		for _, l := range lines {
			if strings.HasPrefix(l, "ref-prefix ") {
				prefixes = append(prefixes, l[11:])
			}
		}
		out := []byte{}
		for _, ref := range refs(r) {
			match := len(prefixes) == 0
			for _, p := range prefixes {
				if strings.HasPrefix(ref.name, p) {
					match = true
				}
			}
			if !match {
				continue
			}
			extra := []string{}
			if ref.name == "HEAD" && has["symrefs"] {
				extra = append(extra, "symref-target:refs/heads/"+r.branch)
			}
			if p := peeled(r, ref.oid); p != "" && has["peel"] {
				extra = append(extra, "peeled:"+p)
			}
			text := ref.oid + " " + ref.name
			if len(extra) > 0 {
				text += " " + strings.Join(extra, " ")
			}
			out = append(out, packet(text+"\n")...)
		}
		out = append(out, flush...)
		if len(r.refResponses) > 64 {
			clear(r.refResponses)
		}
		r.refResponses[key] = out
		return out
	}
	wants, haves, boundaryOrder := []string{}, []string{}, []string{}
	boundaries := map[string]bool{}
	depth := int(^uint(0) >> 1)
	for _, l := range lines {
		p := strings.Split(l, " ")
		if len(p) < 2 {
			continue
		}
		switch p[0] {
		case "want":
			wants = append(wants, p[1])
		case "have":
			if r.objects[p[1]] != nil {
				haves = append(haves, p[1])
			}
		case "shallow":
			if !boundaries[p[1]] {
				boundaryOrder = append(boundaryOrder, p[1])
				boundaries[p[1]] = true
			}
		case "deepen":
			if n := num(p[1]); n != 0 {
				depth = n
			}
		}
	}
	wanted, shallow := closure(r, wants, nil, depth)
	held, _ := closure(r, haves, boundaries, int(^uint(0)>>1))
	exclude := map[string]bool{}
	for _, oid := range held {
		exclude[oid] = true
	}
	ids := []string{}
	for _, oid := range wanted {
		if !exclude[oid] {
			ids = append(ids, oid)
		}
	}
	out := []byte{}
	if v2 {
		if depth != int(^uint(0)>>1) {
			out = append(out, packet("shallow-info\n")...)
			shallowSet := map[string]bool{}
			for _, oid := range shallow {
				out = append(out, packet("shallow "+oid+"\n")...)
				shallowSet[oid] = true
			}
			for _, oid := range boundaryOrder {
				if !shallowSet[oid] {
					out = append(out, packet("unshallow "+oid+"\n")...)
				}
			}
			out = append(out, []byte("0001")...)
		}
		out = append(out, packet("packfile\n")...)
	} else {
		for _, oid := range shallow {
			out = append(out, packet("shallow "+oid+"\n")...)
		}
		if depth != int(^uint(0)>>1) {
			out = append(out, flush...)
		}
		out = append(out, packet("NAK\n")...)
	}
	out = append(out, sideband(packObjects(r, ids))...)
	if len(r.fetchCache) > 64 {
		clear(r.fetchCache)
	}
	r.fetchCache[key] = out
	return out
}
