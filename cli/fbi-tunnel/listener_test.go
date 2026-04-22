package main

import (
	"net"
	"testing"
)

func TestBindLocal_takesPreferred(t *testing.T) {
	l, port, err := bindLocal(0) // 0 = let kernel pick a free port
	if err != nil { t.Fatal(err) }
	defer l.Close()
	if port <= 0 { t.Errorf("port not set: %d", port) }
}

func TestBindLocal_fallsBackOnCollision(t *testing.T) {
	// Hold a port to force a collision.
	hold, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil { t.Fatal(err) }
	defer hold.Close()
	taken := hold.Addr().(*net.TCPAddr).Port

	l, port, err := bindLocal(taken)
	if err != nil { t.Fatal(err) }
	defer l.Close()
	if port == taken {
		t.Errorf("expected fallback to a different port, got the same: %d", port)
	}
	if port <= 0 {
		t.Errorf("invalid port: %d", port)
	}
}
