package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// stubServer answers the discovery API and a single proxy WS that echoes bytes.
func stubServer(t *testing.T) *httptest.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/runs/42/listening-ports", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		fmt.Fprint(w, `{"ports":[{"port":5173,"proto":"tcp"}]}`)
	})
	up := websocket.Upgrader{}
	mux.HandleFunc("/api/runs/42/proxy/5173", func(w http.ResponseWriter, r *http.Request) {
		ws, err := up.Upgrade(w, r, nil)
		if err != nil { t.Fatal(err) }
		defer ws.Close()
		for {
			_, msg, err := ws.ReadMessage()
			if err != nil { return }
			ws.WriteMessage(websocket.BinaryMessage, msg)
		}
	})
	return httptest.NewServer(mux)
}

func TestRun_discoversAndForwards(t *testing.T) {
	srv := stubServer(t)
	defer srv.Close()

	args := Args{FBIUrl: srv.URL, RunID: 42}
	logBuf := &strings.Builder{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var ports []Mapping
	var mu sync.Mutex
	onReady := func(m []Mapping) { mu.Lock(); ports = m; mu.Unlock() }

	done := make(chan error, 1)
	go func() { done <- run(ctx, args, logBuf, onReady) }()

	// Wait for ready.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock(); ok := len(ports) == 1; mu.Unlock()
		if ok { break }
		time.Sleep(20 * time.Millisecond)
	}
	mu.Lock(); ready := append([]Mapping(nil), ports...); mu.Unlock()
	if len(ready) != 1 || ready[0].Remote != 5173 {
		t.Fatalf("ready ports = %+v", ready)
	}

	// Connect to the local listener and exchange a byte.
	conn, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", ready[0].Local))
	if err != nil { t.Fatal(err) }
	if _, err := conn.Write([]byte("ping")); err != nil { t.Fatal(err) }
	buf := make([]byte, 4)
	if _, err := io.ReadFull(conn, buf); err != nil { t.Fatal(err) }
	if string(buf) != "ping" {
		t.Errorf("echo failed, got %q", string(buf))
	}
	conn.Close()

	cancel()
	<-done
}

func TestRun_exitsOn1001(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/runs/42/listening-ports", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		fmt.Fprint(w, `{"ports":[{"port":5173,"proto":"tcp"}]}`)
	})
	up := websocket.Upgrader{}
	mux.HandleFunc("/api/runs/42/proxy/5173", func(w http.ResponseWriter, r *http.Request) {
		ws, err := up.Upgrade(w, r, nil)
		if err != nil { t.Fatal(err) }
		defer ws.Close()
		// Wait briefly so the client has time to send a message, then close with 1001.
		ws.WriteControl(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseGoingAway, "run ended"),
			time.Now().Add(2*time.Second))
		time.Sleep(100 * time.Millisecond)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	args := Args{FBIUrl: srv.URL, RunID: 42}
	logBuf := &strings.Builder{}
	var ports []Mapping
	var mu sync.Mutex
	onReady := func(m []Mapping) { mu.Lock(); ports = m; mu.Unlock() }

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	done := make(chan error, 1)
	go func() { done <- run(ctx, args, logBuf, onReady) }()

	// Wait for the listener.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock(); ok := len(ports) == 1; mu.Unlock()
		if ok { break }
		time.Sleep(20 * time.Millisecond)
	}
	mu.Lock(); ready := append([]Mapping(nil), ports...); mu.Unlock()
	if len(ready) != 1 { t.Fatalf("ports = %+v", ready) }

	// Triggering a connection makes forwardConn run; the server immediately closes 1001.
	// Keep the TCP conn open so the local->ws goroutine doesn't win the done race with nil.
	conn, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", ready[0].Local))
	if err != nil { t.Fatal(err) }
	defer conn.Close()

	select {
	case err := <-done:
		if err != nil { t.Errorf("run returned error: %v", err) }
	case <-time.After(3 * time.Second):
		t.Fatal("run did not exit after 1001")
	}
	if !strings.Contains(logBuf.String(), "run 42 ended") {
		t.Errorf("log missing 'run 42 ended': %q", logBuf.String())
	}
}
