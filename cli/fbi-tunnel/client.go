package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type discoveryResp struct {
	Ports []struct {
		Port  int    `json:"port"`
		Proto string `json:"proto"`
	} `json:"ports"`
}

func discoverPorts(baseUrl string, runId int) ([]int, error) {
	url := fmt.Sprintf("%s/api/runs/%d/listening-ports", strings.TrimRight(baseUrl, "/"), runId)
	c := &http.Client{Timeout: 10 * time.Second}
	resp, err := c.Get(url)
	if err != nil {
		return nil, fmt.Errorf("GET %s: %w", url, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("server returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var out discoveryResp
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("parse response: %w", err)
	}
	ports := make([]int, 0, len(out.Ports))
	for _, p := range out.Ports {
		ports = append(ports, p.Port)
	}
	return ports, nil
}
