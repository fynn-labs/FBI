package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDiscover_ok(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/runs/42/listening-ports" {
			t.Errorf("bad path %s", r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		w.Write([]byte(`{"ports":[{"port":5173,"proto":"tcp"},{"port":9229,"proto":"tcp"}]}`))
	}))
	defer srv.Close()
	got, err := discoverPorts(srv.URL, 42)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(got) != 2 || got[0] != 5173 || got[1] != 9229 {
		t.Errorf("got %v", got)
	}
}

func TestDiscover_404(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"run not found"}`, 404)
	}))
	defer srv.Close()
	_, err := discoverPorts(srv.URL, 42)
	if err == nil || !strings.Contains(err.Error(), "404") {
		t.Errorf("expected 404 error, got %v", err)
	}
}

func TestDiscover_409(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"run is not running"}`, 409)
	}))
	defer srv.Close()
	_, err := discoverPorts(srv.URL, 42)
	if err == nil || !strings.Contains(err.Error(), "409") {
		t.Errorf("expected 409 error, got %v", err)
	}
}
