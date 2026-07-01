import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Git integration tests chdir and touch temp repos; keep them serial-safe
    // by isolating each in its own temp directory rather than sharing state.
    pool: "forks"
  }
});
