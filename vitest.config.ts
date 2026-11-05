import { defineConfig } from "vitest/config";

// Coverage gate (foundations §16): ≥ 90% branch coverage on the pure code (domain, scenarios, addresses).
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/domain/**/*.ts", "src/scenarios/**/*.ts", "src/simulated-chains/addresses.ts"],
      reporter: ["text", "json-summary"],
      thresholds: { branches: 90 },
    },
  },
});
