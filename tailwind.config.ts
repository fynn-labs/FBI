import type { Config } from 'tailwindcss';

export default {
  content: ['./src/web/**/*.{ts,tsx,html}'],
  darkMode: 'class',
  theme: { extend: {} },
  plugins: [],
} satisfies Config;
