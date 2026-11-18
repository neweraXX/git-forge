package main

import (
	"encoding/json"
	"fmt"
	"go/format"
	"os"
	"path/filepath"
	"testing"
)

// Used through ./dock gotest to format authored source with the pinned toolchain.
func TestFormatSources(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	type change struct{ Path, Old, New string }
	changes := []change{}
	for _, path := range files {
		old, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		formatted, err := format.Source(old)
		if err != nil {
			t.Fatal(err)
		}
		if string(old) != string(formatted) {
			changes = append(changes, change{path, string(old), string(formatted)})
		}
	}
	if len(changes) > 0 {
		data, _ := json.Marshal(changes)
		fmt.Printf("FORGE_FORMAT:%s\n", data)
		t.Fail()
	}
}
