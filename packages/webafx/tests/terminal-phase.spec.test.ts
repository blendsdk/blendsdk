import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import supertest from 'supertest';
import { WebApplication } from '../src/application/web-application.js';
import { BaseController } from '../src/application/base-controller.js';
import { RouteDefinition } from '../src/application/route-builder.js';
import { staticFilesPlugin } from '../src/application/static-files-plugin.js';
import type { PluginDefinition } from '../src/application/plugin.js';

/**
 * Specification tests for the WebAFX terminal plugin phase.
 *
 * These tests are derived EXCLUSIVELY from the specification documents
 * (`01-requirements.md`, `03-terminal-plugin-phase.md`, `04-static-files-spa.md`)
 * and the Ambiguity Register (`00-ambiguity-register.md`). They encode the
 * expected behavior BEFORE implementation exists (spec-first / red phase).
 *
 * IMMUTABLE ORACLE RULE: if a test here fails after implementation, the
 * implementation is wrong — not the test.
 *
 * ST-cases covered: ST-1 .. ST-10 (see 07-testing-strategy.md).
 */

// ---------------------------------------------------------------------------
// Fixtures — temp directory with index.html and a real static file
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeAll(() => {
    // Unique temp dir so tests are isolated from each other and the FS
    tmpDir = mkdtempSync(join(tmpdir(), 'webafx-terminal-'));
    // index.html — what the SPA fallback serves. Marker text proves it was served.
    writeFileSync(join(tmpDir, 'index.html'), '<!DOCTYPE html><html><body>SPA_INDEX</body></html>');
    // A real static file — proves express.static still serves files (ST-10)
    writeFileSync(join(tmpDir, 'app.js'), 'console.log("static-asset");');
});

afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test controller — a route reachable by HTML GET navigation (AR #11)
// Mirrors OidcAuthController's `GET /api/oidc/login` shape: GET, no extension,
// satisfies the SPA fallback guards, so it would be swallowed if the fallback
// ran before controllers.
// ---------------------------------------------------------------------------

/** Marker returned by the controller so we can distinguish it from index.html. */
const LOGIN_MARKER = 'CONTROLLER_LOGIN_OK';

class OidcLikeController extends BaseController {
    routes(): RouteDefinition[] {
        return [
            this.route()
                .get('/api/oidc/login')
                .handle(async (req, res) => {
                    this.ok(res, { marker: LOGIN_MARKER });
                }),
        ];
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create and start a WebApplication with the given plugins and (optional)
 * controllers, returning a supertest agent and a shutdown function.
 */
async function createApp(options: {
    plugins?: PluginDefinition[];
    controllers?: Array<{
        basePath: string;
        controller: new (...args: any[]) => BaseController;
    }>;
}): Promise<{ agent: supertest.Agent; shutdown: () => Promise<void> }> {
    const app = new WebApplication({
        PORT: 0,
        ENV_MODE: 'test',
        LOG_LEVEL: 'ERROR',
    });

    for (const plugin of options.plugins ?? []) {
        app.use(plugin);
    }
    for (const c of options.controllers ?? []) {
        app.registerController(c.basePath, c.controller);
    }

    const shutdown = await app.start();
    const agent = supertest.agent(app.express);
    return { agent, shutdown };
}

// ---------------------------------------------------------------------------
// Specification: Terminal Phase
// ---------------------------------------------------------------------------

describe('Specification: Terminal Plugin Phase', () => {
    let activeShutdown: (() => Promise<void>) | undefined;

    afterEach(async () => {
        if (activeShutdown) {
            await activeShutdown();
            activeShutdown = undefined;
        }
    });

    // ST-1: terminal hook is invoked exactly once during initialization.
    // Source: Req MH / AR #1, #2
    test('ST-1: terminal hook is invoked exactly once on startup', async () => {
        let invocations = 0;
        const plugin: PluginDefinition = {
            name: 'st1-terminal',
            priority: 20,
            factory: async () => ({
                terminal: async () => {
                    invocations += 1;
                },
            }),
        };

        const { shutdown } = await createApp({ plugins: [plugin] });
        activeShutdown = shutdown;

        expect(invocations).toBe(1);
    });

    // ST-2: two terminal plugins (priority 20 and 50); the priority-20 terminal
    // is mounted first and therefore matches the request first.
    // Source: Req MH / AR #4
    test('ST-2: terminals run in priority order (lower first)', async () => {
        const mountOrder: number[] = [];

        const low: PluginDefinition = {
            name: 'st2-low',
            priority: 20,
            factory: async () => ({
                terminal: async ({ express }) => {
                    mountOrder.push(20);
                    express.use((req, res, next) => {
                        if (req.method === 'GET' && req.path === '/order') {
                            res.json({ winner: 20 });
                            return;
                        }
                        next();
                    });
                },
            }),
        };

        const high: PluginDefinition = {
            name: 'st2-high',
            priority: 50,
            factory: async () => ({
                terminal: async ({ express }) => {
                    mountOrder.push(50);
                    express.use((req, res, next) => {
                        if (req.method === 'GET' && req.path === '/order') {
                            res.json({ winner: 50 });
                            return;
                        }
                        next();
                    });
                },
            }),
        };

        // Register high first to prove ordering is by priority, not registration.
        const { agent, shutdown } = await createApp({ plugins: [high, low] });
        activeShutdown = shutdown;

        // Mounted in priority order: 20 before 50.
        expect(mountOrder).toEqual([20, 50]);

        // The priority-20 terminal mounted first, so it handles the request first.
        const res = await agent.get('/order').set('Accept', 'text/html');
        expect(res.body).toEqual({ winner: 20 });
    });

    // ST-3: terminal hook receives { app, express, logger }.
    // Source: AR #2
    test('ST-3: terminal params include app, express, and logger', async () => {
        let received: { hasApp: boolean; hasExpress: boolean; hasLogger: boolean } | undefined;

        const plugin: PluginDefinition = {
            name: 'st3-terminal',
            priority: 20,
            factory: async () => ({
                terminal: async (params) => {
                    received = {
                        hasApp: params.app instanceof WebApplication,
                        hasExpress: typeof params.express === 'function',
                        hasLogger: typeof params.logger?.info === 'function',
                    };
                },
            }),
        };

        const { shutdown } = await createApp({ plugins: [plugin] });
        activeShutdown = shutdown;

        expect(received).toEqual({ hasApp: true, hasExpress: true, hasLogger: true });
    });

    // ST-4: plugin factory returns void (no terminal) — no terminal registered,
    // no error, app starts normally.
    // Source: Req Compat / AR #9
    test('ST-4: factory returning void registers no terminal and app starts', async () => {
        const plugin: PluginDefinition = {
            name: 'st4-void',
            priority: 20,
            // Returns void (no object) — must be tolerated.
            factory: async () => {
                return;
            },
        };

        const { agent, shutdown } = await createApp({ plugins: [plugin] });
        activeShutdown = shutdown;

        // App is alive: /health responds.
        const res = await agent.get('/health');
        expect(res.status).toBe(200);
    });
});

// ---------------------------------------------------------------------------
// Specification: SPA Fallback via Terminal Phase
// ---------------------------------------------------------------------------

describe('Specification: SPA Fallback via Terminal Phase', () => {
    let activeShutdown: (() => Promise<void>) | undefined;

    afterEach(async () => {
        if (activeShutdown) {
            await activeShutdown();
            activeShutdown = undefined;
        }
    });

    // ST-5: controller route GET /api/oidc/login (HTML Accept) reaches the
    // controller, NOT index.html.
    // Source: Req MH / AR #3, #6, #11
    test('ST-5: controller route is reached, not swallowed by SPA fallback', async () => {
        const { agent, shutdown } = await createApp({
            plugins: [staticFilesPlugin({ root: tmpDir, spa: true })],
            controllers: [{ basePath: '', controller: OidcLikeController }],
        });
        activeShutdown = shutdown;

        const res = await agent.get('/api/oidc/login').set('Accept', 'text/html');

        // BaseController.ok() wraps payloads in { success: true, data }.
        expect(res.status).toBe(200);
        expect(res.body?.data?.marker).toBe(LOGIN_MARKER);
        expect(res.text).not.toContain('SPA_INDEX');
    });

    // ST-6: GET /health (HTML Accept) returns JSON, not index.html.
    // Source: Req MH / AR #3
    test('ST-6: /health returns JSON, not index.html', async () => {
        const { agent, shutdown } = await createApp({
            plugins: [staticFilesPlugin({ root: tmpDir, spa: true })],
            controllers: [{ basePath: '', controller: OidcLikeController }],
        });
        activeShutdown = shutdown;

        const res = await agent.get('/health').set('Accept', 'text/html');

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('health');
        expect(res.body).toHaveProperty('timestamp');
        expect(res.text).not.toContain('SPA_INDEX');
    });

    // ST-7: GET /about (no controller, no file) with HTML Accept serves index.html.
    // Source: Req SH / AR #6
    test('ST-7: unmatched HTML route still serves index.html (SPA works)', async () => {
        const { agent, shutdown } = await createApp({
            plugins: [staticFilesPlugin({ root: tmpDir, spa: true })],
            controllers: [{ basePath: '', controller: OidcLikeController }],
        });
        activeShutdown = shutdown;

        const res = await agent.get('/about').set('Accept', 'text/html');

        expect(res.status).toBe(200);
        expect(res.text).toContain('SPA_INDEX');
    });

    // ST-8: GET /api/data with Accept: application/json (no controller) falls
    // through to 404, NOT index.html — Accept guard.
    // Source: AR #6
    test('ST-8: JSON Accept falls through to 404, not index.html', async () => {
        const { agent, shutdown } = await createApp({
            plugins: [staticFilesPlugin({ root: tmpDir, spa: true })],
            controllers: [{ basePath: '', controller: OidcLikeController }],
        });
        activeShutdown = shutdown;

        const res = await agent.get('/api/data').set('Accept', 'application/json');

        expect(res.status).toBe(404);
        expect(res.text).not.toContain('SPA_INDEX');
    });

    // ST-9: staticFilesPlugin({ spa: false }) registers no terminal.
    // Source: AR #6
    test('ST-9: spa:false registers no terminal (unmatched HTML route 404s)', async () => {
        const { agent, shutdown } = await createApp({
            plugins: [staticFilesPlugin({ root: tmpDir, spa: false })],
        });
        activeShutdown = shutdown;

        // With no SPA fallback, an unmatched HTML route is a 404 (no index.html).
        const res = await agent.get('/about').set('Accept', 'text/html');

        expect(res.status).toBe(404);
        expect(res.text).not.toContain('SPA_INDEX');
    });

    // ST-10: existing static file is served by express.static (unchanged).
    // Source: Req Compat / AR #6
    test('ST-10: existing static file is served by express.static', async () => {
        const { agent, shutdown } = await createApp({
            plugins: [staticFilesPlugin({ root: tmpDir, spa: true })],
        });
        activeShutdown = shutdown;

        const res = await agent.get('/app.js');

        expect(res.status).toBe(200);
        expect(res.text).toContain('static-asset');
    });
});
