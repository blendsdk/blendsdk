/**
 * Implementation tests for the absolute session lifetime.
 *
 * These cover boundary and persistence details beyond the specification cases:
 * the exact deadline, clock skew, and the no-stamp path when the option is
 * unset.
 *
 * @packageDocumentation
 */

import { describe, expect, it } from "vitest";

import { OidcAuthProvider } from "../src/oidc-auth-provider.js";
import type { OidcSession } from "../src/oidc-types.js";
import { createMockCacheProvider } from "./test-helpers.js";

/** Monotonic "now" in seconds, matched to the session fixtures. */
const NOW = Math.floor(Date.now() / 1000);

/** Session id used across the tests. */
const SESSION_ID = "session-impl";

/**
 * Build a provider backed by an in-memory cache, optionally with an absolute
 * TTL.
 */
function makeProvider(absoluteTtl?: number): {
    provider: OidcAuthProvider;
    store: Map<string, { value: unknown; expiresAt: number }>;
} {
    const { provider: cache, store } = createMockCacheProvider();
    const provider = new OidcAuthProvider({
        issuerUrl: "https://auth.example.com",
        clientId: "test-client",
        sessionStore: cache,
        ...(absoluteTtl === undefined ? {} : { sessionAbsoluteTtl: absoluteTtl }),
    });
    return { provider, store };
}

/** Build a session with overridable fields. */
function session(overrides: Partial<OidcSession> = {}): OidcSession {
    return {
        accessToken: "access",
        user: { sub: "user-1" },
        expiresAt: NOW + 3600,
        ...overrides,
    };
}

describe("Absolute session lifetime — implementation edge cases", () => {
    it("rejects exactly at the deadline (now === createdAt + ttl)", async () => {
        const { provider, store } = makeProvider(100);
        store.set(`oidc:session:${SESSION_ID}`, {
            value: session({ createdAt: NOW - 100 }),
            expiresAt: 0,
        });

        expect(await provider.getSession(SESSION_ID)).toBeUndefined();
        expect(store.has(`oidc:session:${SESSION_ID}`)).toBe(false);
    });

    it("accepts a session with a future createdAt (clock skew)", async () => {
        const { provider, store } = makeProvider(100);
        store.set(`oidc:session:${SESSION_ID}`, {
            value: session({ createdAt: NOW + 10 }),
            expiresAt: 0,
        });

        expect(await provider.getSession(SESSION_ID)).toBeDefined();
    });

    it("preserves an existing createdAt across a later store", async () => {
        const { provider, store } = makeProvider(100);

        await provider.storeSession(SESSION_ID, session({ createdAt: NOW - 50 }));
        const first = store.get(`oidc:session:${SESSION_ID}`)?.value as OidcSession;
        await provider.storeSession(SESSION_ID, {
            ...first,
            accessToken: "new-access",
        });
        const second = store.get(`oidc:session:${SESSION_ID}`)?.value as OidcSession;

        expect(second.createdAt).toBe(NOW - 50);
    });

    it("leaves a legacy session without createdAt untouched when an absolute ttl is set", async () => {
        const { provider, store } = makeProvider(100);
        store.set(`oidc:session:${SESSION_ID}`, {
            value: session(),
            expiresAt: 0,
        });

        const found = await provider.getSession(SESSION_ID);

        expect(found).toBeDefined();
        expect(store.has(`oidc:session:${SESSION_ID}`)).toBe(true);
    });
});
