import { describe, expect, test } from 'vitest';
import { WebApplication } from '../src/index.js';

describe('webafx sanity', () => {
  test('start and shutdown', async () => {
    const app = new WebApplication({
      PORT: 4002,
      ENV_MODE: 'development',
    });

    app.use({
      name: 'my-plugin',
      factory: async ({ logger }) => {
        return {
          shutdown: async () => {
            logger.info('Good bye!');
          },
        };
      },
    });
    const shutdown = await app.start();
    expect((app as any).started).toBe(true);
    await shutdown();
    expect((app as any).started).toBe(false);
  });
});
