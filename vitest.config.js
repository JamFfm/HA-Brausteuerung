import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Reine Logik- und Property-Tests laufen in Node ohne DOM.
    environment: "node",
    // Tests werden neben dem Quellcode unter www/ abgelegt (z. B. *.test.js).
    include: ["www/**/*.{test,spec}.{js,mjs}", "tests/**/*.{test,spec}.{js,mjs}"],
    globals: true,
  },
});
