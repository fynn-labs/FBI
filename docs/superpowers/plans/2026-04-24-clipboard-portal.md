# Clipboard Portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transparently bridge clipboard writes from `pbcopy`/`xclip`/`xsel` inside Docker containers to the user's real OS clipboard, via OSC 52 escape sequences through the existing xterm.js terminal stream.

**Architecture:** Container shim scripts intercept clipboard commands and emit OSC 52 (`\033]52;c;<base64data>\007`) to the PTY. The existing WebSocket terminal stream carries the escape sequence to xterm.js in the browser, which fires a registered OSC 52 handler. The handler decodes the payload and writes to clipboard via `navigator.clipboard` (browser) or `@tauri-apps/plugin-clipboard-manager` (Tauri desktop).

**Tech Stack:** Shell scripts (container shims), xterm.js `term.parser.registerOscHandler`, React/TypeScript (Terminal.tsx), Tauri 2 (`tauri-plugin-clipboard-manager`)

---

## File Map

| File | Change |
|------|--------|
| `src/web/lib/clipboard.ts` | **Create** — isomorphic clipboard write utility |
| `src/web/lib/clipboard.test.ts` | **Create** — unit tests for clipboard utility |
| `src/web/components/Terminal.tsx` | **Modify** — add `allowProposedApi: true` + OSC 52 handler |
| `src/web/components/Terminal.test.tsx` | **Modify** — update FakeTerm mock; add OSC 52 handler tests |
| `src/server/orchestrator/Dockerfile.tmpl` | **Modify** — add pbcopy/xclip/xsel shim scripts |
| `desktop/Cargo.toml` | **Modify** — add `tauri-plugin-clipboard-manager = "2"` |
| `desktop/src/main.rs` | **Modify** — register clipboard plugin |
| `desktop/capabilities/default.json` | **Modify** — add `clipboard-manager:allow-write-text` permission |
| `package.json` | **Modify** — add `@tauri-apps/plugin-clipboard-manager` |

---

## Task 1: Clipboard utility

**Files:**
- Create: `src/web/lib/clipboard.ts`
- Create: `src/web/lib/clipboard.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/web/lib/clipboard.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
}));

describe('writeToClipboard', () => {
  let mockWriteText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockWriteText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: mockWriteText },
      writable: true,
      configurable: true,
    });
    // @ts-expect-error
    delete window.__TAURI_INTERNALS__;
    vi.resetModules();
  });

  afterEach(() => {
    // @ts-expect-error
    delete window.__TAURI_INTERNALS__;
  });

  it('calls navigator.clipboard.writeText in browser context', async () => {
    const { writeToClipboard } = await import('./clipboard.js');
    await writeToClipboard('hello world');
    expect(mockWriteText).toHaveBeenCalledWith('hello world');
  });

  it('calls navigator.clipboard.writeText with empty string', async () => {
    const { writeToClipboard } = await import('./clipboard.js');
    await writeToClipboard('');
    expect(mockWriteText).toHaveBeenCalledWith('');
  });

  it('calls tauri-plugin-clipboard-manager writeText in Tauri context', async () => {
    const tauriMock = await import('@tauri-apps/plugin-clipboard-manager');
    const tauriWriteText = vi.mocked(tauriMock.writeText);
    tauriWriteText.mockResolvedValue(undefined);
    // @ts-expect-error
    window.__TAURI_INTERNALS__ = {};
    const { writeToClipboard } = await import('./clipboard.js');
    await writeToClipboard('tauri text');
    expect(tauriWriteText).toHaveBeenCalledWith('tauri text');
    expect(mockWriteText).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test -- clipboard.test
```

Expected: 3 failures — `Cannot find module './clipboard.js'`

- [ ] **Step 3: Create the clipboard utility**

Create `src/web/lib/clipboard.ts`:

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

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm test -- clipboard.test
```

Expected: 3 passed

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: no errors (the `@tauri-apps/plugin-clipboard-manager` types are not available yet — they'll be added in Task 4; ignore that specific missing-module error for now)

- [ ] **Step 6: Commit**

```bash
git add src/web/lib/clipboard.ts src/web/lib/clipboard.test.ts
git commit -m "feat: add isomorphic writeToClipboard utility (OSC 52 step 1/4)"
```

---

## Task 2: OSC 52 handler in Terminal.tsx

**Files:**
- Modify: `src/web/components/Terminal.tsx:108-124`
- Modify: `src/web/components/Terminal.test.tsx`

- [ ] **Step 1: Update the FakeTerm mock to capture OSC handlers**

In `src/web/components/Terminal.test.tsx`, locate the `vi.mock('@xterm/xterm', ...)` block (lines 34–48) and replace the entire `FakeTerm` class with this version that adds `parser`:

```tsx
const oscHandlers = new Map<number, (data: string) => boolean>();

vi.mock('@xterm/xterm', () => {
  class FakeTerm {
    cols = 120; rows = 40;
    options: Record<string, unknown> = {};
    buffer = { active: { baseY: 100, viewportY: 100 } };
    parser = {
      registerOscHandler: vi.fn((code: number, handler: (data: string) => boolean) => {
        oscHandlers.set(code, handler);
        return { dispose: vi.fn() };
      }),
    };
    open() {}
    loadAddon() {}
    onScroll(cb: () => void) { (FakeTerm as unknown as { __scrollCbs: Array<() => void> }).__scrollCbs = [cb]; return { dispose() {} }; }
    dispose() {}
    focus() {}
    write() {}
    reset() {}
  }
  return { Terminal: FakeTerm };
});
```

Also add `beforeEach(() => oscHandlers.clear());` inside the `describe('Terminal', ...)` block.

- [ ] **Step 2: Write failing tests for the OSC 52 handler**

Add these three tests inside the existing `describe('Terminal', ...)` block in `Terminal.test.tsx`:

```tsx
it('registers an OSC 52 handler on mount', () => {
  render(<Terminal runId={1} interactive={false} />);
  expect(oscHandlers.has(52)).toBe(true);
});

it('OSC 52 handler decodes UTF-8 base64 and writes to navigator.clipboard', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    writable: true,
    configurable: true,
  });
  render(<Terminal runId={2} interactive={false} />);
  const handler = oscHandlers.get(52)!;

  // UTF-8 encode "héllo" then base64 it (matches what the container shim does)
  const bytes = new TextEncoder().encode('héllo');
  const b64 = btoa(String.fromCharCode(...bytes));
  handler(`c;${b64}`);

  await vi.waitFor(() => {
    expect(writeText).toHaveBeenCalledWith('héllo');
  });
});

it('OSC 52 handler ignores read requests (? payload) and returns true', () => {
  render(<Terminal runId={3} interactive={false} />);
  const handler = oscHandlers.get(52)!;
  const result = handler('c;?');
  expect(result).toBe(true);
});

it('OSC 52 handler ignores malformed base64 without throwing', () => {
  render(<Terminal runId={4} interactive={false} />);
  const handler = oscHandlers.get(52)!;
  expect(() => handler('c;!!!not-valid-base64!!!')).not.toThrow();
});
```

- [ ] **Step 3: Run tests to confirm they fail**

```bash
npm test -- Terminal.test
```

Expected: 4 new failures — `oscHandlers.has(52)` returns false (handler not yet registered)

- [ ] **Step 4: Add the OSC 52 handler to Terminal.tsx**

In `src/web/components/Terminal.tsx`:

Add the import at the top of the file (after the existing imports):

```tsx
import { writeToClipboard } from '../lib/clipboard.js';
```

Change the `new Xterm({...})` options block (line 108) to add `allowProposedApi: true`:

```tsx
const term = new Xterm({
  allowProposedApi: true,
  convertEol: true,
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  fontSize: 13,
  theme: readTheme(),
  cursorBlink: false,
  scrollback: 1_000_000,
});
```

After `term.open(host);` (line 124), add the OSC 52 handler registration:

```tsx
const oscDisposable = term.parser.registerOscHandler(52, (data: string) => {
  const semicolon = data.indexOf(';');
  if (semicolon === -1) return false;
  const b64 = data.slice(semicolon + 1);
  if (!b64 || b64 === '?') return true;
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const text = new TextDecoder().decode(bytes);
    void writeToClipboard(text);
  } catch {
    // malformed base64 — ignore
  }
  return true;
});
```

In the cleanup `return () => { ... }` (around line 203), add before `term.dispose()`:

```tsx
oscDisposable.dispose();
```

- [ ] **Step 5: Run tests to confirm they pass**

```bash
npm test -- Terminal.test
```

Expected: all tests pass (including the 4 new ones)

- [ ] **Step 6: Typecheck**

```bash
npm run typecheck
```

Expected: no new errors

- [ ] **Step 7: Commit**

```bash
git add src/web/components/Terminal.tsx src/web/components/Terminal.test.tsx
git commit -m "feat: register OSC 52 handler in xterm to write to clipboard (step 2/4)"
```

---

## Task 3: Container clipboard shims

**Files:**
- Modify: `src/server/orchestrator/Dockerfile.tmpl`

No automated tests possible for this task — verify manually after Task 4 is complete.

- [ ] **Step 1: Add shim scripts to Dockerfile.tmpl**

In `src/server/orchestrator/Dockerfile.tmpl`, append the following after the existing `RUN apt-get ...` layer:

```dockerfile
# Clipboard shims: forward pbcopy/xclip/xsel stdin to the host via OSC 52
# (terminal clipboard protocol). The escape sequence rides the existing PTY
# stream; xterm.js picks it up and writes to the user's real clipboard.
RUN { \
    echo '#!/bin/sh'; \
    echo "data=\$(cat | base64 | tr -d '\\n')"; \
    echo "printf '\\033]52;c;%s\\007' \"\$data\" >/dev/tty"; \
    } > /usr/local/bin/pbcopy && \
    cp /usr/local/bin/pbcopy /usr/local/bin/xclip && \
    cp /usr/local/bin/pbcopy /usr/local/bin/xsel && \
    chmod +x /usr/local/bin/pbcopy /usr/local/bin/xclip /usr/local/bin/xsel
```

- [ ] **Step 2: Verify the script content looks correct**

```bash
# Build a test image from the template to inspect the shim
docker build --build-arg BUILDKIT_INLINE_CACHE=1 \
  --build-arg BASE_IMAGE=ubuntu:24.04 \
  -f <(sed 's/__BASE_IMAGE__/ubuntu:24.04/;s/__APT_PACKAGES__//;s/__ENV_EXPORTS__//' \
       src/server/orchestrator/Dockerfile.tmpl) \
  -t fbi-clipboard-test . 2>/dev/null || true
docker run --rm fbi-clipboard-test cat /usr/local/bin/pbcopy
```

Expected output:
```
#!/bin/sh
data=$(cat | base64 | tr -d '\n')
printf '\033]52;c;%s\007' "$data" >/dev/tty
```

(If docker is unavailable in this environment, skip and trust the echo lines are correct — they will be verified in the end-to-end test.)

- [ ] **Step 3: Commit**

```bash
git add src/server/orchestrator/Dockerfile.tmpl
git commit -m "feat: add OSC 52 clipboard shims for pbcopy/xclip/xsel (step 3/4)"
```

---

## Task 4: Tauri clipboard plugin

**Files:**
- Modify: `package.json`
- Modify: `desktop/Cargo.toml:13-20`
- Modify: `desktop/src/main.rs:8-11`
- Modify: `desktop/capabilities/default.json`

- [ ] **Step 1: Add the JS package**

```bash
npm install @tauri-apps/plugin-clipboard-manager@^2
```

Verify `package.json` now contains `"@tauri-apps/plugin-clipboard-manager": "^2.x.x"` in `dependencies`.

- [ ] **Step 2: Add the Rust crate**

In `desktop/Cargo.toml`, add to the `[dependencies]` section (after `tauri-plugin-updater = "2"`):

```toml
tauri-plugin-clipboard-manager = "2"
```

- [ ] **Step 3: Register the plugin in main.rs**

In `desktop/src/main.rs`, add the plugin registration after the existing `.plugin(tauri_plugin_updater::Builder::new().build())` line:

```rust
.plugin(tauri_plugin_clipboard_manager::init())
```

The full builder chain should look like:

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_store::Builder::default().build())
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_clipboard_manager::init())
    .invoke_handler(tauri::generate_handler![
        config::get_server_url,
        config::set_server_url,
        tray::update_tray_runs,
        tray::notify,
        discovery::discover_servers,
    ])
    // ... rest unchanged
```

- [ ] **Step 4: Add the capability permission**

In `desktop/capabilities/default.json`, add `"clipboard-manager:allow-write-text"` to the `permissions` array:

```json
{
  "$schema": "https://schema.tauri.app/config/2/capability",
  "identifier": "default",
  "description": "Default capability for FBI desktop",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "store:allow-load",
    "store:allow-get",
    "store:allow-set",
    "store:allow-save",
    "notification:allow-show",
    "notification:allow-is-permission-granted",
    "notification:allow-request-permission",
    "clipboard-manager:allow-write-text"
  ]
}
```

- [ ] **Step 5: Check Rust compiles**

```bash
cd desktop && cargo check 2>&1
```

Expected: no errors (warnings about unused imports are fine)

- [ ] **Step 6: Run full test suite**

```bash
cd /workspace && npm test
```

Expected: all tests pass

- [ ] **Step 7: Typecheck**

```bash
npm run typecheck
```

Expected: no errors (the `@tauri-apps/plugin-clipboard-manager` types are now available)

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json desktop/Cargo.toml desktop/Cargo.lock desktop/src/main.rs desktop/capabilities/default.json
git commit -m "feat: wire Tauri clipboard-manager plugin for OSC 52 desktop support (step 4/4)"
```

---

## End-to-End Verification

Once all four tasks are committed and a new container image is built:

1. Start FBI with `bash scripts/dev.sh`
2. Create a new run
3. In the terminal, run: `echo "clipboard test 123" | pbcopy`
4. Paste somewhere — you should see `clipboard test 123`
5. Repeat with: `echo "xclip test" | xclip -selection clipboard`
6. Repeat with: `echo "xsel test" | xsel --clipboard --input`
7. In the Tauri desktop app, repeat steps 3–6 and verify clipboard writes without any browser permission prompt
