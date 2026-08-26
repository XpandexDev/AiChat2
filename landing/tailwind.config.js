/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          pink: '#E91E8C',
          bg: '#fafafa',
          surface: '#ffffff',
          border: 'rgba(0,0,0,0.06)',
          ink: '#0f1115',
          'ink-2': '#23262d',
          'ink-3': '#6b6e76',
          canvas: '#FBFBFA',
        },
      },
      fontFamily: {
        display: ['var(--font-display)', 'Inter', 'system-ui', 'sans-serif'],
        body: ['var(--font-body)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      letterSpacing: { tightest: '-0.04em' },
      maxWidth: { content: '1200px' },
    },
  },
  plugins: [],
};
