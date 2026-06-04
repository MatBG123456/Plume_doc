import { defineConfig } from "vitest/config";

// Tests unitaires de la logique front (pure). jsdom fournit un environnement
// DOM minimal ; les imports de test sont explicites (`import { ... } from
// "vitest"`), donc pas de globals à déclarer côté tsconfig.
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
