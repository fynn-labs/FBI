# Clipboard Portal: Container → User Clipboard

**Date:** 2026-04-24  
**Status:** Approved

## Problem

Tools running inside FBI Docker containers (e.g. `pbcopy`, `xclip`, `xsel`) attempt to write to the clipboard but fail silently — there is no X display or macOS clipboard available inside the container. The user never receives the data.

## Solution: OSC 52 via the existing terminal stream

OSC 52 is a standard terminal escape sequence (`\033]52;c;<base64data>\007`) that instructs a terminal emulator to write data to the host clipboard. Since the container's terminal output already flows over the existing xterm.js WebSocket stream, no new infrastructure is needed.

## Architecture

```
tool (pbcopy/xclip/xsel) in container
  → shim reads stdin
  → writes OSC 52 to /dev/tty
  → PTY carries escape sequence to server
  → WebSocket delivers bytes to browser
  → xterm.js OSC 52 handler fires
  → writeToClipboard() utility
      → Tauri: @tauri-apps/plugin-clipboard-manager writeText()
      → Browser: navigator.clipboard.writeText()
```

## Components

### 1. Container shims (`src/server/orchestrator/Dockerfile.tmpl`)

Three shell scripts installed to `/usr/local/bin/`, overriding the system commands:

**`pbcopy`**
```sh
#!/bin/sh
data=$(cat | base64 | tr -d '\n')
printf '\033]52;c;%s\007' "$data" > /dev/tty
```

**`xclip`** — ignores all flags; reads from stdin:
```sh
#!/bin/sh
data=$(cat | base64 | tr -d '\n')
printf '\033]52;c;%s\007' "$data" > /dev/tty
```

**`xsel`** — ignores all flags; reads from stdin:
```sh
#!/bin/sh
data=$(cat | base64 | tr -d '\n')
printf '\033]52;c;%s\007' "$data" > /dev/tty
```

All three scripts:
- Write to `/dev/tty`, not stdout, so they are safe inside pipelines
- Exit 0 unconditionally (callers expect silent success)
- Are marked executable (`chmod +x`)

### 2. Shared clipboard utility (`src/web/lib/clipboard.ts`)

```ts
export async function writeToClipboard(text: string): Promise<void> {
  if ('__TAURI_INTERNALS__' in window) {
    const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
    await writeText(text);
  } else {
    await navigator.clipboard.writeText(text);
  }
}
```

- Tauri path: uses native OS clipboard, no browser permission required
- Browser path: uses `navigator.clipboard.writeText()` — works on localhost and HTTPS; requires page focus

### 3. xterm.js OSC 52 handler (`src/web/components/Terminal.tsx`)

Changes to the `Xterm` instantiation block:

1. Add `allowProposedApi: true` to `Xterm` options (required to access `term.parser`)
2. After `term.open(host)`, register the handler:

```ts
term.parser.registerOscHandler(52, (data: string) => {
  const semicolon = data.indexOf(';');
  if (semicolon === -1) return false;
  const b64 = data.slice(semicolon + 1);
  if (!b64 || b64 === '?') return true; // read request — ignore
  try {
    const text = atob(b64);
    void writeToClipboard(text);
  } catch {
    // malformed base64 — ignore
  }
  return true; // consume the sequence
});
```

The handler returns `true` to consume the sequence so xterm does not attempt default processing.

### 4. Tauri plugin (`desktop/`)

**`desktop/Cargo.toml`** — add to `[dependencies]`:
```toml
tauri-plugin-clipboard-manager = "2"
```

**`desktop/src/main.rs`** — register the plugin in the builder chain:
```rust
.plugin(tauri_plugin_clipboard_manager::init())
```

**`package.json`** (root) — add to `dependencies`:
```json
"@tauri-apps/plugin-clipboard-manager": "^2"
```

## Data flow detail

1. Tool calls `pbcopy` (or `xclip -selection clipboard`, etc.)
2. Shim reads all stdin, base64-encodes it (no line breaks), prints OSC 52 to `/dev/tty`
3. The PTY carries the escape sequence through the existing WebSocket path unchanged
4. xterm.js parser intercepts OSC 52 before rendering — the user never sees escape characters
5. Handler decodes the base64 payload and calls `writeToClipboard(text)`
6. On Tauri: `tauri-plugin-clipboard-manager` writes to the native OS clipboard synchronously
7. On browser: `navigator.clipboard.writeText()` writes asynchronously (requires page focus; on failure, silently no-ops)

## Error handling

- Malformed base64 in OSC 52: caught and silently ignored — no visible effect
- `navigator.clipboard` unavailable (HTTP, no focus): promise rejection is swallowed — tool exits 0, user gets no clipboard write. Acceptable for v1; a visual "copied" toast is out of scope.
- `/dev/tty` unavailable in container: `printf` fails silently — tool exits 0

## Out of scope

- Visual toast notification on successful clipboard write
- Read requests (OSC 52 `?` payload) — handler ignores them
- `xclip -o` / `xsel -o` clipboard-read requests (shims always read stdin; read mode would hang — irrelevant since there is no container clipboard to read from anyway)
- `clip.exe` shim (Windows containers not currently used)
- Clipboard read from host into container
