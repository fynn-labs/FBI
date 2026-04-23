import fs from 'node:fs';
import path from 'node:path';

// Copies the entrypoint scripts into `destDir`. The copies — not the source
// paths — are what gets bind-mounted into the container, so host edits to
// the sources after this call don't reach the running container. Bash reads
// scripts by byte offset; a live bind that rewrites under a blocked shell
// produces mid-line reads and syntax errors on the next command.
export function snapshotScripts(
  destDir: string,
  srcSupervisor: string,
  srcFinalize: string,
): void {
  fs.mkdirSync(destDir, { recursive: true });
  const sup = path.join(destDir, 'supervisor.sh');
  const fin = path.join(destDir, 'finalizeBranch.sh');
  fs.copyFileSync(srcSupervisor, sup);
  fs.copyFileSync(srcFinalize, fin);
  fs.chmodSync(sup, 0o755);
  fs.chmodSync(fin, 0o755);
}
