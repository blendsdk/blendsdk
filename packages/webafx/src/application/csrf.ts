import { NextFunction, Request, RequestHandler, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import type { PluginDefinition } from './plugin.js';

/**
 * CSRF protection for cookie-authenticated applications.
 *
 * A cookie is sent automatically by the browser on every request, so a
 * mutating endpoint that trusts a session cookie can be triggered from another
 * site. This middleware requires a token that a cross-site form cannot read or
 * set, then compares it in constant time.
 *
 * Two mechanisms are supported:
 *
 * - **Session-bound** — supply `expectedToken` to derive the expected value
 *   from the authenticated session (for example, a token stored server-side
 *   and returned to the client through an authenticated endpoint).
 * - **Double-submit cookie** — supply `cookie` to compare the header against a
 *   cookie value. This is unsigned: it is a defence in depth, not a substitute
 *   for binding the token to the session.
 *
 * At least one of `expectedToken` or `cookie` is required. With neither, the
 * middleware fails closed and rejects every mutating request, because there is
 * no token to compare against.
 *
 * @example
 * ```typescript
 * app.express.use(csrfMiddleware({
 *   expectedToken: req => getSession(req)?.csrfToken,
 * }));
 * ```
 */
export interface CsrfOptions {
  /** Header carrying the client token. Default: `'x-csrf-token'`. */
  header?: string;
  /** Methods exempt because they do not change state. Default: `['GET', 'HEAD', 'OPTIONS']`. */
  safeMethods?: string[];
  /** Exact `` `${METHOD} ${path}` `` requests exempt (for example a pre-auth endpoint). Default: `[]`. */
  exempt?: string[];
  /** Resolve the expected token for the request (session-bound mode). */
  expectedToken?: (
    req: Request
  ) => string | undefined | Promise<string | undefined>;
  /** Optional unsigned double-submit-cookie mode. */
  cookie?: { name: string };
}

/** Default header name carrying the client token. */
const DEFAULT_HEADER = 'x-csrf-token';

/** Methods treated as safe when no override is supplied. */
const DEFAULT_SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

/** Error code returned in the WebAFX envelope on a CSRF failure. */
const CSRF_ERROR_CODE = 'csrf_invalid';

/**
 * Compare two token strings without leaking their contents through timing.
 *
 * A length mismatch fails immediately: `timingSafeEqual` throws when the two
 * buffers differ in length, and the length itself is not secret. An absent or
 * empty expected token always fails, so a request is never accepted because the
 * server had nothing to compare against.
 *
 * @param provided - Token sent by the client
 * @param expected - Token the request must present
 * @returns True when both are present and byte-for-byte equal
 */
export function constantTimeTokenMatch(
  provided: string | undefined,
  expected: string | undefined
): boolean {
  if (provided === undefined || expected === undefined || expected === '') {
    return false;
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Create a middleware that rejects mutating requests with a missing or wrong
 * CSRF token.
 *
 * Safe methods and exact `exempt` entries pass through. The header name is
 * matched case-insensitively, because Express lower-cases incoming header
 * names. On failure the response is `403` with the standard WebAFX error
 * envelope; the handler is never called.
 *
 * @param options - Header, exemptions, and token-resolution strategy
 * @returns An Express request handler
 */
export function csrfMiddleware(options: CsrfOptions = {}): RequestHandler {
  const header = (options.header ?? DEFAULT_HEADER).toLowerCase();
  const safeMethods = new Set(
    (options.safeMethods ?? DEFAULT_SAFE_METHODS).map(method => method.toUpperCase())
  );
  const exempt = new Set(options.exempt ?? []);
  const cookieName = options.cookie?.name;

  return async (req: Request, res: Response, next: NextFunction) => {
    const method = (req.method ?? 'GET').toUpperCase();
    if (safeMethods.has(method)) {
      next();
      return;
    }
    if (exempt.has(`${method} ${req.path}`)) {
      next();
      return;
    }

    const rawProvided = req.headers[header];
    const provided = Array.isArray(rawProvided) ? rawProvided[0] : rawProvided;

    let expected: string | undefined;
    if (options.expectedToken) {
      expected = await options.expectedToken(req);
    } else if (cookieName) {
      expected = req.cookies?.[cookieName];
    }

    if (!constantTimeTokenMatch(provided, expected)) {
      res.status(403).json({
        success: false,
        error: {
          code: CSRF_ERROR_CODE,
          message: 'Invalid or missing CSRF token',
        },
      });
      return;
    }

    next();
  };
}

/**
 * Install CSRF protection application-wide as a WebAFX plugin.
 *
 * The plugin mounts {@link csrfMiddleware} through the underlying Express
 * application, before controllers are registered, so every mutating request is
 * checked. Use this when most routes need protection; use `csrfMiddleware`
 * directly when only selected routes do.
 *
 * @param options - Header, exemptions, and token-resolution strategy
 * @returns A WebAFX plugin definition
 *
 * @example
 * ```typescript
 * app.use(csrfPlugin({ cookie: { name: 'csrf' } }));
 * ```
 */
export function csrfPlugin(options: CsrfOptions = {}): PluginDefinition {
  const middleware = csrfMiddleware(options);
  return {
    name: 'csrf',
    priority: 50,
    factory: async ({ express }) => {
      express.use(middleware);
    },
  };
}
