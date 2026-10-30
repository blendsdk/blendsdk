import { defineConfig, mergeConfig } from 'vitest/config';

import rootConfig from '../../vitest.config.js';

/**
 * Extends the repository test defaults and bounds Vitest to two workers so
 * the package's shared Redis container is not oversubscribed.
 */
export default mergeConfig(
  rootConfig,
  defineConfig({
    test: {
      maxWorkers: 2,
    },
  })
);
