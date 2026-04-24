export async function writeToClipboard(text: string): Promise<void> {
  if ('__TAURI_INTERNALS__' in window) {
    const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
    await writeText(text);
  } else {
    await navigator.clipboard.writeText(text);
  }
}
