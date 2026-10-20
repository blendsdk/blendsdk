/**
 * Zero-dependency fetch implementation for OIDC transport security.
 *
 * `openid-client` and `jose` accept a custom fetch. When a provider enables
 * transport relaxation (a private CA and/or non-HTTPS issuers), this module
 * builds a fetch function backed by `node:http`/`node:https` so those libraries
 * use the requested trust settings for discovery, JWKS, token, refresh,
 * revocation, and userinfo requests.
 *
 * When no relaxation is requested the factory returns `undefined`, so callers
 * keep the runtime's default `fetch` and no behavior changes.
 *
 * @packageDocumentation
 */

import { request as httpRequest, type IncomingMessage } from "node:http";
import {
    request as httpsRequest,
    type RequestOptions as HttpsRequestOptions,
} from "node:https";
import { Readable } from "node:stream";

import type { AuthTransportSecurity } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of redirect hops followed before the request fails. */
const MAX_REDIRECTS = 5;

/** Status codes whose responses must not carry a body. */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A `fetch`-compatible function bound to a specific transport configuration.
 *
 * The signature is intentionally a superset of what `openid-client` and `jose`
 * pass, so the same function can be handed to either library.
 */
export type TlsFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a fetch implementation bound to the supplied transport options.
 *
 * Returns `undefined` when no relaxation is requested — either no `transport`
 * at all, or a `transport` with neither a non-empty `ca` nor
 * `allowInsecureRequests: true`. Callers treat `undefined` as "use the default
 * transport".
 *
 * @param transport - Optional transport-security controls
 * @returns A fetch function, or `undefined` when the default transport applies
 *
 * @example
 * ```typescript
 * const tlsFetch = createTlsFetch({ ca: process.env.IDP_CA_PEM });
 * if (tlsFetch) {
 *     // discovery/JWKS calls use the private CA
 * }
 * ```
 */
export function createTlsFetch(
    transport?: AuthTransportSecurity
): TlsFetch | undefined {
    const ca = transport?.ca;
    const hasCa = ca !== undefined && ca.length > 0;
    const insecure = transport?.allowInsecureRequests === true;

    if (!hasCa && !insecure) {
        return undefined;
    }

    return function tlsFetch(url: string | URL, init?: RequestInit): Promise<Response> {
        const target = typeof url === "string" ? new URL(url) : url;
        return performRequest(target, init ?? {}, transport, 0);
    };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * A request body normalized to a form `node:http` can write directly.
 */
interface NormalizedBody {
    /** Value passed to `req.end()`; omitted when there is no body. */
    data?: string | Buffer;
    /** Byte length when known, used to set `Content-Length`. */
    contentLength?: number;
}

/**
 * Normalize a fetch body into a value Node can write.
 *
 * Supports the body types the OIDC flows use: strings, `URLSearchParams`, and
 * byte buffers. Other body types (for example streams) throw, because silently
 * sending an empty body would be worse than failing loudly.
 *
 * @param body - The fetch `body` value
 * @returns The normalized body and its byte length
 * @throws TypeError when the body type is not supported
 */
function normalizeBody(body: RequestInit["body"]): NormalizedBody {
    if (body === undefined || body === null) {
        return {};
    }
    if (typeof body === "string") {
        return { data: body, contentLength: Buffer.byteLength(body) };
    }
    if (body instanceof URLSearchParams) {
        const data = body.toString();
        return { data, contentLength: Buffer.byteLength(data) };
    }
    if (Buffer.isBuffer(body)) {
        return { data: body, contentLength: body.byteLength };
    }
    if (ArrayBuffer.isView(body)) {
        const data = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
        return { data, contentLength: data.byteLength };
    }
    if (body instanceof ArrayBuffer) {
        const data = Buffer.from(body);
        return { data, contentLength: data.byteLength };
    }
    throw new TypeError(
        "createTlsFetch: unsupported request body type; use a string, " +
            "URLSearchParams, or a byte buffer"
    );
}

/**
 * Execute one HTTP request, following redirects up to the configured cap.
 *
 * @param url - Absolute request URL
 * @param init - Fetch options
 * @param transport - Transport-security controls
 * @param redirectCount - Redirects followed so far
 * @returns The response, with redirects resolved unless `redirect: "manual"`
 */
async function performRequest(
    url: URL,
    init: RequestInit,
    transport: AuthTransportSecurity | undefined,
    redirectCount: number
): Promise<Response> {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const body = normalizeBody(init.body);
    if (body.contentLength !== undefined && !headers.has("content-length")) {
        headers.set("content-length", String(body.contentLength));
    }

    const isHttps = url.protocol === "https:";
    const options: HttpsRequestOptions = {
        method,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        headers: Object.fromEntries(headers.entries()),
        signal: init.signal ?? undefined,
    };
    if (isHttps) {
        if (transport?.ca !== undefined) {
            options.ca = transport.ca;
        }
        options.rejectUnauthorized = transport?.allowInsecureRequests !== true;
    }

    const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = (isHttps ? httpsRequest : httpRequest)(options, resolve);
        req.on("error", reject);
        if (body.data !== undefined) {
            req.end(body.data);
        } else {
            req.end();
        }
    });

    const status = response.statusCode ?? 500;
    if (
        status >= 300 &&
        status < 400 &&
        init.redirect !== "manual" &&
        response.headers.location
    ) {
        const location = response.headers.location;
        // Drain the redirect response so the socket can be reused or closed.
        response.resume();
        if (redirectCount >= MAX_REDIRECTS) {
            throw new Error(
                `createTlsFetch: exceeded ${MAX_REDIRECTS} redirects for ${url.href}`
            );
        }
        const nextUrl = new URL(location, url);

        // Never downgrade an https request to plain http on a redirect, and
        // never forward credentials to a different origin. Standard fetch
        // strips these headers on cross-origin redirects; this shim must not
        // be weaker than the transport it replaces.
        if (url.protocol === "https:" && nextUrl.protocol === "http:") {
            throw new Error(
                `createTlsFetch: refusing to follow an https-to-http redirect to ${nextUrl.href}`
            );
        }
        const nextHeaders = new Headers(headers);
        if (nextUrl.origin !== url.origin) {
            nextHeaders.delete("authorization");
            nextHeaders.delete("cookie");
            nextHeaders.delete("proxy-authorization");
        }

        const preserveMethod = status === 307 || status === 308;
        if (!preserveMethod) {
            // A rewritten GET/HEAD has no body. Forwarding the original body
            // headers would make the server wait for bytes that never arrive,
            // so drop the full Fetch request-body-header set.
            nextHeaders.delete("content-length");
            nextHeaders.delete("content-type");
            nextHeaders.delete("content-encoding");
            nextHeaders.delete("content-language");
            nextHeaders.delete("content-location");
        }
        return performRequest(
            nextUrl,
            {
                ...init,
                headers: nextHeaders,
                method: preserveMethod ? method : "GET",
                body: preserveMethod ? init.body : undefined,
            },
            transport,
            redirectCount + 1
        );
    }

    return toResponse(response, status);
}

/**
 * Convert a Node response into a fetch `Response`.
 *
 * @param response - The Node incoming message
 * @param status - The response status code
 * @returns A fetch `Response` with status, status text, and headers copied
 */
function toResponse(response: IncomingMessage, status: number): Response {
    const headers = new Headers();
    for (const [key, value] of Object.entries(response.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
            for (const item of value) headers.append(key, item);
        } else {
            headers.set(key, value);
        }
    }

    if (NULL_BODY_STATUSES.has(status)) {
        response.resume();
        return new Response(null, {
            status,
            statusText: response.statusMessage,
            headers,
        });
    }

    const body = Readable.toWeb(response);
    return new Response(body, {
        status,
        statusText: response.statusMessage,
        headers,
    });
}
