/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        purple: {
          400: '#c084fc',
          500: '#a855f7',
          600: '#9333ea',
          700: '#7e22ce',
          900: '#581c87',
        },
        gray: {
          100: '#f3f4f6',
          400: '#9ca3af',
          500: '#6b7280',
          600: '#4b5563',
          700: '#374151',
          800: '#1f2937',
          900: '#111827',
        },
        red: {
          100: '#fee2e2',
          900: '#7f1d1d',
        },
        blue: {
          100: '#dbeafe',
          900: '#1e3a8a',
        },
        yellow: {
          500: '#eab308',
        },
      },
    },
  },
  plugins: [],
}
