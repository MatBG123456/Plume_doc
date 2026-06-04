/** @type {import('tailwindcss').Config} */
// Design system « Perch » : ivoire chaud + accent corail unique, polices
// Fraunces (serif) / Hanken Grotesk (sans) / JetBrains Mono (mono).
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: "#F6F4EE",
        card: "#FFFEFB",
        ink: "#23211C",
        muted: "#6F6B61",
        faint: "#9A958A",
        coral: { DEFAULT: "#CC6A44", soft: "#F4E3DA", ink: "#7C3A20" },
        teal: { DEFAULT: "#1D9E75", soft: "#E1F5EE", ink: "#085041" },
        amber: { soft: "#FAEEDA", ink: "#633806" },
        deny: "#B23A2A",
        ctx: "#5B8FC9",
        line: "rgba(35,33,28,0.10)",
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
