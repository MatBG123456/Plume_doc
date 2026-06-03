import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Port fixe attendu par Tauri (cf. tauri.conf.json -> devUrl).
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  // Tauri attend un port fixe ; on échoue plutôt que de basculer en silence.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      // Ne pas surveiller le dossier Rust.
      ignored: ["**/src-tauri/**"],
    },
  },
});
