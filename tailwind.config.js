/** @type {import('tailwindcss').Config} */
// Design system « Perch ». Couleurs pilotées par des variables CSS (cf.
// src/styles.css) pour le double thème clair/sombre : les classes (bg-paper,
// text-ink, text-coral…) suivent automatiquement `[data-theme="dark"]`.
// `paper`/`ink`/`coral` sont en canaux RGB → les modificateurs d'opacité
// (bg-paper/80, bg-ink/[0.04], border-coral/40) fonctionnent.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: "rgb(var(--paper) / <alpha-value>)",
        ink: "rgb(var(--ink) / <alpha-value>)",
        coral: {
          DEFAULT: "rgb(var(--coral) / <alpha-value>)",
          soft: "var(--coral-soft)",
          ink: "var(--coral-ink)",
        },
        card: "var(--card)",
        muted: "var(--muted)",
        faint: "var(--faint)",
        teal: { DEFAULT: "var(--teal)", ink: "var(--teal-ink)" },
        deny: "var(--deny)",
        ctx: "var(--ctx)",
        line: "var(--line)",
      },
      fontFamily: {
        sans: ['"Hanken Grotesk"', "ui-sans-serif", "system-ui", "sans-serif"],
        serif: ["Fraunces", "ui-serif", "Georgia", "serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "SFMono-Regular", "monospace"],
      },
      borderRadius: {
        panel: "18px",
        row: "11px",
        pill: "999px",
      },
      boxShadow: {
        soft: "0 16px 40px -16px rgba(35,33,28,0.22), 0 2px 6px rgba(35,33,28,0.06)",
        pop: "0 24px 60px -18px rgba(35,33,28,0.30), 0 4px 12px rgba(35,33,28,0.10)",
      },
    },
  },
  plugins: [],
};
