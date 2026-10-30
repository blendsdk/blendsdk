/**
 * Minimal in-process OIDC provider used by integration tests.
 *
 * Serves just enough of the OpenID Connect protocol for `OidcAuthProvider` to
 * perform discovery, fetch a JWKS, and exchange an authorization code:
 *
 * - `GET  /.well-known/openid-configuration` — provider metadata
 * - `GET  /jwks` — the signing key set
 * - `POST /token` — issues an access token and a signed ID token
 * - `GET  /userinfo` — returns the user subject
 * - `POST /revoke` — accepts any revocation
 *
 * It can run over plain HTTP (for `allowInsecureRequests`) or HTTPS with the
 * committed self-signed fixture (for custom-CA tests). Tests may swap the
 * ID-token signing key at runtime to produce a rogue-key token, change the
 * UserInfo subject independently of the ID token, omit the ID token to
 * exercise the OAuth2 (no-ID-token) code path, force a token-endpoint OAuth
 * error body, or force a UserInfo status such as `403` (optionally with a
 * bearer challenge header).
 *
 * @packageDocumentation
 */

import { createServer as createHttpServer, type Server } from "node:http";
import {
    createServer as createHttpsServer,
    type Server as HttpsServer,
} from "node:https";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
    SignJWT,
    exportJWK,
    generateKeyPair,
    type JWK,
    type KeyLike,
} from "jose";

/** Absolute directory that holds the TLS fixture files. */
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** Key id shared by the JWKS entry and issued ID tokens. */
const KEY_ID = "test-key";

/** Metadata and lifecycle for a running test provider. */
export interface OidcTestServer {
    /** Issuer identifier; also the discovery base URL. */
    readonly issuer: string;
    /** JWKS endpoint advertised in discovery metadata. */
    readonly jwksUri: string;
    /** Public signing key, exported as a JWK. */
    readonly publicJwk: JWK;
    /** Extra claims merged into every issued ID token. */
    readonly idTokenClaims: Record<string, unknown>;
    /** Access token value returned by the token endpoint. */
    readonly accessToken: string;
    /** Refresh token value returned by the token endpoint. */
    readonly refreshToken: string;
    /**
     * Override the key used to sign issued ID tokens.
     *
     * Set to a different key to simulate a rogue-key token; pass `undefined`
     * to restore the provider's own key.
     */
    setIdTokenSigningKey(key: KeyLike | undefined): void;
    /**
     * Override the `kid` header of issued ID tokens.
     *
     * Set to a value absent from the JWKS to simulate a key-rotation race or a
     * forged token; pass `undefined` to restore the provider's own key id.
     */
    setIdTokenKeyId(kid: string | undefined): void;
    /**
     * Sign an ID token with the current signing key and optional claim
     * overrides. Useful for producing tampered or rogue tokens.
     */
    signIdToken(overrides?: Record<string, unknown>): Promise<string>;
    /**
     * Force the token endpoint to return a specific ID token, clear the
     * override with `undefined`, or omit the ID token entirely with `null`.
     */
    setIdToken(token: string | null | undefined): void;
    /**
     * Set the subject returned by the UserInfo endpoint independently of the
     * ID-token subject, so tests can produce a mismatch.
     */
    setUserInfoSubject(subject: string): void;
    /**
     * Force the token endpoint to answer `400` with the given OAuth error
     * body (for example `{ error: "invalid_grant" }`), or clear the override
     * with `undefined`.
     */
    setTokenError(
        error: { error: string; error_description?: string } | undefined
    ): void;
    /**
     * Override the status of the UserInfo endpoint. Default `200`. When
     * `challenge` is true a bearer `WWW-Authenticate` header is added, so
     * tests can reach both library error shapes for a denial.
     */
    setUserInfoStatus(status: number, options?: { challenge?: boolean }): void;
    /** Stop the server and release its port. */
    close(): Promise<void>;
}

/**
 * Options controlling how the test provider starts.
 */
export interface StartOidcTestServerOptions {
    /**
     * Serve over HTTPS with the committed self-signed certificate. When false
     * (default), serve over plain HTTP on loopback.
     */
    tls?: boolean;
}

/**
 * Start an in-process OIDC provider on an ephemeral loopback port.
 *
 * @param options - Transport selection for the server
 * @returns A running {@link OidcTestServer}
 */
export async function startOidcTestServer(
    options: StartOidcTestServerOptions = {}
): Promise<OidcTestServer> {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = KEY_ID;
    publicJwk.use = "sig";
    publicJwk.alg = "RS256";

    const state = {
        signingKey: privateKey as KeyLike,
        keyId: KEY_ID,
        idTokenClaims: {} as Record<string, unknown>,
        /** `null` omits the ID token; `undefined` uses the generated token. */
        forcedIdToken: undefined as string | null | undefined,
        userInfoSubject: "test-user-1",
        tokenError: undefined as
            | { error: string; error_description?: string }
            | undefined,
        userInfoStatus: 200,
        userInfoChallenge: false,
    };
    const accessToken = "test-access-token";
    const refreshToken = "test-refresh-token";

    let issuer = "";
    let jwksUri = "";

    const handler = async (
        req: import("node:http").IncomingMessage,
        res: import("node:http").ServerResponse
    ): Promise<void> => {
        const url = new URL(req.url ?? "/", issuer);

        if (url.pathname === "/.well-known/openid-configuration") {
            sendJson(res, {
                issuer,
                authorization_endpoint: `${issuer}/authorize`,
                token_endpoint: `${issuer}/token`,
                jwks_uri: jwksUri,
                userinfo_endpoint: `${issuer}/userinfo`,
                revocation_endpoint: `${issuer}/revoke`,
                response_types_supported: ["code"],
                subject_types_supported: ["public"],
                id_token_signing_alg_values_supported: ["RS256"],
                token_endpoint_auth_methods_supported: [
                    "client_secret_post",
                    "client_secret_basic",
                ],
            });
            return;
        }

        if (url.pathname === "/jwks") {
            sendJson(res, { keys: [publicJwk] });
            return;
        }

        if (url.pathname === "/token" && req.method === "POST") {
            if (state.tokenError) {
                sendJson(res, state.tokenError, 400);
                return;
            }
            const idToken =
                state.forcedIdToken === null
                    ? undefined
                    : state.forcedIdToken ??
                      (await createIdToken(
                          state.signingKey,
                          issuer,
                          accessToken,
                          state.idTokenClaims,
                          state.keyId
                      ));
            sendJson(res, {
                access_token: accessToken,
                token_type: "Bearer",
                expires_in: 3600,
                refresh_token: refreshToken,
                ...(idToken === undefined ? {} : { id_token: idToken }),
            });
            return;
        }

        if (url.pathname === "/userinfo") {
            if (state.userInfoStatus !== 200) {
                if (state.userInfoChallenge) {
                    res.setHeader(
                        "www-authenticate",
                        'Bearer error="insufficient_scope"'
                    );
                }
                sendJson(res, { error: "insufficient_scope" }, state.userInfoStatus);
                return;
            }
            sendJson(res, { sub: state.userInfoSubject, name: "Test User" });
            return;
        }

        if (url.pathname === "/revoke") {
            res.statusCode = 200;
            res.end();
            return;
        }

        res.statusCode = 404;
        res.end();
    };

    const server: Server | HttpsServer = options.tls
        ? createHttpsServer(
              {
                  key: readFileSync(join(FIXTURE_DIR, "localhost-key.pem")),
                  cert: readFileSync(join(FIXTURE_DIR, "localhost-cert.pem")),
              },
              (req, res) => {
                  void handler(req, res);
              }
          )
        : createHttpServer((req, res) => {
              void handler(req, res);
          });

    const listenHost = options.tls ? "localhost" : "127.0.0.1";
    await new Promise<void>((resolve) => server.listen(0, listenHost, resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("Failed to determine test server port");
    }

    const host = options.tls ? "localhost" : "127.0.0.1";
    const scheme = options.tls ? "https" : "http";
    issuer = `${scheme}://${host}:${address.port}`;
    jwksUri = `${issuer}/jwks`;

    return {
        issuer,
        jwksUri,
        publicJwk,
        idTokenClaims: state.idTokenClaims,
        accessToken,
        refreshToken,
        setIdTokenSigningKey(key: KeyLike | undefined): void {
            state.signingKey = key ?? privateKey;
        },
        setIdTokenKeyId(kid: string | undefined): void {
            state.keyId = kid ?? KEY_ID;
        },
        signIdToken(overrides?: Record<string, unknown>): Promise<string> {
            return createIdToken(
                state.signingKey,
                issuer,
                accessToken,
                {
                    ...state.idTokenClaims,
                    ...overrides,
                },
                state.keyId
            );
        },
        setIdToken(token: string | null | undefined): void {
            state.forcedIdToken = token;
        },
        setUserInfoSubject(subject: string): void {
            state.userInfoSubject = subject;
        },
        setTokenError(
            error: { error: string; error_description?: string } | undefined
        ): void {
            state.tokenError = error;
        },
        setUserInfoStatus(status: number, options?: { challenge?: boolean }): void {
            state.userInfoStatus = status;
            state.userInfoChallenge = options?.challenge === true;
        },
        close(): Promise<void> {
            return new Promise<void>((resolve, reject) => {
                server.close((err) => (err ? reject(err) : resolve()));
            });
        },
    };
}

/**
 * Build the self-signed HTTPS certificate authority PEM for tests.
 *
 * @returns The committed certificate in PEM form, suitable for the `ca` option
 */
export function readTestCa(): string {
    return readFileSync(join(FIXTURE_DIR, "localhost-cert.pem"), "utf8");
}

/**
 * Create and sign an ID token for the token endpoint response.
 */
async function createIdToken(
    key: KeyLike,
    issuer: string,
    accessToken: string,
    overrides: Record<string, unknown>,
    kid: string = KEY_ID
): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
        sub: "test-user-1",
        aud: "test-client",
        iss: issuer,
        iat: now,
        exp: now + 3600,
        at_hash: undefined,
        ...overrides,
    })
        .setProtectedHeader({ alg: "RS256", kid })
        .sign(key);
}

/**
 * Write a JSON response with the correct content type.
 *
 * @param res - Node server response
 * @param body - JSON body to serialize
 * @param status - HTTP status to send; defaults to `200`
 */
function sendJson(
    res: import("node:http").ServerResponse,
    body: Record<string, unknown>,
    status = 200
): void {
    const payload = JSON.stringify(body);
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.setHeader("content-length", Buffer.byteLength(payload));
    res.end(payload);
}
