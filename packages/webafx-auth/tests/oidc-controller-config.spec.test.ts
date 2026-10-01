/**
 * Specification tests for per-request config threading and OpenAPI metadata.
 *
 * A controller backed by a provider `configFactory` resolves a per-request
 * config and passes it to login, callback, and refresh. All five routes carry
 * OpenAPI metadata under the `oidc` tag with unique operation ids.
 *
 * @packageDocumentation
 */

import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

import { OidcAuthController } from "../src/oidc-auth-controller.js";

/** Concrete controller for route inspection and handler drives. */
class ConfigController extends OidcAuthController {
    constructor(private readonly provider: any) {
        super({ isProduction: () => false } as never, {} as never);
    }

    /** Return the stub provider directly. */
    protected async getProvider(_req: Request): Promise<any> {
        return this.provider;
    }
}

/** Build a request with a resolved config service. */
function makeReq(): Request {
    return { headers: {}, query: {}, services: {} } as unknown as Request;
}

/** Build a mock response recording status, body, cookies, and redirects. */
function makeRes(): any {
    return {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
        cookie: vi.fn(),
        clearCookie: vi.fn(),
        redirect: vi.fn(),
    };
}

/** Per-request config returned by the stub factory. */
const RESOLVED_CONFIG = {
    issuerUrl: "https://tenant-a.example.com",
    clientId: "tenant-a-client",
    // Distinct from the provider default so the callback assertion is meaningful.
    redirectUri: "https://tenant-a.example.com/oidc/callback",
};

/** Build a provider whose configFactory resolves the supplied config. */
function makeProvider(config: Record<string, unknown> = RESOLVED_CONFIG): any {
    return {
        getCsrfConfig: () => undefined,
        resolveRequestConfig: vi.fn(async () => config),
        buildAuthorizationUrl: vi.fn(async () => ({
            url: "https://tenant-a.example.com/authorize",
            codeVerifier: "verifier",
            state: "state",
            nonce: "nonce",
        })),
        getStateCookieName: () => "__oidc_state",
        getSessionCookieName: () => "__oidc_session",
        storeState: vi.fn(async () => {}),
        getState: vi.fn(async () => ({
            codeVerifier: "verifier",
            state: "state",
            nonce: "nonce",
        })),
        exchangeCode: vi.fn(async () => ({
            accessToken: "access",
            idToken: "id",
        })),
        fetchUserInfo: vi.fn(async () => ({ sub: "user-1" })),
        getRedirectUri: () => "https://app.example.com/callback",
        getSessionCookieTtl: () => 3600,
        storeSession: vi.fn(async () => {}),
        clearState: vi.fn(async () => {}),
        refreshToken: vi.fn(async () => ({
            accessToken: "new-access",
            expiresIn: 3600,
        })),
        revokeToken: vi.fn(async () => {}),
        getSession: vi.fn(async () => ({
            accessToken: "access",
            refreshToken: "refresh",
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            user: { sub: "user-1" },
        })),
        clearSession: vi.fn(async () => {}),
        shouldRotateSessionIdOnRefresh: () => false,
        shouldVerifyUserInfoSubject: () => true,
    };
}

describe("Controller config & OpenAPI — Specification Tests", () => {
    it("resolves a different config per tenant on login (ST-32)", async () => {
        const tenantB = {
            issuerUrl: "https://tenant-b.example.com",
            clientId: "tenant-b-client",
            redirectUri: "https://app.example.com/callback",
        };
        const providerA = makeProvider(RESOLVED_CONFIG);
        const providerB = makeProvider(tenantB);
        const controllerA = new ConfigController(providerA);
        const controllerB = new ConfigController(providerB);

        await controllerA.handleLogin(makeReq(), makeRes());
        await controllerB.handleLogin(makeReq(), makeRes());

        expect(providerA.buildAuthorizationUrl).toHaveBeenCalledWith(
            RESOLVED_CONFIG,
            expect.anything()
        );
        expect(providerB.buildAuthorizationUrl).toHaveBeenCalledWith(
            tenantB,
            expect.anything()
        );
    });

    it("passes the resolved config to exchangeCode and fetchUserInfo on callback (ST-33)", async () => {
        const provider = makeProvider();
        const controller = new ConfigController(provider);
        const req = {
            headers: { cookie: "__oidc_state=state-1" },
            query: { code: "code", state: "state" },
            services: {},
        } as unknown as Request;

        await controller.handleCallback(req, makeRes());

        expect(provider.exchangeCode).toHaveBeenCalledWith(
            expect.objectContaining({
                codeVerifier: "verifier",
                callbackUrl: expect.stringContaining(RESOLVED_CONFIG.redirectUri),
            }),
            RESOLVED_CONFIG
        );
        expect(provider.fetchUserInfo).toHaveBeenCalledWith(
            "access",
            undefined,
            RESOLVED_CONFIG
        );
    });

    it("passes the resolved config to refreshToken on refresh (ST-34)", async () => {
        const provider = makeProvider();
        const controller = new ConfigController(provider);
        const req = {
            headers: { cookie: "__oidc_session=session-1" },
            query: {},
            services: {},
        } as unknown as Request;

        await controller.handleRefresh(req, makeRes());

        expect(provider.refreshToken).toHaveBeenCalledWith(
            "refresh",
            RESOLVED_CONFIG
        );
    });

    it("annotates all five routes with OpenAPI metadata under the oidc tag (ST-35)", () => {
        const controller = new ConfigController(makeProvider());

        const routes = controller.routes();

        expect(routes).toHaveLength(5);
        for (const route of routes) {
            expect(route.openapi).toBeDefined();
            expect(route.openapi?.tags).toContain("oidc");
        }
    });

    it("assigns unique, non-empty operation ids (ST-36)", () => {
        const controller = new ConfigController(makeProvider());

        const ids = controller
            .routes()
            .map((route) => route.openapi?.operationId)
            .filter((id): id is string => Boolean(id));

        expect(ids).toHaveLength(5);
        expect(new Set(ids).size).toBe(5);
    });
});
