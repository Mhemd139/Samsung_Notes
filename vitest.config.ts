import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "web/test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
