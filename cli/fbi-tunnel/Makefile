.PHONY: build test install clean

DIST := dist
BINARIES := \
  $(DIST)/fbi-tunnel-darwin-amd64 \
  $(DIST)/fbi-tunnel-darwin-arm64 \
  $(DIST)/fbi-tunnel-linux-amd64 \
  $(DIST)/fbi-tunnel-linux-arm64

build: $(BINARIES)

$(DIST)/fbi-tunnel-%:
	@mkdir -p $(DIST)
	GOOS=$(word 1,$(subst -, ,$*)) GOARCH=$(word 2,$(subst -, ,$*)) \
	  go build -trimpath -ldflags='-s -w' -o $@ .

test:
	go test ./...

install:
	go build -trimpath -ldflags='-s -w' -o $(HOME)/.local/bin/fbi-tunnel .

clean:
	rm -rf $(DIST)
