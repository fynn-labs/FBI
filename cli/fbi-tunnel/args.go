package main

import (
	"fmt"
	"strconv"
	"strings"
)

type Override struct {
	Local  int
	Remote int
}

type Args struct {
	FBIUrl    string
	RunID     int
	Overrides []Override
}

func parseArgs(argv []string) (Args, error) {
	if len(argv) < 2 {
		return Args{}, fmt.Errorf("usage: fbi-tunnel <fbi-url> <run-id> [-L localport:remoteport]...")
	}
	out := Args{FBIUrl: argv[0]}
	id, err := strconv.Atoi(argv[1])
	if err != nil {
		return Args{}, fmt.Errorf("invalid run id %q", argv[1])
	}
	out.RunID = id
	for i := 2; i < len(argv); i++ {
		switch argv[i] {
		case "-L":
			if i+1 >= len(argv) {
				return Args{}, fmt.Errorf("-L requires a value")
			}
			ov, err := parseLFlag(argv[i+1])
			if err != nil {
				return Args{}, err
			}
			out.Overrides = append(out.Overrides, ov)
			i++
		default:
			return Args{}, fmt.Errorf("unknown argument %q", argv[i])
		}
	}
	return out, nil
}

func parseLFlag(v string) (Override, error) {
	parts := strings.SplitN(v, ":", 2)
	if len(parts) != 2 {
		return Override{}, fmt.Errorf("-L must be localport:remoteport, got %q", v)
	}
	local, err := strconv.Atoi(parts[0])
	if err != nil || local <= 0 || local > 65535 {
		return Override{}, fmt.Errorf("invalid local port in %q", v)
	}
	remote, err := strconv.Atoi(parts[1])
	if err != nil || remote <= 0 || remote > 65535 {
		return Override{}, fmt.Errorf("invalid remote port in %q", v)
	}
	return Override{Local: local, Remote: remote}, nil
}
