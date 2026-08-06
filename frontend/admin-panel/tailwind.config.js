/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50:  '#eef2ff',
          100: '#e0e7ff',
          200: '#c7d2fe',
          400: '#818cf8',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
          900: '#1e1b4b',
        },
        surface: {
          base:     '#0f1117',
          DEFAULT:  '#161b27',
          elevated: '#1e2436',
          overlay:  '#252d42',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      borderColor: {
        subtle:  'rgba(255,255,255,0.06)',
        DEFAULT: 'rgba(255,255,255,0.10)',
        strong:  'rgba(255,255,255,0.18)',
      },
      boxShadow: {
        glow: '0 0 24px rgba(99,102,241,0.25)',
        'glow-sm': '0 0 12px rgba(99,102,241,0.15)',
      },
      animation: {
        'fade-in':   'fadeIn 0.3s ease forwards',
        'slide-in':  'slideIn 0.25s ease forwards',
        'pulse-dot': 'pulseDot 2s ease-in-out infinite',
      },
      keyframes: {
        fadeIn:   { from: { opacity: '0', transform: 'translateY(6px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        slideIn:  { from: { opacity: '0', transform: 'translateX(-12px)' }, to: { opacity: '1', transform: 'translateX(0)' } },
        pulseDot: { '0%,100%': { opacity: '1' }, '50%': { opacity: '0.4' } },
      },
      width: { sidebar: '224px' },
      height: { topbar: '64px' },
    },
  },
  plugins: [],
};
