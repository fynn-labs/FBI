package main

import (
	"reflect"
	"testing"
)

func TestParseArgs_minimum(t *testing.T) {
	got, err := parseArgs([]string{"http://x:3000", "42"})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	want := Args{FBIUrl: "http://x:3000", RunID: 42, Overrides: nil}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v want %+v", got, want)
	}
}

func TestParseArgs_overrides(t *testing.T) {
	got, err := parseArgs([]string{
		"http://x:3000", "42",
		"-L", "5173:5173", "-L", "8080:9229",
	})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	want := Args{
		FBIUrl: "http://x:3000", RunID: 42,
		Overrides: []Override{{Local: 5173, Remote: 5173}, {Local: 8080, Remote: 9229}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v want %+v", got, want)
	}
}

func TestParseArgs_errors(t *testing.T) {
	cases := [][]string{
		{},                                  // missing url+id
		{"http://x"},                        // missing id
		{"http://x", "abc"},                 // non-numeric id
		{"http://x", "42", "-L"},            // -L missing value
		{"http://x", "42", "-L", "abc"},     // -L bad format
		{"http://x", "42", "-L", "5173:0"},  // remote out of range
		{"http://x", "42", "-L", "0:5173"},  // local out of range
	}
	for _, c := range cases {
		if _, err := parseArgs(c); err == nil {
			t.Errorf("parseArgs(%v) expected error, got nil", c)
		}
	}
}
