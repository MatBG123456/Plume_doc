import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Tests unitaires de la logique front (pure) + composants (jsdom + React). Les
// imports de test sont explicites (`import { ... } from "vitest"`), donc pas de
// globals à déclarer côté tsconfig.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
