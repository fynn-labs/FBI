package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"sync"
	"syscall"
)

func main() {
	args, err := parseArgs(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, args, os.Stderr, func(m []Mapping) { printTable(args, m, os.Stdout) }); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// run wires the full CLI: discover, bind, accept, forward. onReady is called
// once with the final mappings after listeners are bound. Returns when ctx is
// cancelled or all listeners have failed.
func run(ctx context.Context, args Args, logger io.Writer, onReady func([]Mapping)) error {
	discovered, err := discoverPorts(args.FBIUrl, args.RunID)
	if err != nil {
		return fmt.Errorf("discovery failed: %w", err)
	}
	mappings := mergeMappings(discovered, args.Overrides)

	type bound struct {
		l       net.Listener
		mapping Mapping
	}
	bounds := make([]bound, 0, len(mappings))
	for i, m := range mappings {
		l, port, err := bindLocal(m.Local)
		if err != nil {
			fmt.Fprintf(logger, "bind failed for remote %d: %v\n", m.Remote, err)
			continue
		}
		mappings[i].Local = port
		bounds = append(bounds, bound{l: l, mapping: mappings[i]})
	}
	if len(bounds) == 0 {
		return fmt.Errorf("no listeners bound")
	}
	onReady(mappings)

	var wg sync.WaitGroup
	for _, b := range bounds {
		b := b
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer b.l.Close()
			for {
				conn, err := b.l.Accept()
				if err != nil { return }
				go func() {
					fmt.Fprintf(logger, "open  remote %d  from %s\n", b.mapping.Remote, conn.RemoteAddr())
					ferr := forwardConn(args.FBIUrl, args.RunID, b.mapping.Remote, conn)
					fmt.Fprintf(logger, "close remote %d  from %s  err=%v\n", b.mapping.Remote, conn.RemoteAddr(), ferr)
				}()
			}
		}()
	}

	<-ctx.Done()
	for _, b := range bounds { b.l.Close() }
	wg.Wait()
	return nil
}

func printTable(args Args, mappings []Mapping, w io.Writer) {
	fmt.Fprintf(w, "run %d → %s\n", args.RunID, args.FBIUrl)
	for _, m := range mappings {
		note := ""
		if m.Local != m.Remote {
			note = fmt.Sprintf("  (local %d was busy)", m.Remote)
		}
		fmt.Fprintf(w, "  remote %d  →  http://localhost:%d%s\n", m.Remote, m.Local, note)
	}
}
