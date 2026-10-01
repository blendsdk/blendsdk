/**
 * Specification tests for OIDC transport security.
 *
 * Verifies that the provider can be pointed at a loopback HTTP issuer
 * (explicit insecure opt-in) and at a self-signed HTTPS issuer whose CA is
 * supplied, while the default transport stays HTTPS-only with system trust.
 *
 * @packageDocumentation
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { createServer } from "node:http";

import { OidcAuthProvider } from "../src/oidc-auth-provider.js";
import { createTlsFetch } from "../src/tls-fetch.js";
import { readTestCa, startOidcTestServer, type OidcTestServer } from "./oidc-test-server.js";

/** Running test providers, closed after each test. */
const servers: OidcTestServer[] = [];
/** Extra plain HTTP servers started inside a test, closed after it. */
const rawServers: Server[] = [];

afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(
        rawServers.splice(0).map(
            (server) =>
                new Promise<void>((resolve) => server.close(() => resolve()))
        )
    );
});

/** Start a provider and register it for cleanup. */
async function startServer(tls: boolean): Promise<OidcTestServer> {
    const server = await startOidcTestServer({ tls });
    servers.push(server);
    return server;
}

/** Build a provider bound to a test server. */
function makeProvider(
    server: OidcTestServer,
    transport?: { ca?: string | string[]; allowInsecureRequests?: boolean }
): OidcAuthProvider {
    return new OidcAuthProvider({
        issuerUrl: server.issuer,
        clientId: "test-client",
        clientSecret: "test-secret",
        redirectUri: "https://app.example.com/callback",
        transport,
    });
}

/** Run a full discovery + JWKS + code exchange for a provider. */
async function runCodeExchange(provider: OidcAuthProvider, server: OidcTestServer) {
    const auth = await provider.buildAuthorizationUrl();
    server.idTokenClaims.nonce = auth.nonce;
    return provider.exchangeCode({
        codeVerifier: auth.codeVerifier,
        nonce: auth.nonce,
        callbackUrl: `https://app.example.com/callback?code=test-code&state=${auth.state}`,
    });
}

describe("OIDC transport security — Specification Tests", () => {
    it("returns undefined when no transport relaxation is configured (ST-1)", () => {
        expect(createTlsFetch(undefined)).toBeUndefined();
        expect(createTlsFetch({})).toBeUndefined();
    });

    it("returns a fetch function when a CA is supplied (ST-2)", () => {
        expect(typeof createTlsFetch({ ca: "-----BEGIN CERTIFICATE-----" })).toBe(
            "function"
        );
    });

    it("performs discovery, JWKS, and code exchange over loopback http when insecure (ST-3)", async () => {
        const server = await startServer(false);
        const provider = makeProvider(server, { allowInsecureRequests: true });

        const tokens = await runCodeExchange(provider, server);

        expect(tokens.accessToken).toBe(server.accessToken);
    });

    it("rejects an http issuer when no transport relaxation is configured (ST-4)", async () => {
        const server = await startServer(false);
        const provider = makeProvider(server);

        await expect(provider.buildAuthorizationUrl()).rejects.toThrow();
    });

    it("performs discovery, JWKS, and code exchange over self-signed https when the CA is trusted (ST-5)", async () => {
        const server = await startServer(true);
        const provider = makeProvider(server, { ca: readTestCa() });

        const tokens = await runCodeExchange(provider, server);

        expect(tokens.accessToken).toBe(server.accessToken);
    });

    it("rejects a self-signed https issuer when its CA is not trusted (ST-6)", async () => {
        const server = await startServer(true);
        const provider = makeProvider(server);

        await expect(provider.buildAuthorizationUrl()).rejects.toThrow();
    });

    it("warns once per provider even across repeated discoveries (ST-7)", async () => {
        const server = await startServer(false);
        const provider = makeProvider(server, { allowInsecureRequests: true });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        try {
            await provider.buildAuthorizationUrl();
            // Force a second discovery so the warning cannot be a per-discovery
            // effect. shutdown() clears the discovery cache through public API.
            await provider.shutdown();
            await provider.buildAuthorizationUrl();

            expect(warn).toHaveBeenCalledTimes(1);

            // A second provider warns independently.
            const second = makeProvider(server, { allowInsecureRequests: true });
            await second.buildAuthorizationUrl();
            expect(warn).toHaveBeenCalledTimes(2);
        } finally {
            warn.mockRestore();
        }
    });

    it("forwards method, headers, and body, and does not follow a manual redirect (ST-8)", async () => {
        const seen: { method?: string; header?: string; body?: string } = {};
        const server = createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (chunk: Buffer) => chunks.push(chunk));
            req.on("end", () => {
                seen.method = req.method;
                seen.header = req.headers["x-test"] as string;
                seen.body = Buffer.concat(chunks).toString();
                if (req.url === "/redirect") {
                    res.statusCode = 302;
                    res.setHeader("location", "/target");
                    res.end();
                    return;
                }
                res.statusCode = 200;
                res.setHeader("content-type", "application/json");
                res.end("{}");
            });
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        rawServers.push(server);
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("no port");
        const base = `http://127.0.0.1:${address.port}`;

        const tlsFetch = createTlsFetch({ allowInsecureRequests: true });
        expect(tlsFetch).toBeDefined();

        await tlsFetch!(base, {
            method: "POST",
            headers: { "x-test": "value" },
            body: new URLSearchParams({ a: "1" }),
        });
        expect(seen.method).toBe("POST");
        expect(seen.header).toBe("value");
        expect(seen.body).toBe("a=1");

        const redirect = await tlsFetch!(`${base}/redirect`, {
            method: "GET",
            redirect: "manual",
        });
        expect(redirect.status).toBe(302);
        expect(redirect.headers.get("location")).toBe("/target");
    });
});
