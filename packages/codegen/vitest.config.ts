import { defineConfig, mergeConfig } from 'vitest/config';

import rootConfig from '../../vitest.config.js';

/**
 * Extends the repository test defaults and bounds Vitest to two workers so
 * the package's shared Postgres container is not oversubscribed. The test
 * script already runs files serially; this cap is a second, explicit bound.
 */
export default mergeConfig(
  rootConfig,
  defineConfig({
    test: {
      maxWorkers: 2,
    },
  })
);
