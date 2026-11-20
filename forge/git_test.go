package main

import (
	"bytes"
	"compress/zlib"
	"crypto/sha1"
	"encoding/binary"
	"encoding/hex"
	"testing"
)

func testPack(entries ...[]byte) []byte {
	p := make([]byte, 12)
	copy(p, "PACK")
	binary.BigEndian.PutUint32(p[4:], 2)
	binary.BigEndian.PutUint32(p[8:], uint32(len(entries)))
	for _, e := range entries {
		p = append(p, e...)
	}
	sum := sha1.Sum(p)
	return append(p, sum[:]...)
}
func testEntry(kind byte, data, ref []byte) []byte {
	size := len(data)
	head := []byte{kind<<4 | byte(size&15)}
	for size >>= 4; size > 0; size >>= 7 {
		head[len(head)-1] |= 128
		head = append(head, byte(size&127))
	}
	var b bytes.Buffer
	b.Write(head)
	b.Write(ref)
	w := zlib.NewWriter(&b)
	w.Write(data)
	w.Close()
	return b.Bytes()
}
func rejected(t *testing.T, f func()) {
	t.Helper()
	defer func() {
		t.Helper()
		if recover() == nil {
			t.Fatal("expected rejection")
		}
	}()
	f()
}
func TestUnpackDeltas(t *testing.T) {
	base, target := []byte("hello world\n"), []byte("hello forge\n")
	delta := append([]byte{12, 12, 0x90, 6, 6}, []byte("forge\n")...)
	baseOID, targetOID := hashObject("blob", base), hashObject("blob", target)
	rawOID, _ := hex.DecodeString(baseOID)
	original, reference := testEntry(3, base, nil), testEntry(7, delta, rawOID)
	for _, mode := range []string{"reference", "offset", "thin", "forward"} {
		t.Run(mode, func(t *testing.T) {
			r := newRepository(1, M{"name": mode})
			var pack []byte
			switch mode {
			case "reference":
				pack = testPack(original, reference)
			case "offset":
				pack = testPack(original, testEntry(6, delta, []byte{byte(len(original))}))
			case "thin":
				r.put("blob", base)
				pack = testPack(reference)
			case "forward":
				pack = testPack(reference, original)
			}
			unpack(r, pack)
			if o := r.objects[targetOID]; o == nil || !bytes.Equal(o.data, target) {
				t.Fatal("delta target missing")
			}
		})
	}
}
func TestPackCorruptionAndRecovery(t *testing.T) {
	r := newRepository(1, M{"name": "validation"})
	good := testPack(testEntry(3, []byte("data"), nil))
	corrupt := bytes.Clone(good)
	corrupt[len(corrupt)-1] ^= 1
	rejected(t, func() { unpack(r, corrupt) })
	if len(r.objects) != 0 {
		t.Fatal("checksum failure installed objects")
	}
	for _, end := range []int{0, 12, len(good) - 1} {
		rejected(t, func() { unpack(r, good[:end]) })
	}
	badStream := bytes.Clone(good)
	badStream[15] ^= 255
	sum := sha1.Sum(badStream[:len(badStream)-20])
	copy(badStream[len(badStream)-20:], sum[:])
	rejected(t, func() { unpack(r, badStream) })
	if len(r.objects) != 0 {
		t.Fatal("inflation failure installed objects")
	}
	unpack(r, good)
	if len(r.objects) != 1 {
		t.Fatal("inflater failed to recover")
	}
	var n [20]byte
	rejected(t, func() { unpack(r, testPack(testEntry(7, []byte{0, 0}, n[:]))) })
}
func TestFetchBoundariesAndCaches(t *testing.T) {
	r := newRepository(1, M{"name": "history"})
	blob := r.put("blob", []byte("hello\n"))
	root := r.writeCommit(map[string]string{"a": blob}, nil, "root")
	tip := r.writeCommit(map[string]string{"a": blob}, []string{root}, "tip")
	r.setRef("refs/heads/main", tip)
	before := bytes.Clone(advertise(r, "git-upload-pack", false))
	ids, shallow := closure(r, []string{tip}, nil, 1)
	if len(ids) != 3 || len(shallow) != 1 || shallow[0] != tip {
		t.Fatal("depth-one closure")
	}
	held, _ := closure(r, []string{tip}, map[string]bool{tip: true}, 100)
	if len(held) != 3 {
		t.Fatal("shallow boundary followed a parent")
	}
	for _, v2 := range []bool{false, true} {
		request := append(packet("want "+tip+"\n"), packet("deepen 1\n")...)
		request = append(request, flush...)
		first := upload(r, request, v2)
		if !bytes.Equal(first, upload(r, request, v2)) || !bytes.Contains(first, []byte("shallow "+tip)) {
			t.Fatal("fetch cache or shallow response")
		}
	}
	r.setRef("refs/heads/main", root)
	if bytes.Equal(before, advertise(r, "git-upload-pack", false)) {
		t.Fatal("stale advertisement")
	}
}

func TestPackedBytesSurviveCompressorReuse(t *testing.T) {
	r := newRepository(1, M{"name": "compression"})
	first := r.put("blob", bytes.Repeat([]byte("first object\n"), 1000))
	original := bytes.Clone(packedObject(r.objects[first]))
	for _, size := range []int{0, 1, 100, 10000, 2 * 1024 * 1024} {
		data := bytes.Repeat([]byte("second\n"), size)
		oid := r.put("blob", data)
		pack := packObjects(r, []string{oid})
		other := newRepository(2, M{"name": "round-trip"})
		unpack(other, pack)
		if !bytes.Equal(other.objects[oid].data, data) {
			t.Fatal("pooled compressor round trip")
		}
		if !bytes.Equal(r.objects[first].packed, original) {
			t.Fatal("compressor reused object-owned bytes")
		}
	}
}

func TestSidebandFrameBoundaries(t *testing.T) {
	for _, size := range []int{0, 1, 65514, 65515, 65516, 131030, 131031} {
		data := bytes.Repeat([]byte{42}, size)
		wire := sideband(data)
		lines, offset := packets(wire, false)
		var decoded []byte
		for _, line := range lines {
			if len(line) == 0 || line[0] != 1 {
				t.Fatal("sideband channel")
			}
			decoded = append(decoded, []byte(line[1:])...)
		}
		if offset != len(wire) || !bytes.Equal(decoded, data) {
			t.Fatalf("sideband size %d", size)
		}
	}
}

func TestValidationScratchRecoversAfterMissingObject(t *testing.T) {
	r := newRepository(1, M{"name": "recover"})
	data := []byte("tree " + zero + "\n\nmissing tree\n")
	tip := r.put("commit", data)
	rejected(t, func() { validateGraph(r, []string{tip}) })
	if r.objects[tip].valid {
		t.Fatal("failed traversal validated a partial graph")
	}
	r.objects[zero] = &Object{kind: "tree", data: nil}
	validateGraph(r, []string{tip})
	if !r.objects[tip].valid || !r.objects[zero].valid {
		t.Fatal("validation did not recover")
	}
}

func TestReceiveReportCacheChecksEveryPush(t *testing.T) {
	r := newRepository(1, M{"name": "reports"})
	blob := r.put("blob", []byte("content"))
	tip := r.writeCommit(map[string]string{"file": blob}, nil, "root")
	ids, _ := closure(r, []string{tip}, nil, 100)
	pack := packObjects(r, ids)
	push := func(old, next string, p []byte) []byte {
		body := append(packet(old+" "+next+" refs/heads/main\x00report-status\n"), flush...)
		return receive(r, append(body, p...))
	}
	good := bytes.Clone(push(zero, tip, pack))
	if !bytes.Contains(good, []byte("ok refs/heads/main")) {
		t.Fatal("first push failed")
	}
	stale := push(zero, tip, pack)
	if !bytes.Contains(stale, []byte("ng refs/heads/main stale old object id")) {
		t.Fatal("cached success bypassed stale ref check")
	}
	broken := bytes.Clone(pack)
	broken[len(broken)-1] ^= 1
	if result := push(tip, tip, broken); !bytes.Contains(result, []byte("unpack invalid pack")) {
		t.Fatal("cached success bypassed checksum")
	}
	if result := push(tip, tip, pack); !bytes.Equal(result, good) {
		t.Fatal("cached verdict did not recover after rejection")
	}
}
