/**
 * Static files and SPA plugin for WebAFX.
 *
 * Provides a typed `staticFilesPlugin()` factory that wraps Express's built-in
 * `express.static()` middleware with optional SPA (Single Page Application)
 * fallback support. The plugin validates the root directory at startup and
 * integrates cleanly with the WebAFX plugin system.
 *
 * Zero additional dependencies — uses Express's built-in static middleware.
 *
 * @packageDocumentation
 */

import { existsSync } from 'fs';
import { resolve, extname } from 'path';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { Plugin, PluginDefinition } from './plugin.js';


// ---------------------------------------------------------------------------
// Default Constants
// ---------------------------------------------------------------------------

/** Default plugin priority — installs alongside other plugins (priority 20) */
const DEFAULT_PLUGIN_PRIORITY = 20;

/** Default URL prefix — serve from root */
const DEFAULT_PREFIX = '/';

/** Default dotfiles handling — pretend they don't exist */
const DEFAULT_DOTFILES = 'ignore';

/** Default index file */
const DEFAULT_INDEX = 'index.html';

// ---------------------------------------------------------------------------
// Configuration Interface
// ---------------------------------------------------------------------------

/**
 * Configuration for the static files plugin.
 *
 * Controls where files are served from, URL mounting, caching behavior,
 * and SPA fallback for client-side routing frameworks.
 */
export interface StaticFilesConfig {
    /**
     * Directory to serve files from.
     * Resolved relative to `process.cwd()`.
     *
     * @example './public'
     * @example './client/build'
     * @example path.join(__dirname, '..', 'dist')
     */
    root: string;

    /**
     * URL prefix to mount at.
     * @default '/'
     *
     * @example '/static' — serves at http://localhost:3000/static/*
     * @example '/assets' — serves at http://localhost:3000/assets/*
     */
    prefix?: string;

    /**
     * Cache-Control max-age directive.
     * Accepts milliseconds (number) or a time string ('1d', '1h', '30m').
     * @default 0 (no caching)
     *
     * @example '1d' — 1 day
     * @example '1h' — 1 hour
     * @example 86400000 — 1 day in milliseconds
     */
    maxAge?: string | number;

    /**
     * Add `immutable` directive to Cache-Control header.
     * Use with hashed filenames (e.g., `main.abc123.js`) for permanent caching.
     * @default false
     */
    immutable?: boolean;

    /**
     * Control dotfile behavior.
     * - `'ignore'` — Pretend dotfiles don't exist (404)
     * - `'allow'` — Serve dotfiles normally
     * - `'deny'` — Respond with 403
     * @default 'ignore'
     */
    dotfiles?: 'ignore' | 'allow' | 'deny';

    /**
     * Directory index file.
     * Set to `false` to disable directory indexing.
     * @default 'index.html'
     */
    index?: string | false;

    /**
     * Enable ETag generation.
     * @default true
     */
    etag?: boolean;

    /**
     * Enable Last-Modified header.
     * @default true
     */
    lastModified?: boolean;

    /**
     * SPA (Single Page Application) mode.
     *
     * When `true`, unmatched GET requests (that don't look like file requests)
     * are served `index.html` from the root directory. This enables client-side
     * routing for React, Vue, Angular, and other SPA frameworks.
     *
     * A request is considered a "file request" if its path contains a file
     * extension in the last segment (e.g., `/styles.css`, `/api/data.json`).
     *
     * @default false
     */
    spa?: boolean;

    /**
     * Plugin priority. Lower numbers install first.
     * @default 20
     */
    priority?: number;
}

// ---------------------------------------------------------------------------
// Plugin Factory
// ---------------------------------------------------------------------------

/**
 * Create a WebAFX plugin for serving static files and SPAs.
 *
 * Wraps Express's `express.static()` with a typed configuration interface
 * and optional SPA fallback support. The root directory is validated at
 * plugin install time — an error is thrown if it doesn't exist.
 *
 * @param config - Static file serving configuration
 * @returns A WebAFX PluginDefinition ready to pass to `app.use()`
 *
 * @example Basic static serving
 * ```typescript
 * app.use(staticFilesPlugin({ root: './public' }));
 * ```
 *
 * @example SPA with React
 * ```typescript
 * app.use(staticFilesPlugin({
 *     root: './client/build',
 *     spa: true,
 * }));
 * ```
 *
 * @example Production assets with caching
 * ```typescript
 * app.use(staticFilesPlugin({
 *     root: './public',
 *     prefix: '/static',
 *     maxAge: '1y',
 *     immutable: true,
 * }));
 * ```
 */
export function staticFilesPlugin(config: StaticFilesConfig): PluginDefinition {
    const prefix = config.prefix ?? DEFAULT_PREFIX;

    // Build a descriptive plugin name — include prefix if non-default
    // so multiple instances are distinguishable in logs
    const pluginName = prefix === DEFAULT_PREFIX
        ? 'static-files'
        : `static-files:${prefix}`;

    return {
        name: pluginName,
        priority: config.priority ?? DEFAULT_PLUGIN_PRIORITY,

        factory: async ({ express: expressApp, logger }) => {
            // Resolve the root directory relative to the current working directory
            const resolvedRoot = resolve(process.cwd(), config.root);

            // Validate that the root directory exists at startup time.
            // Fail fast with a clear error rather than silently serving nothing.
            if (!existsSync(resolvedRoot)) {
                throw new Error(
                    `Static files root directory does not exist: ${resolvedRoot}`
                );
            }

            // Build express.static options from the typed config.
            // Only include options that differ from Express defaults to keep
            // the options object clean and predictable.
            const staticOptions: {
                maxAge?: string | number;
                immutable?: boolean;
                dotfiles?: string;
                index?: string | false;
                etag?: boolean;
                lastModified?: boolean;
            } = {};

            if (config.maxAge !== undefined) {
                staticOptions.maxAge = config.maxAge;
            }
            if (config.immutable !== undefined) {
                staticOptions.immutable = config.immutable;
            }
            staticOptions.dotfiles = config.dotfiles ?? DEFAULT_DOTFILES;
            staticOptions.index = config.index ?? DEFAULT_INDEX;
            if (config.etag !== undefined) {
                staticOptions.etag = config.etag;
            }
            if (config.lastModified !== undefined) {
                staticOptions.lastModified = config.lastModified;
            }

            // Mount the Express static middleware at the configured prefix.
            // This handles serving actual files from the root directory.
            // It stays in the factory (pre-controllers) — serving real files
            // early is correct and never shadows controller routes.
            expressApp.use(prefix, express.static(resolvedRoot, staticOptions));

            await logger.info(
                `Serving static files from ${resolvedRoot} at ${prefix}`
            );

            // Without SPA mode there is nothing else to do — return void, as
            // before, so no terminal hook is registered.
            if (!config.spa) {
                return;
            }

            // SPA fallback is a CATCH-ALL. If mounted here (pre-controllers) it
            // would swallow controller routes that look like HTML navigation
            // (e.g. GET /api/oidc/login). Defer it to the terminal phase, which
            // the framework runs AFTER controllers and /health, before the 404
            // handler — so controllers win and only genuinely unmatched routes
            // are served index.html.
            const indexPath = resolve(resolvedRoot, 'index.html');

            const plugin: Plugin = {
                terminal: async ({ express: terminalExpress, logger: terminalLogger }) => {
                    terminalExpress.use(
                        prefix,
                        createSpaFallbackMiddleware(indexPath)
                    );

                    await terminalLogger.info(
                        'SPA fallback enabled (terminal phase) — unmatched routes serve index.html'
                    );
                },
            };

            return plugin;
        },
    };
}

// ---------------------------------------------------------------------------
// SPA Fallback Middleware (internal)
// ---------------------------------------------------------------------------

/**
 * Create a SPA fallback middleware that serves `index.html` for unmatched
 * client-side routes.
 *
 * The middleware applies three guard conditions to avoid interfering with
 * API routes and actual file requests:
 *
 * 1. **Method guard** — Only handles GET requests (POST, PUT, DELETE pass through)
 * 2. **File extension guard** — Paths with extensions (e.g., `.css`, `.js`) pass
 *    through to 404 (they're missing files, not client routes)
 * 3. **Accept header guard** — Only responds to requests that accept `text/html`
 *    (JSON/API requests pass through)
 *
 * @param indexPath - Absolute path to the index.html file to serve
 * @returns Express middleware function
 *
 * @internal
 */
function createSpaFallbackMiddleware(
    indexPath: string
): (req: Request, res: Response, next: NextFunction) => void {
    return (req: Request, res: Response, next: NextFunction): void => {
        // Guard 1: Only handle GET requests — API mutations (POST, PUT, DELETE)
        // should always pass through to the router
        if (req.method !== 'GET') {
            next();
            return;
        }

        // Guard 2: If the path has a file extension, it's a request for a
        // specific file that wasn't found by express.static — let it 404
        if (hasFileExtension(req.path)) {
            next();
            return;
        }

        // Guard 3: Only serve index.html to clients that want HTML.
        // API clients sending Accept: application/json should get a proper
        // 404/API response, not an HTML page.
        const acceptHeader = req.headers.accept || '';
        if (!acceptHeader.includes('text/html')) {
            next();
            return;
        }

        // All guards passed — this looks like a client-side route.
        // Serve index.html and let the SPA's client-side router handle it.
        res.sendFile(indexPath);
    };
}

/**
 * Check if a URL path has a file extension in its last segment.
 *
 * Uses Node's `path.extname()` to detect extensions like `.css`, `.js`, `.png`.
 * Paths without extensions (e.g., `/about`, `/settings/profile`) are considered
 * client-side routes for SPA fallback purposes.
 *
 * @param urlPath - The URL path to check (e.g., '/about', '/styles.css')
 * @returns `true` if the path has a file extension, `false` otherwise
 *
 * @internal
 */
function hasFileExtension(urlPath: string): boolean {
    return extname(urlPath) !== '';
}
