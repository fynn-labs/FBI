import { useEffect, useState } from 'react';
import type { ShellHandle } from '../lib/ws.js';

interface Props {
  shell: ShellHandle;
  termCols: number;
  termRows: number;
  snapshotCols: number;
  snapshotRows: number;
  isFocused: boolean;
}

/**
 * Shown when this viewer's local terminal dims don't match the PTY's
 * actual dims AND this viewer isn't the one driving the PTY.
 *
 * Click "Take over" to send a focus event, which causes the server to
 * resize the PTY to this viewer's dims and broadcast a fresh snapshot
 * to all viewers.
 *
 * Banner is dismissible per session only — no localStorage. Reappears
 * on the next dim-mismatch transition (which is its own fresh event
 * the user might want to see).
 */
export function TerminalTakeoverBanner({
  shell,
  termCols,
  termRows,
  snapshotCols,
  snapshotRows,
  isFocused,
}: Props) {
  const [dismissed, setDismissed] = useState(false);
  const dimsMatch = termCols === snapshotCols && termRows === snapshotRows;
  const visible = !isFocused && !dimsMatch && !dismissed;

  // Reset dismissal when dims become matching again. The next mismatch
  // (e.g. a different viewer resizes) will show the banner afresh.
  useEffect(() => {
    if (dimsMatch) setDismissed(false);
  }, [dimsMatch]);

  if (!visible) return null;

  return (
    <div
      className="terminal-takeover-banner"
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
        padding: '0.4rem 0.75rem',
        fontSize: '0.85rem',
        background: '#fef3c7',  // amber-100
        borderBottom: '1px solid #fde68a',  // amber-200
        color: '#92400e',  // amber-800
      }}
    >
      <span style={{ flex: 1 }}>
        Showing terminal at {snapshotCols}×{snapshotRows} (driven by another viewer)
      </span>
      <button
        type="button"
        onClick={() => shell.sendFocus()}
        style={{
          padding: '0.25rem 0.6rem',
          fontSize: '0.85rem',
          background: '#fbbf24',
          border: '1px solid #f59e0b',
          borderRadius: '0.25rem',
          cursor: 'pointer',
        }}
      >
        Take over
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => setDismissed(true)}
        style={{
          background: 'transparent',
          border: 'none',
          fontSize: '1.1rem',
          lineHeight: 1,
          cursor: 'pointer',
          padding: '0 0.25rem',
        }}
      >
        ×
      </button>
    </div>
  );
}
