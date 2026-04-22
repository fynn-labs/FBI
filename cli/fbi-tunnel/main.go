package main

import (
	"fmt"
	"os"
)

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "usage: fbi-tunnel <fbi-url> <run-id> [-L localport:remoteport]...")
		os.Exit(2)
	}
	fmt.Println("fbi-tunnel scaffold")
}
