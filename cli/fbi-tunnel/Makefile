.PHONY: build test install clean dist

DIST := dist
OUT ?= $(DIST)
VERSION ?= dev
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

dist:
	@mkdir -p $(OUT)
	@for os in darwin linux; do \
	  for arch in amd64 arm64; do \
	    CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch \
	      go build -trimpath -ldflags="-s -w -X main.version=$(VERSION)" \
	      -o $(OUT)/fbi-tunnel-$$os-$$arch . ; \
	  done ; \
	done

test:
	go test ./...

install:
	go build -trimpath -ldflags='-s -w' -o $(HOME)/.local/bin/fbi-tunnel .

clean:
	rm -rf $(DIST)
