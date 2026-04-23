import type Docker from 'dockerode';
import { dockerExec } from './dockerExec.js';
import type {
  FilesPayload, FilesDirtyEntry, FilesHeadEntry, FileStatus,
} from '../../shared/types.js';

export interface GitStateWatcherOptions {
  container: Docker.Container;
  defaultBranch: string;
  pollMs?: number;
  onSnapshot: (s: FilesPayload) => void;
  onError?: (reason: string) => void;
}

export class GitStateWatcher {
  private opts: Required<Omit<GitStateWatcherOptions, 'onError'>> & { onError: (reason: string) => void };
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private ticking = false;

  constructor(opts: GitStateWatcherOptions) {
    this.opts = { pollMs: 2000, onError: () => { /* */ }, ...opts };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = async (): Promise<void> => {
      if (!this.running) return;
      if (!this.ticking) {
        this.ticking = true;
        try { await this.once(); }
        catch (e) { this.opts.onError(String(e)); }
        finally { this.ticking = false; }
      }
      if (this.running) this.timer = setTimeout(tick, this.opts.pollMs);
    };
    this.timer = setTimeout(tick, 0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  private async once(): Promise<void> {
    const c = this.opts.container;
    const db = this.opts.defaultBranch;
    // Use unique markers between sections so we can split one script output
    // into five pieces. Script tolerates git errors (empty repo, no HEAD, no
    // remote) by swallowing them — the parser handles empty sections.
    const script = [
      'set +e',
      'cd /workspace || exit 0',
      'printf "__Z__"; git status --porcelain=v1 -z 2>/dev/null',
      'printf "__NS__"; git diff --numstat HEAD 2>/dev/null',
      'printf "__LG__"; git log -1 --format=%H%x00%s 2>/dev/null',
      'printf "__SH__"; git show --numstat --format= HEAD 2>/dev/null',
      `printf "__AB__"; git rev-list --left-right --count refs/remotes/origin/${db}...HEAD 2>/dev/null`,
      `printf "__SM_STATUS__"; git submodule status 2>/dev/null`,
      `printf "__SM_INFO__"; git config --file .gitmodules --get-regexp '^submodule\\..*\\.\\(path\\|url\\)$' 2>/dev/null`,
      'exit 0',
    ].join('; ');
    const r = await dockerExec(c, ['bash', '-lc', script], { timeoutMs: 5000 });
    const parts = splitMarkers(r.stdout, ['__Z__', '__NS__', '__LG__', '__SH__', '__AB__', '__SM_STATUS__', '__SM_INFO__']);
    const payload = parseGitState({
      zlist: parts['__Z__'] ?? '',
      numstat: parts['__NS__'] ?? '',
      log: parts['__LG__'] ?? '',
      show: parts['__SH__'] ?? '',
      aheadBehind: parts['__AB__'] ?? '',
      base: this.opts.defaultBranch,
    });
    const rawSubs = parseSubmoduleStatus(
      parts['__SM_STATUS__'] ?? '',
      parts['__SM_INFO__'] ?? '',
    );
    const dirtySubmodules: import('../../shared/types.js').SubmoduleDirty[] = rawSubs.map((s) => ({
      path: s.path,
      url: s.url,
      dirty: [],
      unpushed_commits: [],
      unpushed_truncated: false,
    }));
    this.opts.onSnapshot({ ...payload, live: true, dirty_submodules: dirtySubmodules });
  }
}

function splitMarkers(s: string, markers: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  let rest = s;
  for (let i = 0; i < markers.length; i++) {
    const m = markers[i];
    const idx = rest.indexOf(m);
    if (idx < 0) continue;
    const after = rest.slice(idx + m.length);
    const next = markers.slice(i + 1)
      .map((m2) => after.indexOf(m2))
      .filter((n) => n >= 0);
    const end = next.length ? Math.min(...next) : after.length;
    out[m] = after.slice(0, end);
    rest = after;
  }
  return out;
}

export interface ParseInput {
  zlist: string;
  numstat: string;
  log: string;
  show: string;
  aheadBehind: string;
  base?: string;
}

export function parseGitState(in_: ParseInput): Omit<FilesPayload, 'live'> {
  // porcelain v1 -z: NUL-separated records, each "<XY> <path>". Renames add
  // an extra NUL-separated "from" path we skip.
  const byPath = new Map<string, { status: FileStatus; adds: number; dels: number }>();
  const records = in_.zlist.split('\0').filter((s) => s.length > 0);
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec.length < 3) continue;
    const code = rec.slice(0, 2);
    const path = rec.slice(3);
    const status = mapPorcelain(code);
    byPath.set(path, { status, adds: 0, dels: 0 });
    // Rename/copy: the next record is the "from" path; skip it.
    if (code[0] === 'R' || code[0] === 'C') i++;
  }
  for (const line of in_.numstat.split('\n')) {
    if (!line) continue;
    const [a, d, p] = line.split('\t');
    const row = byPath.get(p);
    if (!row) continue;
    row.adds = a === '-' ? 0 : Number.parseInt(a, 10) || 0;
    row.dels = d === '-' ? 0 : Number.parseInt(d, 10) || 0;
  }
  const dirty: FilesDirtyEntry[] = Array.from(byPath.entries()).map(([path, r]) => ({
    path, status: r.status, additions: r.adds, deletions: r.dels,
  }));

  // log -1 --format=%H%x00%s: <sha>\0<subject>
  let head: { sha: string; subject: string } | null = null;
  const logRaw = in_.log.replace(/\n+$/, '');
  if (logRaw) {
    const nul = logRaw.indexOf('\0');
    if (nul > 0) head = { sha: logRaw.slice(0, nul), subject: logRaw.slice(nul + 1) };
  }

  // git show --numstat --format= HEAD: lines of "<adds>\t<dels>\t<path>".
  const headFiles: FilesHeadEntry[] = [];
  for (const line of in_.show.split('\n')) {
    if (!line) continue;
    const [a, d, p] = line.split('\t');
    if (!p) continue;
    const adds = a === '-' ? 0 : Number.parseInt(a, 10) || 0;
    const dels = d === '-' ? 0 : Number.parseInt(d, 10) || 0;
    const status: Exclude<FileStatus, 'U'> = dels === 0 && adds > 0 ? 'A' : 'M';
    headFiles.push({ path: p, status, additions: adds, deletions: dels });
  }

  // rev-list --left-right --count: "<left>\t<right>"
  // Command is `refs/remotes/origin/<base>...HEAD`:
  //   LEFT  = commits in origin/base not in HEAD → behind
  //   RIGHT = commits in HEAD not in origin/base → ahead
  let branchBase: FilesPayload['branchBase'] = null;
  const ab = in_.aheadBehind.trim();
  if (ab) {
    const [l, r] = ab.split(/\s+/).map((n) => Number.parseInt(n, 10));
    if (Number.isFinite(l) && Number.isFinite(r)) {
      branchBase = { base: in_.base ?? '', ahead: r, behind: l };
    }
  }

  return { dirty, head, headFiles, branchBase };
}

function mapPorcelain(code: string): FileStatus {
  if (code === '??') return 'U';
  const nonSpace = code.replace(/\s/g, '');
  if (nonSpace.includes('A')) return 'A';
  if (nonSpace.includes('D')) return 'D';
  if (nonSpace.includes('R')) return 'R';
  return 'M';
}

export interface RawSubmoduleDirty {
  path: string;
  url: string | null;
  dirty_paths: string[];
}

export function parseSubmoduleStatus(smStatus: string, smInfo: string): RawSubmoduleDirty[] {
  // .gitmodules rows: "submodule.<name>.path foo" | "submodule.<name>.url https://..."
  const byName: Record<string, { path?: string; url?: string }> = {};
  for (const line of smInfo.split('\n')) {
    if (!line) continue;
    const m = line.match(/^submodule\.(.+?)\.(path|url) (.+)$/);
    if (!m) continue;
    byName[m[1]] = byName[m[1]] ?? {};
    (byName[m[1]] as Record<string, string>)[m[2]] = m[3];
  }
  const urls = new Map<string, string | null>();
  for (const info of Object.values(byName)) {
    if (info.path) urls.set(info.path, info.url ?? null);
  }

  // `git submodule status` format:
  //   [ +-]<sha> <path> [<description>]
  //   ' ' = clean   '+' = differs from recorded   '-' = uninitialized
  const out: RawSubmoduleDirty[] = [];
  for (const line of smStatus.split('\n')) {
    if (!line) continue;
    const marker = line[0];
    const rest = line.slice(42);  // 1 (marker) + 40 (sha) + 1 (space)
    const path = rest.split(' ')[0];
    if (!path) continue;
    if (marker === '+' || marker === '-') {
      out.push({ path, url: urls.get(path) ?? null, dirty_paths: [] });
    }
  }
  return out;
}
