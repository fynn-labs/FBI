package main

import (
	"fmt"
	"io"
	"net"
	"net/url"
	"strings"

	"github.com/gorilla/websocket"
)

func wsUrl(baseUrl string) (string, error) {
	u, err := url.Parse(strings.TrimRight(baseUrl, "/"))
	if err != nil { return "", err }
	switch u.Scheme {
	case "http":  u.Scheme = "ws"
	case "https": u.Scheme = "wss"
	case "ws", "wss": // already
	default: return "", fmt.Errorf("unsupported scheme %q", u.Scheme)
	}
	return u.String(), nil
}

func forwardConn(baseUrl string, runId int, remotePort int, local net.Conn) error {
	wsBase, err := wsUrl(baseUrl)
	if err != nil { return err }
	dialUrl := fmt.Sprintf("%s/api/runs/%d/proxy/%d", wsBase, runId, remotePort)
	ws, _, err := websocket.DefaultDialer.Dial(dialUrl, nil)
	if err != nil { return fmt.Errorf("ws dial: %w", err) }
	defer ws.Close()

	done := make(chan error, 2)

	// local -> ws
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, err := local.Read(buf)
			if n > 0 {
				if werr := ws.WriteMessage(websocket.BinaryMessage, buf[:n]); werr != nil {
					done <- werr; return
				}
			}
			if err != nil {
				if err == io.EOF { done <- nil; return }
				done <- err; return
			}
		}
	}()

	// ws -> local
	go func() {
		for {
			_, msg, err := ws.ReadMessage()
			if err != nil {
				done <- err; return
			}
			if _, werr := local.Write(msg); werr != nil {
				done <- werr; return
			}
		}
	}()

	err = <-done
	ws.Close()
	local.Close()
	<-done
	return err
}
