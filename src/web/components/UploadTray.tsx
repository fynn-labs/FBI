import { useCallback, useRef, useState } from 'react';

export interface UploadTrayFile {
  filename: string;
  size: number;
  uploading?: boolean;
  error?: string;
}

export interface UploadTrayProps {
  disabled?: boolean;
  disabledReason?: string;
  onUploaded: (filename: string) => void;
  onRemove?: (filename: string) => void;
  attached: UploadTrayFile[];
  upload: (file: File) => Promise<{ filename: string; size: number }>;
  maxFileBytes: number;
  maxTotalBytes: number;
  totalBytes: number;
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function UploadTray(props: UploadTrayProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFile = useCallback(
    async (file: File) => {
      if (file.size > props.maxFileBytes) {
        setError(`File too large (max ${humanSize(props.maxFileBytes)})`);
        return;
      }
      if (props.totalBytes + file.size > props.maxTotalBytes) {
        setError('Adding this would exceed the run quota');
        return;
      }
      setError(null);
      try {
        const res = await props.upload(file);
        props.onUploaded(res.filename);
      } catch (e) {
        setError((e as Error).message ?? 'Upload failed');
      }
    },
    [props],
  );

  return (
    <div className="flex flex-col gap-2">
      <label
        title={props.disabled ? (props.disabledReason ?? '') : 'Attach a file'}
        aria-disabled={props.disabled}
        className="inline-flex items-center"
      >
        <input
          ref={inputRef}
          data-testid="upload-input"
          type="file"
          disabled={props.disabled}
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Reset so picking the same file twice still fires onChange.
            e.target.value = '';
            if (file) void handleFile(file);
          }}
          className="sr-only"
        />
        <span className="cursor-pointer" role="button" aria-label="Attach a file">
          📎
        </span>
      </label>
      {error && (
        <div className="text-attn text-sm" role="alert">
          {error}
        </div>
      )}
      <ul className="flex flex-wrap gap-2">
        {props.attached.map((f) => (
          <li
            key={f.filename}
            className="inline-flex items-center gap-2 rounded-md border border-border bg-surface px-2 py-1 text-sm"
          >
            <span>
              {f.filename} · {humanSize(f.size)}
            </span>
            {f.uploading && <span aria-label="uploading">⟳</span>}
            {f.error && (
              <span className="text-attn" role="alert">
                {f.error}
              </span>
            )}
            {props.onRemove && (
              <button
                type="button"
                aria-label={`remove ${f.filename}`}
                onClick={() => props.onRemove?.(f.filename)}
                className="text-text-dim"
              >
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
