package main

import (
	"bytes"
	"compress/flate"
	"compress/zlib"
	"crypto/sha1"
	"encoding/binary"
	"encoding/hex"
	"hash"
	"hash/adler32"
	"io"
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
func appendPacket(out []byte, parts ...string) []byte {
	n := 4
	for _, part := range parts {
		n += len(part)
	}
	need(n <= 65520, 400, "Packet too large")
	const digits = "0123456789abcdef"
	out = append(out, digits[n>>12&15], digits[n>>8&15], digits[n>>4&15], digits[n&15])
	for _, part := range parts {
		out = append(out, part...)
	}
	return out
}
func packets(body []byte, stop bool) ([]string, int) { return packetsInto(body, stop, nil) }
func packetsInto(body []byte, stop bool, lines []string) (_ []string, offset int) {
	text := stringView(body)
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
		lines = append(lines, text[offset:offset+int(n)-4])
		offset += int(n) - 4
	}
	return lines, offset
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
	source  bytes.Reader
	reader  io.ReadCloser
	extra   [1]byte
	hasher  hash.Hash
	header  [96]byte
	digest  [20]byte
	encoded [40]byte
	objects []unpackedObject
	pending []pendingDelta
	offsets map[int]*Object
	staged  map[string]*Object
}
type unpackedObject struct {
	offset int
	oid    string
	object *Object
}

var inflaterPool = sync.Pool{New: func() any { return &packInflater{hasher: sha1.New()} }}

func (state *packInflater) objectID(kind string, data []byte) string {
	header := append(state.header[:0], kind...)
	header = append(header, ' ')
	header = strconv.AppendInt(header, int64(len(data)), 10)
	header = append(header, 0)
	state.hasher.Reset()
	state.hasher.Write(header)
	state.hasher.Write(data)
	state.hasher.Sum(state.digest[:0])
	hex.Encode(state.encoded[:], state.digest[:])
	return string(state.encoded[:])
}

// bytes.Reader implements io.ByteReader, so flate consumes exactly one stream and
// leaves the next packed object untouched. Reuse inflater state across requests.
func unpack(r *Repository, pack []byte) {
	need(len(pack) >= 32 && string(pack[:4]) == "PACK", 400, "Invalid pack header")
	version, count := binary.BigEndian.Uint32(pack[4:8]), binary.BigEndian.Uint32(pack[8:12])
	need((version == 2 || version == 3) && count < 1000000, 400, "Invalid pack version or count")
	end := len(pack) - 20
	sum := sha1.Sum(pack[:end])
	need(bytes.Equal(sum[:], pack[end:]), 400, "Pack checksum mismatch")
	pos := 12
	state := inflaterPool.Get().(*packInflater)
	indexed := false
	save := func(offset int, o *Object) {
		oid := state.objectID(o.kind, o.data)
		state.objects = append(state.objects, unpackedObject{offset, oid, o})
		if indexed {
			state.offsets[offset], state.staged[oid] = o, o
		}
	}
	read := func() byte { need(pos < end, 400, "Invalid packed object"); b := pack[pos]; pos++; return b }
	defer func() {
		if state.reader != nil {
			state.reader.Close()
		}
		state.source.Reset(nil)
		clear(state.objects)
		clear(state.pending)
		state.objects = state.objects[:0]
		state.pending = state.pending[:0]
		clear(state.offsets)
		clear(state.staged)
		if cap(state.objects) > 4096 {
			state.objects = nil
		}
		if cap(state.pending) > 4096 {
			state.pending = nil
		}
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
			baseOID = hexOID(pack[pos : pos+20])
			pos += 20
		} else {
			need(kind > 0 && kind < len(objectNames), 400, "Unknown pack object type")
		}
		need(pos < end && size <= 64*1024*1024, 400, "Invalid packed object")
		// Parse the small zlib envelope here and pool the flate reader directly.
		// zlib.Reset allocates a new digest for each stream; a single checksum of
		// the completed object also avoids digest/interface work on every Read.
		need(pos+2 <= end, 400, "Invalid compressed object")
		cmf, flags := pack[pos], pack[pos+1]
		need(cmf&15 == 8 && cmf>>4 <= 7 && (uint16(cmf)<<8|uint16(flags))%31 == 0, 400, "Invalid compressed object")
		pos += 2
		if flags&32 != 0 {
			need(pos+4 <= end && binary.BigEndian.Uint32(pack[pos:pos+4]) == 1, 400, "Invalid compressed dictionary")
			pos += 4
		}
		state.source.Reset(pack[pos:end])
		var err error
		if state.reader == nil {
			state.reader = flate.NewReader(&state.source)
		} else {
			err = state.reader.(flate.Resetter).Reset(&state.source, nil)
		}
		need(err == nil, 400, "Invalid compressed object")
		data := make([]byte, size)
		_, err = io.ReadFull(state.reader, data)
		need(err == nil || (size == 0 && err == io.EOF), 400, "Packed object size mismatch")
		n, err := state.reader.Read(state.extra[:])
		need(n == 0 && err == io.EOF, 400, "Invalid compressed object")
		pos = end - state.source.Len()
		need(pos+4 <= end && binary.BigEndian.Uint32(pack[pos:pos+4]) == adler32.Checksum(data), 400, "Invalid compressed checksum")
		pos += 4
		if kind == 6 || kind == 7 {
			state.pending = append(state.pending, pendingDelta{start, baseOffset, baseOID, data})
		} else {
			save(start, &Object{kind: objectNames[kind], data: data, packed: pack[start:pos]})
		}
	}
	need(pos == end, 400, "Extra pack data")
	// Ordinary packs need no temporary maps. Resolve small delta packs from the
	// reusable entry slice, and index larger packs once to bound lookup work.
	if len(state.pending) > 0 && count > 16 {
		if state.offsets == nil {
			state.offsets = map[int]*Object{}
			state.staged = map[string]*Object{}
		}
		indexed = true
		for _, o := range state.objects {
			state.offsets[o.offset], state.staged[o.oid] = o.object, o.object
		}
	}
	for len(state.pending) > 0 {
		progress := false
		for i := len(state.pending) - 1; i >= 0; i-- {
			p := state.pending[i]
			var base *Object
			if indexed {
				if p.baseOffset >= 0 {
					base = state.offsets[p.baseOffset]
				} else {
					base = state.staged[p.baseOID]
				}
			} else {
				for j := len(state.objects) - 1; j >= 0; j-- {
					o := state.objects[j]
					if p.baseOffset >= 0 && o.offset == p.baseOffset || p.baseOffset < 0 && o.oid == p.baseOID {
						base = o.object
						break
					}
				}
			}
			if base == nil && p.baseOffset < 0 {
				base = r.objects[p.baseOID]
			}
			if base == nil {
				continue
			}
			save(p.offset, &Object{kind: base.kind, data: deltaApply(base.data, p.data)})
			copy(state.pending[i:], state.pending[i+1:])
			state.pending[len(state.pending)-1] = pendingDelta{}
			state.pending = state.pending[:len(state.pending)-1]
			progress = true
		}
		need(progress, 400, "Missing delta base")
	}
	for _, o := range state.objects {
		if r.objects[o.oid] == nil {
			r.objects[o.oid] = o.object
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
	r.validationRun++
	run := r.validationRun
	pending := append(r.validationPending[:0], tips...)
	checked := r.validationChecked[:0]
	defer func() {
		clear(pending[:cap(pending)])
		clear(checked)
		r.validationPending = pending[:0]
		r.validationChecked = checked[:0]
	}()
	for len(pending) > 0 {
		oid := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		o := r.objects[oid]
		need(o != nil, 400, "Missing object")
		if o.valid || o.visit == run {
			continue
		}
		o.visit = run
		checked = append(checked, o)
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
	for _, o := range checked {
		o.valid = true
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

var v2AdvertisementReply = func() Reply {
	storage := make([]byte, 192+len(v2Advertisement))
	copy(storage[192:], v2Advertisement)
	return finishResponse(storage, 200, "application/x-git-upload-pack-advertisement")
}()

func advertise(r *Repository, service string, v2 bool) []byte {
	return advertisement(r, service, v2).data
}
func advertisement(r *Repository, service string, v2 bool) Reply {
	if service == "git-upload-pack" && v2 {
		return v2AdvertisementReply
	}
	if b := r.refResponses[service]; b.data != nil {
		return b
	}
	caps := "report-status side-band-64k delete-refs ofs-delta agent=forge/1"
	if service != "git-receive-pack" {
		caps = "multi_ack_detailed side-band-64k ofs-delta shallow symref=HEAD:refs/heads/" + r.branch + " agent=forge/1"
	}
	// Size once and append packets directly. The single-ref case needs neither
	// a sorted-key slice nor the temporary HEAD/ref list used by generic ls-refs.
	size := 4 + len("# service=\n") + len(service) + 4 + 4 + 1 + len(caps)
	head := r.resolve("")
	if head != "" {
		size += 4 + 40 + 1 + len("HEAD") + 1
	}
	for name, oid := range r.refs {
		size += 4 + 40 + 1 + len(name) + 1
		if peeled(r, oid) != "" {
			size += 4 + 40 + 1 + len(name) + 3 + 1
		}
	}
	if len(r.refs) == 0 && head == "" {
		size += 4 + 40 + len(" capabilities^{}\n")
	}
	out := make([]byte, 192, 192+size)
	out = appendPacket(out, "# service=", service, "\n")
	out = append(out, flush...)
	first := true
	add := func(name, oid string) {
		if first {
			out = appendPacket(out, oid, " ", name, "\x00", caps, "\n")
			first = false
		} else {
			out = appendPacket(out, oid, " ", name, "\n")
		}
		if peel := peeled(r, oid); peel != "" {
			out = appendPacket(out, peel, " ", name, "^{}\n")
		}
	}
	if head != "" {
		add("HEAD", head)
	}
	if len(r.refs) == 1 {
		for name, oid := range r.refs {
			add(name, oid)
		}
	} else {
		for _, name := range sortedKeys(r.refs) {
			add(name, r.refs[name])
		}
	}
	if first {
		out = appendPacket(out, zero, " capabilities^{}\x00", caps, "\n")
	}
	out = append(out, flush...)
	kind := "application/x-git-upload-pack-advertisement"
	if service == "git-receive-pack" {
		kind = "application/x-git-receive-pack-advertisement"
	}
	reply := finishResponse(out, 200, kind)
	r.refResponses[service] = reply
	return reply
}

func validOID(oid string) bool {
	if len(oid) != 40 {
		return false
	}
	for i := 0; i < len(oid); i++ {
		b := oid[i]
		if !(b >= '0' && b <= '9' || b >= 'a' && b <= 'f') {
			return false
		}
	}
	return true
}
func validRef(ref string) bool {
	if !strings.HasPrefix(ref, "refs/") {
		return false
	}
	for i := 0; i < len(ref); i++ {
		b := ref[i]
		if b <= ' ' || b == '~' || b == '^' || b == ':' || b == '?' || b == '*' || b == '[' || b == '\\' {
			return false
		}
	}
	return true
}

type receiveReportKey struct {
	side, unpackOK bool
	ref, reason    string
}

func receive(r *Repository, body []byte) []byte {
	var lineBuffer [1]string
	lines, offset := packetsInto(body, true, lineBuffer[:0])
	side := false
	if len(lines) > 0 {
		_, caps, _ := strings.Cut(lines[0], "\x00")
		side = strings.Contains(caps, "side-band-64k")
	}
	type command struct{ old, next, ref string }
	var commandBuffer [1]command
	commands := commandBuffer[:0]
	for _, line := range lines {
		line, _, _ = strings.Cut(line, "\x00")
		old, rest, _ := strings.Cut(strings.TrimSpace(line), " ")
		next, ref, _ := strings.Cut(rest, " ")
		ref, _, _ = strings.Cut(ref, " ")
		need(validOID(old) && validOID(next) && validRef(ref), 400, "Invalid ref command")
		commands = append(commands, command{old, next, ref})
	}
	var reasonBuffer [1]string
	reasons := reasonBuffer[:0]
	if len(commands) > cap(reasons) {
		reasons = make([]string, 0, len(commands))
	}
	reasons = reasons[:len(commands)]
	unpackOK := true
	func() {
		defer func() {
			if recover() != nil {
				unpackOK = false
				for i := range commands {
					reasons[i] = "unpacker error"
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
		var tipBuffer [1]string
		tips := tipBuffer[:0]
		for _, c := range commands {
			if c.next != zero {
				tips = append(tips, c.next)
			}
		}
		validateGraph(r, tips)
		for i, c := range commands {
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
			reasons[i] = reason
			if reason == "" {
				r.setRef(c.ref, c.next)
			}
		}
	}()
	key := receiveReportKey{side: side, unpackOK: unpackOK}
	if len(commands) == 1 {
		key.ref, key.reason = commands[0].ref, reasons[0]
	} else {
		var signature strings.Builder
		for i, c := range commands {
			signature.WriteString(c.ref)
			signature.WriteByte(0)
			signature.WriteString(reasons[i])
			signature.WriteByte(0)
		}
		key.ref = signature.String()
	}
	if b := r.receiveReports[key]; b != nil {
		return b
	}
	stream := make([]byte, 0, 64+len(commands)*64)
	if unpackOK {
		stream = appendPacket(stream, "unpack ok\n")
	} else {
		stream = appendPacket(stream, "unpack invalid pack\n")
	}
	for i, c := range commands {
		if reasons[i] == "" {
			stream = appendPacket(stream, "ok ", c.ref, "\n")
		} else {
			stream = appendPacket(stream, "ng ", c.ref, " ", reasons[i], "\n")
		}
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
	version := 0
	if v2 {
		version = 1
	}
	// A []byte-to-string map lookup borrows bytes for the lookup only. Copy a
	// key only on a miss, when the immutable response is installed in the cache.
	if b := r.fetchCache[version][string(body)]; b != nil {
		return b
	}
	if b := r.lsRefsCache[version][string(body)]; b != nil {
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
		if r.lsRefsCache[version] == nil {
			r.lsRefsCache[version] = map[string][]byte{}
		}
		if len(r.lsRefsCache[version]) > 64 {
			clear(r.lsRefsCache[version])
		}
		r.lsRefsCache[version][string(body)] = out
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
	if r.fetchCache[version] == nil {
		r.fetchCache[version] = map[string][]byte{}
	}
	if len(r.fetchCache[version]) > 64 {
		clear(r.fetchCache[version])
	}
	r.fetchCache[version][string(body)] = out
	return out
}
