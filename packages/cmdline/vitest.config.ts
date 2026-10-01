import { defineConfig, mergeConfig } from 'vitest/config';

import rootConfig from '../../vitest.config.js';

/** Extends repository test defaults with package-owned per-file coverage requirements. */
export default mergeConfig(
  rootConfig,
  defineConfig({
    test: {
      coverage: {
        include: [
          'src/argument-parser.ts',
          'src/cmdline.ts',
          'src/errors.ts',
          'src/suggestions.ts',
        ],
        thresholds: {
          perFile: true,
          lines: 90,
          branches: 90,
          functions: 90,
          statements: 90,
        },
      },
    },
  })
);
