/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // App surface palette (dark, slate-tinted)
        ink: {
          950: '#0a0c10',
          900: '#0e1117',
          850: '#141821',
          800: '#1a1f2b',
          700: '#252b3a',
          600: '#323a4d'
        },
        accent: {
          DEFAULT: '#3b82f6',
          soft: '#60a5fa'
        }
      },
      fontFamily: {
        sans: ['Inter', 'Segoe UI', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'Consolas', 'monospace']
      }
    }
  },
  plugins: []
}
