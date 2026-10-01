import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // Disable file parallelism — multiple test files share the same
        // Mailpit Docker instance and call clearMailpit() in beforeEach,
        // so running them in parallel causes cross-file interference.
        fileParallelism: false,
    },
});
