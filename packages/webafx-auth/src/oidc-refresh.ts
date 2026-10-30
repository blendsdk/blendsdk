/**
 * Single-flight execution of OIDC session refreshes.
 *
 * The controller's `POST /refresh` route reads a session, exchanges its
 * refresh token, stores the updated session, and optionally rotates the
 * session id. Running that sequence twice concurrently for one session can
 * consume a rotating refresh token twice, store the session twice, and create
 * two rotated ids. This module coalesces the sequence so concurrent requests
 * share one execution and one outcome.
 *
 * The runner is process-local: it coalesces calls that reach one controller
 * instance. A deployment with several application instances needs an external
 * lock.
 *
 * @packageDocumentation
 */

import { randomUUID } from "node:crypto";
import type { OidcAuthProvider } from "./oidc-auth-provider.js";
import type { OidcAuthConfig, OidcSession } from "./oidc-types.js";
import { generateCsrfToken } from "./oidc-helpers.js";

/**
 * Outcome of one coalesced refresh execution.
 *
 * A discriminated union keeps the three terminal states explicit: the session
 * could not be found, it had no refresh token, or a refresh completed and the
 * caller should present the returned session id.
 */
export type RefreshOutcome =
    | { status: "no_session" }
    | { status: "no_refresh_token" }
    | {
          status: "ok";
          /** Session id the caller should present in its cookie. */
          sessionId: string;
          /** New access-token expiry in epoch seconds, when known. */
          expiresAt?: number;
          /** Session CSRF token to return when enforcement is enabled. */
          csrfToken?: string;
      };

/**
 * Coalesces concurrent executions that share a key.
 *
 * The first caller starts the task and every later caller for the same key
 * receives the same promise. The entry is removed when the promise settles,
 * whether it resolves or rejects, so a failure cannot wedge the key.
 *
 * @example
 * ```typescript
 * const flights = new RefreshSingleFlight();
 * const outcome = await flights.run(sessionId, () => executeSessionRefresh(params));
 * ```
 */
export class RefreshSingleFlight {
    /** In-flight executions, keyed by session id. */
    private readonly inFlight = new Map<string, Promise<RefreshOutcome>>();

    /**
     * Run `task` once for `key`, sharing the result with concurrent callers.
     *
     * @param key - Coalescing key; the session id for a refresh
     * @param task - Work to run once, typically `executeSessionRefresh`
     * @returns The shared outcome; a rejected task rejects every joined caller
     */
    run(key: string, task: () => Promise<RefreshOutcome>): Promise<RefreshOutcome> {
        const existing = this.inFlight.get(key);
        if (existing) {
            return existing;
        }

        // The async wrapper starts the task synchronously (so the entry is
        // registered before any await) while turning a synchronous throw into a
        // rejection, keeping the promise contract for every caller.
        const pending = (async () => task())();
        this.inFlight.set(key, pending);
        return pending.finally(() => {
            // Only remove our own entry: a later execution may have replaced it
            // after this one settled.
            if (this.inFlight.get(key) === pending) {
                this.inFlight.delete(key);
            }
        });
    }
}

/**
 * Parameters for {@link executeSessionRefresh}.
 */
export interface ExecuteSessionRefreshParams {
    /** Provider that owns the session store and performs the grant. */
    provider: OidcAuthProvider;
    /** Id of the session to refresh, read from the request cookie. */
    sessionId: string;
    /** Optional per-request configuration resolved by the controller. */
    config?: OidcAuthConfig;
    /** Whether the provider enables CSRF tokens on sessions. */
    csrfEnabled: boolean;
}

/**
 * Perform the shared read → refresh → store/rotate work for one session.
 *
 * The session is re-read here rather than passed in: a rotation may have
 * completed while the caller waited for the single-flight lock, and the fresh
 * entry is the only one whose refresh token is still valid. When the id no
 * longer resolves, the outcome is `no_session`; when the entry lost its
 * refresh token, the outcome is `no_refresh_token`.
 *
 * The caller writes the cookie and the HTTP response from the returned
 * outcome, so every joined request still receives the rotated id.
 *
 * @param params - Provider, session id, optional config, CSRF flag
 * @returns The refresh outcome
 * @throws When the grant or the session store fails; every joined caller sees
 *   the same rejection
 */
export async function executeSessionRefresh(
    params: ExecuteSessionRefreshParams
): Promise<RefreshOutcome> {
    const { provider, sessionId, config, csrfEnabled } = params;

    const session = await provider.getSession(sessionId);
    if (!session) {
        return { status: "no_session" };
    }
    if (!session.refreshToken) {
        return { status: "no_refresh_token" };
    }

    const newTokens = config
        ? await provider.refreshToken(session.refreshToken, config)
        : await provider.refreshToken(session.refreshToken);

    // Preserve the old refresh token and ID token when the IdP does not rotate
    // them, so a non-rotating provider keeps the session usable.
    const updatedSession: OidcSession = {
        ...session,
        accessToken: newTokens.accessToken,
        refreshToken: newTokens.refreshToken ?? session.refreshToken,
        idToken: newTokens.idToken ?? session.idToken,
        expiresAt: newTokens.expiresIn
            ? Math.floor(Date.now() / 1000) + newTokens.expiresIn
            : session.expiresAt,
    };

    if (provider.shouldRotateSessionIdOnRefresh()) {
        // Regenerate the CSRF token with the id so a token captured before the
        // refresh cannot be replayed against the new session.
        if (csrfEnabled) {
            updatedSession.csrfToken = generateCsrfToken();
        }
        const newSessionId = randomUUID();
        await provider.storeSession(newSessionId, updatedSession);
        await provider.clearSession(sessionId);
        return {
            status: "ok",
            sessionId: newSessionId,
            expiresAt: updatedSession.expiresAt,
            csrfToken: updatedSession.csrfToken,
        };
    }

    await provider.storeSession(sessionId, updatedSession);
    return {
        status: "ok",
        sessionId,
        expiresAt: updatedSession.expiresAt,
        csrfToken: updatedSession.csrfToken,
    };
}
