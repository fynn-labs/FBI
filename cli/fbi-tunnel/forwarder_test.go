package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
)

func TestForwardConn_echo(t *testing.T) {
	upgrader := websocket.Upgrader{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/runs/42/proxy/") {
			t.Errorf("bad path %s", r.URL.Path)
		}
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil { t.Fatal(err) }
		defer ws.Close()
		for {
			_, msg, err := ws.ReadMessage()
			if err != nil { return }
			if err := ws.WriteMessage(websocket.BinaryMessage, msg); err != nil { return }
		}
	}))
	defer srv.Close()

	a, b := net.Pipe()
	defer a.Close(); defer b.Close()

	done := make(chan error, 1)
	go func() { done <- forwardConn(srv.URL, 42, 8000, b) }()

	if _, err := a.Write([]byte("hello")); err != nil { t.Fatal(err) }
	buf := make([]byte, 5)
	if _, err := a.Read(buf); err != nil { t.Fatal(err) }
	if string(buf) != "hello" {
		t.Errorf("got %q want hello", string(buf))
	}
	a.Close()
	<-done
}
