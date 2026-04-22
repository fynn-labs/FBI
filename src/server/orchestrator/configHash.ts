import crypto from 'node:crypto';

export interface ConfigHashInput {
  devcontainer_file: string | null;
  override_json: string | null;
  always: readonly string[];
}

export function computeConfigHash(input: ConfigHashInput): string {
  const h = crypto.createHash('sha256');
  h.update('dev:');
  h.update(input.devcontainer_file ?? '');
  h.update('\nover:');
  h.update(input.override_json ?? '');
  h.update('\nalways:');
  h.update([...input.always].sort().join(','));
  return h.digest('hex').slice(0, 16);
}
