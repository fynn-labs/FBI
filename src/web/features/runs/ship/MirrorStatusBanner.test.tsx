import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MirrorStatusBanner } from './MirrorStatusBanner.js';

describe('MirrorStatusBanner', () => {
  it('renders nothing when status is not "diverged"', () => {
    const { container } = render(
      <MirrorStatusBanner status="ok" baseBranch="feat/x" runId={1} onRebase={vi.fn()} onStop={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });
  it('renders with actions when status is "diverged"', () => {
    const onRebase = vi.fn(); const onStop = vi.fn();
    render(<MirrorStatusBanner status="diverged" baseBranch="feat/x" runId={1} onRebase={onRebase} onStop={onStop} />);
    expect(screen.getByText(/Mirror to/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /rebase/i }));
    expect(onRebase).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /stop mirroring/i }));
    expect(onStop).toHaveBeenCalled();
  });
});
