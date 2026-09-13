/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        /*
         * Slate + white + the four accent scales read from CSS variables
         * defined in index.css: dark values in :root, light values under
         * html.light. Every utility (text-, bg- with /10 /20, border- with /30,
         * ring-, gradient stops) therefore flips with the theme without
         * touching components — and the light values are the AA-checked ones
         * audited by src/services/contrast.test.ts.
         *
         * Only the shades actually used in the app are remapped; the rest of
         * each scale keeps Tailwind's static defaults (extend merges keys).
         */
        slate: {
          50: 'rgb(var(--slate-50) / <alpha-value>)',
          100: 'rgb(var(--slate-100) / <alpha-value>)',
          200: 'rgb(var(--slate-200) / <alpha-value>)',
          300: 'rgb(var(--slate-300) / <alpha-value>)',
          400: 'rgb(var(--slate-400) / <alpha-value>)',
          500: 'rgb(var(--slate-500) / <alpha-value>)',
          600: 'rgb(var(--slate-600) / <alpha-value>)',
          700: 'rgb(var(--slate-700) / <alpha-value>)',
          800: 'rgb(var(--slate-800) / <alpha-value>)',
          900: 'rgb(var(--slate-900) / <alpha-value>)',
          950: 'rgb(var(--slate-950) / <alpha-value>)',
        },
        white: 'rgb(var(--white) / <alpha-value>)',

        // Accents. Dark values match Tailwind's defaults; light values are
        // darkened so text clears 4.5:1 and indicators 3:1 on white panels.
        emerald: {
          300: 'rgb(var(--emerald-300) / <alpha-value>)',
          400: 'rgb(var(--emerald-400) / <alpha-value>)',
          500: 'rgb(var(--emerald-500) / <alpha-value>)',
          600: 'rgb(var(--emerald-600) / <alpha-value>)',
          800: 'rgb(var(--emerald-800) / <alpha-value>)',
          950: 'rgb(var(--emerald-950) / <alpha-value>)',
        },
        red: {
          300: 'rgb(var(--red-300) / <alpha-value>)',
          400: 'rgb(var(--red-400) / <alpha-value>)',
          500: 'rgb(var(--red-500) / <alpha-value>)',
          900: 'rgb(var(--red-900) / <alpha-value>)',
        },
        sky: {
          300: 'rgb(var(--sky-300) / <alpha-value>)',
          400: 'rgb(var(--sky-400) / <alpha-value>)',
          500: 'rgb(var(--sky-500) / <alpha-value>)',
        },
        amber: {
          300: 'rgb(var(--amber-300) / <alpha-value>)',
          400: 'rgb(var(--amber-400) / <alpha-value>)',
          500: 'rgb(var(--amber-500) / <alpha-value>)',
          800: 'rgb(var(--amber-800) / <alpha-value>)',
        },
      },
    },
  },
  plugins: [],
};