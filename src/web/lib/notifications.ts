let unread = 0;
const origTitle = typeof document !== 'undefined' ? document.title : 'FBI';
let faviconLink: HTMLLinkElement | null = null;

function getFaviconLink(): HTMLLinkElement | null {
  if (faviconLink) return faviconLink;
  faviconLink = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  return faviconLink;
}

function drawFaviconWithDot(color: string): string {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 32;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#111827';
  ctx.fillRect(0, 0, 32, 32);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(22, 10, 7, 0, Math.PI * 2);
  ctx.fill();
  return c.toDataURL('image/png');
}

export async function ensurePermission(): Promise<NotificationPermission> {
  if (typeof Notification === 'undefined') return 'denied';
  if (Notification.permission === 'default') {
    return Notification.requestPermission();
  }
  return Notification.permission;
}

export async function notifyComplete(run: {
  id: number;
  state: 'succeeded' | 'failed' | 'cancelled';
  project_name?: string;
}): Promise<void> {
  const color =
    run.state === 'succeeded' ? '#22c55e' :
    run.state === 'failed'    ? '#ef4444' :
    '#9ca3af';
  const label = `${run.state === 'succeeded' ? '✓' : run.state === 'failed' ? '✗' : '⊘'} Run #${run.id}`;

  const perm = await ensurePermission();
  if (perm === 'granted') {
    new Notification(label, {
      body: run.project_name ? `Project: ${run.project_name}` : 'Run finished',
      tag: `fbi-run-${run.id}`,
    });
  }

  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
    unread += 1;
    document.title = `(${unread}) ${origTitle}`;
  }

  const link = getFaviconLink();
  if (link) link.href = drawFaviconWithDot(color);
}

export function installFocusReset(): () => void {
  if (typeof document === 'undefined') return () => {};
  const handler = () => {
    if (document.visibilityState === 'visible') {
      unread = 0;
      document.title = origTitle;
      const link = getFaviconLink();
      if (link) link.href = '/favicon.ico';
    }
  };
  document.addEventListener('visibilitychange', handler);
  window.addEventListener('focus', handler);
  return () => {
    document.removeEventListener('visibilitychange', handler);
    window.removeEventListener('focus', handler);
  };
}
