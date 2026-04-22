package main

import (
	"fmt"
	"net"
)

func bindLocal(preferred int) (net.Listener, int, error) {
	if preferred > 0 {
		l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", preferred))
		if err == nil {
			return l, preferred, nil
		}
		// fall through to random
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil { return nil, 0, err }
	port := l.Addr().(*net.TCPAddr).Port
	return l, port, nil
}
