package main

import (
	"encoding/json"
	"unicode/utf8"
)

// Recognize the common string-only issue shape in one pass. Everything else,
// including malformed JSON, falls back to encoding/json and normal validation.
// Owned values survive reuse of the transport input buffer.
func simpleIssueInput(data []byte) (title, body string, valid bool) {
	p := 0
	space := func() {
		for p < len(data) && (data[p] == ' ' || data[p] == '\t' || data[p] == '\r' || data[p] == '\n') {
			p++
		}
	}
	readString := func(own bool) (string, bool) {
		if p >= len(data) || data[p] != '"' {
			return "", false
		}
		start := p
		p++
		simple := true
		for p < len(data) {
			b := data[p]
			p++
			if b == '"' {
				if simple {
					if own {
						return string(data[start+1 : p-1]), true
					}
					return stringView(data[start+1 : p-1]), true
				}
				var value string
				if json.Unmarshal(data[start:p], &value) != nil {
					return "", false
				}
				return value, true
			}
			if b < 0x20 {
				return "", false
			}
			if b >= utf8.RuneSelf {
				simple = false
			}
			if b == '\\' {
				simple = false
				if p >= len(data) {
					return "", false
				}
				p++
			}
		}
		return "", false
	}
	space()
	if p >= len(data) || data[p] != '{' {
		return "", "", false
	}
	p++
	hasTitle := false
	for {
		space()
		key, ok := readString(false)
		if !ok || (key != "title" && key != "body") {
			return "", "", false
		}
		space()
		if p >= len(data) || data[p] != ':' {
			return "", "", false
		}
		p++
		space()
		value, ok := readString(true)
		if !ok {
			return "", "", false
		}
		if key == "title" {
			title, hasTitle = value, true
		} else {
			body = value
		}
		space()
		if p >= len(data) {
			return "", "", false
		}
		b := data[p]
		p++
		if b == '}' {
			space()
			return title, body, hasTitle && p == len(data)
		}
		if b != ',' {
			return "", "", false
		}
	}
}
