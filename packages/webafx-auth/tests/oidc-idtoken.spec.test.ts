/**
 * Specification tests for ID-token signature verification on code exchange.
 *
 * A valid ID token signed by the issuer is accepted. A token signed by an
 * unrelated key, or with a tampered payload or claims, is rejected. An explicit
 * opt-out skips the signature check.
 *
 * @packageDocumentation
 */

import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPair } from "jose";

import { OidcAuthProvider } from "../src/oidc-auth-provider.js";
import { startOidcTestServer, type OidcTestServer } from "./oidc-test-server.js";

/** Running test providers, closed after each test. */
const servers: OidcTestServer[] = [];

afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** Start a plain-HTTP provider and register it for cleanup. */
async function startServer(): Promise<OidcTestServer> {
    const server = await startOidcTestServer();
    servers.push(server);
    return server;
}

/** Build a provider bound to a test server. */
function makeProvider(
    server: OidcTestServer,
    verifyIdTokenSignature?: boolean
): OidcAuthProvider {
    return new OidcAuthProvider({
        issuerUrl: server.issuer,
        clientId: "test-client",
        clientSecret: "test-secret",
        redirectUri: "https://app.example.com/callback",
        transport: { allowInsecureRequests: true },
        ...(verifyIdTokenSignature === undefined ? {} : { verifyIdTokenSignature }),
    });
}

/** Prepare a callback URL and set the shared nonce on the server. */
async function prepare(
    provider: OidcAuthProvider,
    server: OidcTestServer
): Promise<{ codeVerifier: string; nonce: string; callbackUrl: string }> {
    const auth = await provider.buildAuthorizationUrl();
    server.idTokenClaims.nonce = auth.nonce;
    return {
        codeVerifier: auth.codeVerifier,
        nonce: auth.nonce,
        callbackUrl: `https://app.example.com/callback?code=test-code&state=${auth.state}`,
    };
}

/** Encode a JSON payload as base64url without padding. */
function base64url(value: unknown): string {
    return Buffer.from(JSON.stringify(value))
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

describe("ID-token verification — Specification Tests", () => {
    it("accepts an ID token signed by the issuer key (ST-9)", async () => {
        const server = await startServer();
        const provider = makeProvider(server);
        const params = await prepare(provider, server);

        const tokens = await provider.exchangeCode(params);

        expect(tokens.accessToken).toBe(server.accessToken);
    });

    it("rejects an ID token signed by an unrelated key (ST-10)", async () => {
        const server = await startServer();
        const provider = makeProvider(server);
        const params = await prepare(provider, server);
        const { privateKey: rogueKey } = await generateKeyPair("RS256");
        server.setIdTokenSigningKey(rogueKey);

        await expect(provider.exchangeCode(params)).rejects.toThrow();
    });

    it("rejects an ID token with a tampered payload (ST-11)", async () => {
        const server = await startServer();
        const provider = makeProvider(server);
        const params = await prepare(provider, server);
        const signed = await server.signIdToken({ nonce: params.nonce });
        const [header, , signature] = signed.split(".");
        const claims = JSON.parse(
            Buffer.from(signed.split(".")[1], "base64").toString("utf8")
        ) as Record<string, unknown>;
        claims.sub = "attacker";
        server.setIdToken(`${header}.${base64url(claims)}.${signature}`);

        await expect(provider.exchangeCode(params)).rejects.toThrow();
    });

    it("rejects an ID token with the wrong audience (ST-12)", async () => {
        const server = await startServer();
        const provider = makeProvider(server);
        const params = await prepare(provider, server);
        server.idTokenClaims.aud = "another-client";

        await expect(provider.exchangeCode(params)).rejects.toThrow();
    });

    it("rejects an ID token with the wrong nonce (ST-12)", async () => {
        const server = await startServer();
        const provider = makeProvider(server);
        const params = await prepare(provider, server);
        server.idTokenClaims.nonce = "not-the-expected-nonce";

        await expect(provider.exchangeCode(params)).rejects.toThrow();
    });

    it("rejects an ID token with the wrong issuer (ST-12)", async () => {
        const server = await startServer();
        const provider = makeProvider(server);
        const params = await prepare(provider, server);
        server.idTokenClaims.iss = "https://other.example.com";

        await expect(provider.exchangeCode(params)).rejects.toThrow();
    });

    it("rejects an expired ID token (ST-12)", async () => {
        const server = await startServer();
        const provider = makeProvider(server);
        const params = await prepare(provider, server);
        server.idTokenClaims.exp = Math.floor(Date.now() / 1000) - 3600;

        await expect(provider.exchangeCode(params)).rejects.toThrow();
    });

    it("skips signature verification when explicitly disabled (ST-13)", async () => {
        const server = await startServer();
        const provider = makeProvider(server, false);
        const params = await prepare(provider, server);
        const { privateKey: rogueKey } = await generateKeyPair("RS256");
        server.setIdTokenSigningKey(rogueKey);

        const tokens = await provider.exchangeCode(params);

        expect(tokens.accessToken).toBe(server.accessToken);
    });

    it("still rejects wrong claims when signature verification is disabled (ST-13)", async () => {
        const server = await startServer();
        const provider = makeProvider(server, false);
        const params = await prepare(provider, server);
        // A validly signed token for the wrong audience must still be rejected:
        // disabling signature verification does not disable claim validation.
        server.idTokenClaims.aud = "another-client";

        await expect(provider.exchangeCode(params)).rejects.toThrow();
    });
});
