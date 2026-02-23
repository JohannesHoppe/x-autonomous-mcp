import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    globalSetup: ["src/playground-setup.ts"],
    testTimeout: 15000,
  },
});
