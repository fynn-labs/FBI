import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { UploadTray } from './UploadTray.js';

function makeFile(name: string, size: number): File {
  return new File([new Uint8Array(size)], name, { type: 'application/octet-stream' });
}

describe('UploadTray', () => {
  it('calls upload when a file is selected via the paperclip input', async () => {
    const upload = vi.fn().mockResolvedValue({ filename: 'foo.csv', size: 5 });
    const onUploaded = vi.fn();
    render(
      <UploadTray
        upload={upload}
        onUploaded={onUploaded}
        attached={[]}
        maxFileBytes={100 * 1024 * 1024}
        maxTotalBytes={1024 * 1024 * 1024}
        totalBytes={0}
      />,
    );
    const input = screen.getByTestId('upload-input') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makeFile('foo.csv', 5)] } });
    await waitFor(() => expect(upload).toHaveBeenCalledOnce());
    expect(onUploaded).toHaveBeenCalledWith('foo.csv');
  });

  it('rejects oversized files without calling upload', async () => {
    const upload = vi.fn();
    render(
      <UploadTray
        upload={upload}
        onUploaded={() => {}}
        attached={[]}
        maxFileBytes={10}
        maxTotalBytes={100}
        totalBytes={0}
      />,
    );
    const input = screen.getByTestId('upload-input') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makeFile('big.bin', 100)] } });
    expect(upload).not.toHaveBeenCalled();
    expect(screen.getByText(/too large/i)).toBeInTheDocument();
  });

  it('rejects when cumulative quota would be exceeded', async () => {
    const upload = vi.fn();
    render(
      <UploadTray
        upload={upload}
        onUploaded={() => {}}
        attached={[]}
        maxFileBytes={1_000_000}
        maxTotalBytes={100}
        totalBytes={95}
      />,
    );
    const input = screen.getByTestId('upload-input') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makeFile('foo.bin', 10)] } });
    expect(upload).not.toHaveBeenCalled();
    expect(screen.getByText(/exceed/i)).toBeInTheDocument();
  });

  it('is disabled when `disabled` is true', () => {
    render(
      <UploadTray
        upload={vi.fn()} onUploaded={() => {}}
        attached={[]} maxFileBytes={1e9} maxTotalBytes={1e10} totalBytes={0}
        disabled disabledReason="nope"
      />,
    );
    const input = screen.getByTestId('upload-input') as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it('renders chips for attached files with a remove button when `onRemove` is provided', () => {
    const onRemove = vi.fn();
    render(
      <UploadTray
        upload={vi.fn()} onUploaded={() => {}}
        onRemove={onRemove}
        attached={[{ filename: 'foo.csv', size: 123 }]}
        maxFileBytes={1e9} maxTotalBytes={1e10} totalBytes={123}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /remove foo.csv/i }));
    expect(onRemove).toHaveBeenCalledWith('foo.csv');
  });
});
