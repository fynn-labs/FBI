.PHONY: build test install clean

DIST := dist
TARGETS := \
  aarch64-apple-darwin \
  x86_64-apple-darwin \
  x86_64-unknown-linux-gnu \
  aarch64-unknown-linux-gnu

build:
	@mkdir -p $(DIST)
	@for target in $(TARGETS); do \
	  echo "building $$target..."; \
	  cargo build --release --target $$target; \
	  cp target/$$target/release/fbi-tunnel $(DIST)/fbi-tunnel-$$target; \
	done

test:
	cargo test

install:
	cargo install --path . --force

clean:
	rm -rf $(DIST)
