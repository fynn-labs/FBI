import { useState, useEffect } from 'react';
import CodeMirror, { oneDark } from '@uiw/react-codemirror';
import { json } from '@codemirror/lang-json';

interface JsonEditorProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
}

export function JsonEditor({ label, value, onChange }: JsonEditorProps) {
  const [isDark, setIsDark] = useState(() =>
    document.documentElement.classList.contains('dark')
  );

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'));
    });
    observer.observe(document.documentElement, { attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const status = parseStatus(value);

  return (
    <label className="block">
      <span className="block text-sm font-medium mb-1">{label}</span>
      <div className="border rounded overflow-hidden dark:border-gray-600">
        <CodeMirror
          value={value}
          onChange={onChange}
          extensions={[json()]}
          theme={isDark ? oneDark : undefined}
          className="text-sm"
        />
      </div>
      {status === 'valid' && (
        <p className="mt-1 text-xs text-green-600 dark:text-green-400">✓ Valid JSON</p>
      )}
      {status !== 'valid' && status !== 'empty' && (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400">✗ {status}</p>
      )}
    </label>
  );
}

function parseStatus(value: string): 'valid' | 'empty' | string {
  if (!value.trim()) return 'empty';
  try {
    JSON.parse(value);
    return 'valid';
  } catch (e) {
    return (e as Error).message;
  }
}
