import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import supertest from 'supertest';
import { WebApplication } from '../src/application/web-application.js';
import { staticFilesPlugin } from '../src/application/static-files-plugin.js';

// ---------------------------------------------------------------------------
// Test Fixtures — temp directory with known file structure
// ---------------------------------------------------------------------------

/**
 * Fixture files used by all test groups.
 *
 * Structure:
 *   <tmpDir>/
 *   ├── index.html        "<!DOCTYPE html><html><body>SPA</body></html>"
 *   ├── test.txt           "hello"
 *   ├── style.css          "body { color: red; }"
 *   ├── sub/
 *   │   └── nested.txt     "nested content"
 *   └── .hidden            "secret"
 */
let tmpDir: string;

beforeAll(() => {
    // Create a unique temp directory for this test run
    tmpDir = mkdtempSync(join(tmpdir(), 'webafx-static-'));

    // Populate with known fixture files
    writeFileSync(join(tmpDir, 'index.html'), '<!DOCTYPE html><html><body>SPA</body></html>');
    writeFileSync(join(tmpDir, 'test.txt'), 'hello');
    writeFileSync(join(tmpDir, 'style.css'), 'body { color: red; }');
    mkdirSync(join(tmpDir, 'sub'));
    writeFileSync(join(tmpDir, 'sub', 'nested.txt'), 'nested content');
    writeFileSync(join(tmpDir, '.hidden'), 'secret');
});

afterAll(() => {
    // Clean up the temp directory after all tests complete
    rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper — create a WebApplication, start it, return supertest agent + cleanup
// ---------------------------------------------------------------------------

/**
 * Creates a test app with one or more static file plugins, starts it,
 * and returns a supertest agent for HTTP assertions plus a shutdown function.
 */
async function createTestApp(
    ...plugins: ReturnType<typeof staticFilesPlugin>[]
): Promise<{ agent: supertest.Agent; shutdown: () => Promise<void> }> {
    const app = new WebApplication({
        PORT: 0,
        ENV_MODE: 'test',
        LOG_LEVEL: 'ERROR',
    });

    for (const plugin of plugins) {
        app.use(plugin);
    }

    const shutdown = await app.start();
    const agent = supertest.agent(app.express);

    return { agent, shutdown };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Static Files Plugin', () => {
    // Track shutdown functions so afterEach can clean up even if a test fails
    let activeShutdown: (() => Promise<void>) | undefined;

    afterEach(async () => {
        if (activeShutdown) {
            await activeShutdown();
            activeShutdown = undefined;
        }
    });

    // -------------------------------------------------------------------
    // Plugin Factory (unit-level)
    // -------------------------------------------------------------------

    describe('Plugin Factory', () => {
        test('returns a PluginDefinition with correct name and default priority', () => {
            const plugin = staticFilesPlugin({ root: tmpDir });

            expect(plugin.name).toBe('static-files');
            expect(plugin.priority).toBe(20);
            expect(plugin.factory).toBeTypeOf('function');
        });

        test('custom priority is respected', () => {
            const plugin = staticFilesPlugin({ root: tmpDir, priority: 50 });

            expect(plugin.priority).toBe(50);
        });

        test('plugin name includes prefix when set', () => {
            const plugin = staticFilesPlugin({ root: tmpDir, prefix: '/static' });

            expect(plugin.name).toBe('static-files:/static');
        });

        test('plugin name is "static-files" when prefix is default "/"', () => {
            const plugin = staticFilesPlugin({ root: tmpDir, prefix: '/' });

            expect(plugin.name).toBe('static-files');
        });
    });

    // -------------------------------------------------------------------
    // File Serving
    // -------------------------------------------------------------------

    describe('File Serving', () => {
        test('serves a file from the root directory', async () => {
            const { agent, shutdown } = await createTestApp(
                staticFilesPlugin({ root: tmpDir })
            );
            activeShutdown = shutdown;

            const res = await agent.get('/test.txt');

            expect(res.status).toBe(200);
            expect(res.text).toBe('hello');
        });

        test('serves a nested file from a subdirectory', async () => {
            const { agent, shutdown } = await createTestApp(
                staticFilesPlugin({ root: tmpDir })
            );
            activeShutdown = shutdown;

            const res = await agent.get('/sub/nested.txt');

            expect(res.status).toBe(200);
            expect(res.text).toBe('nested content');
        });

        test('returns 404 for a file that does not exist', async () => {
            const { agent, shutdown } = await createTestApp(
                staticFilesPlugin({ root: tmpDir })
            );
            activeShutdown = shutdown;

            const res = await agent.get('/nonexistent.txt');

            expect(res.status).toBe(404);
        });

        test('serves index.html for the root path by default', async () => {
            const { agent, shutdown } = await createTestApp(
                staticFilesPlugin({ root: tmpDir })
            );
            activeShutdown = shutdown;

            const res = await agent.get('/').set('Accept', 'text/html');

            expect(res.status).toBe(200);
            expect(res.text).toContain('SPA');
        });
    });

    // -------------------------------------------------------------------
    // URL Prefix
    // -------------------------------------------------------------------

    describe('URL Prefix', () => {
        test('serves files at the configured prefix', async () => {
            const { agent, shutdown } = await createTestApp(
                staticFilesPlugin({ root: tmpDir, prefix: '/assets' })
            );
            activeShutdown = shutdown;

            const res = await agent.get('/assets/test.txt');

            expect(res.status).toBe(200);
            expect(res.text).toBe('hello');
        });

        test('does not serve files at the root when prefix is set', async () => {
            const { agent, shutdown } = await createTestApp(
                staticFilesPlugin({ root: tmpDir, prefix: '/assets' })
            );
            activeShutdown = shutdown;

            const res = await agent.get('/test.txt');

            expect(res.status).toBe(404);
        });
    });

    // -------------------------------------------------------------------
    // SPA Mode
    // -------------------------------------------------------------------

    describe('SPA Mode', () => {
        test('serves index.html for a client-side route', async () => {
            const { agent, shutdown } = await createTestApp(
                staticFilesPlugin({ root: tmpDir, spa: true })
            );
            activeShutdown = shutdown;

            const res = await agent
                .get('/about')
                .set('Accept', 'text/html');

            expect(res.status).toBe(200);
            expect(res.text).toContain('SPA');
        });

        test('serves index.html for nested client-side routes', async () => {
            const { agent, shutdown } = await createTestApp(
                staticFilesPlugin({ root: tmpDir, spa: true })
            );
            activeShutdown = shutdown;

            const res = await agent
                .get('/settings/profile')
                .set('Accept', 'text/html');

            expect(res.status).toBe(200);
            expect(res.text).toContain('SPA');
        });

        test('returns 404 for missing file requests (has file extension)', async () => {
            const { agent, shutdown } = await createTestApp(
                staticFilesPlugin({ root: tmpDir, spa: true })
            );
            activeShutdown = shutdown;

            // Path has a file extension — should NOT trigger SPA fallback
            const res = await agent
                .get('/missing.css')
                .set('Accept', 'text/html');

            expect(res.status).toBe(404);
        });

        test('skips SPA fallback for non-GET requests', async () => {
            const { agent, shutdown } = await createTestApp(
                staticFilesPlugin({ root: tmpDir, spa: true })
            );
            activeShutdown = shutdown;

            // POST requests should pass through, not get index.html
            const res = await agent
                .post('/about')
                .set('Accept', 'text/html');

            expect(res.status).toBe(404);
        });

        test('skips SPA fallback when Accept header does not include text/html', async () => {
            const { agent, shutdown } = await createTestApp(
                staticFilesPlugin({ root: tmpDir, spa: true })
            );
            activeShutdown = shutdown;

            // JSON API request — should NOT get index.html
            const res = await agent
                .get('/about')
                .set('Accept', 'application/json');

            expect(res.status).toBe(404);
        });

        test('serves actual files before falling back to index.html', async () => {
            const { agent, shutdown } = await createTestApp(
                staticFilesPlugin({ root: tmpDir, spa: true })
            );
            activeShutdown = shutdown;

            // test.txt exists — should serve the file, NOT index.html
            const res = await agent.get('/test.txt');

            expect(res.status).toBe(200);
            expect(res.text).toBe('hello');
        });
    });

    // -------------------------------------------------------------------
    // Cache Headers
    // -------------------------------------------------------------------

    describe('Cache Headers', () => {
        test('sets Cache-Control with maxAge', async () => {
            const { agent, shutdown } = await createTestApp(
                staticFilesPlugin({ root: tmpDir, maxAge: '1d' })
            );
            activeShutdown = shutdown;

            const res = await agent.get('/test.txt');

            expect(res.status).toBe(200);
            // Express converts '1d' to max-age=86400
            expect(res.headers['cache-control']).toContain('max-age=86400');
        });

        test('sets immutable directive in Cache-Control', async () => {
            const { agent, shutdown } = await createTestApp(
                staticFilesPlugin({ root: tmpDir, maxAge: '1y', immutable: true })
            );
            activeShutdown = shutdown;

            const res = await agent.get('/test.txt');

            expect(res.status).toBe(200);
            expect(res.headers['cache-control']).toContain('immutable');
        });

        test('no caching by default (max-age=0)', async () => {
            const { agent, shutdown } = await createTestApp(
                staticFilesPlugin({ root: tmpDir })
            );
            activeShutdown = shutdown;

            const res = await agent.get('/test.txt');

            expect(res.status).toBe(200);
            // Default Express behavior: public, max-age=0
            expect(res.headers['cache-control']).toContain('max-age=0');
        });
    });

    // -------------------------------------------------------------------
    // Multiple Instances
    // -------------------------------------------------------------------

    describe('Multiple Instances', () => {
        test('two plugins with different prefixes both serve their files', async () => {
            // Create a second temp directory with different content
            const tmpDir2 = mkdtempSync(join(tmpdir(), 'webafx-static2-'));
            writeFileSync(join(tmpDir2, 'other.txt'), 'from second dir');

            try {
                const { agent, shutdown } = await createTestApp(
                    staticFilesPlugin({ root: tmpDir, prefix: '/first' }),
                    staticFilesPlugin({ root: tmpDir2, prefix: '/second' })
                );
                activeShutdown = shutdown;

                // First plugin serves its files
                const res1 = await agent.get('/first/test.txt');
                expect(res1.status).toBe(200);
                expect(res1.text).toBe('hello');

                // Second plugin serves its files
                const res2 = await agent.get('/second/other.txt');
                expect(res2.status).toBe(200);
                expect(res2.text).toBe('from second dir');

                // Cross-prefix doesn't work
                const res3 = await agent.get('/first/other.txt');
                expect(res3.status).toBe(404);
            } finally {
                rmSync(tmpDir2, { recursive: true, force: true });
            }
        });
    });

    // -------------------------------------------------------------------
    // Error Handling
    // -------------------------------------------------------------------

    describe('Error Handling', () => {
        test('throws when root directory does not exist', async () => {
            const app = new WebApplication({
                PORT: 0,
                ENV_MODE: 'test',
                LOG_LEVEL: 'ERROR',
            });

            app.use(staticFilesPlugin({ root: './nonexistent-dir-abc123' }));

            // The error should propagate during app.start() when the plugin factory runs
            await expect(app.start()).rejects.toThrow(
                'Static files root directory does not exist'
            );
        });

        test('error message includes the resolved path', async () => {
            const app = new WebApplication({
                PORT: 0,
                ENV_MODE: 'test',
                LOG_LEVEL: 'ERROR',
            });

            app.use(staticFilesPlugin({ root: './nonexistent-dir-abc123' }));

            await expect(app.start()).rejects.toThrow(
                /nonexistent-dir-abc123/
            );
        });
    });
});
