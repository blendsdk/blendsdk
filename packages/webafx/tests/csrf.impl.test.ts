/**
 * Implementation tests for the CSRF middleware.
 *
 * These cover edge cases beyond the specification cases: the length guard,
 * empty expected tokens, async token resolution, header case-insensitivity,
 * custom safe methods, and plugin mounting.
 *
 * @packageDocumentation
 */

import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

import { csrfMiddleware, csrfPlugin } from "../src/application/csrf.js";

/** Build a mock request for the middleware. */
function makeReq(options: {
    method?: string;
    path?: string;
    headers?: Record<string, string | undefined>;
    cookies?: Record<string, string>;
}): Request {
    return {
        method: options.method ?? "POST",
        path: options.path ?? "/resource",
        headers: options.headers ?? {},
        cookies: options.cookies ?? {},
    } as unknown as Request;
}

/** Build a mock response recording status and body. */
function makeRes(): {
    res: Response;
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
} {
    const json = vi.fn().mockReturnThis();
    const status = vi.fn().mockReturnThis();
    return { res: { status, json } as unknown as Response, status, json };
}

describe("CSRF middleware — implementation edge cases", () => {
    it("fails a length mismatch without throwing", async () => {
        const middleware = csrfMiddleware({ expectedToken: () => "short" });
        const { res, status } = makeRes();
        const next = vi.fn();

        await middleware(
            makeReq({ headers: { "x-csrf-token": "much-longer-value" } }),
            res,
            next
        );

        expect(next).not.toHaveBeenCalled();
        expect(status).toHaveBeenCalledWith(403);
    });

    it("fails when the expected token is empty", async () => {
        const middleware = csrfMiddleware({ expectedToken: () => "" });
        const { res, status } = makeRes();
        const next = vi.fn();

        await middleware(makeReq({ headers: { "x-csrf-token": "" } }), res, next);

        expect(next).not.toHaveBeenCalled();
        expect(status).toHaveBeenCalledWith(403);
    });

    it("awaits an async expected token", async () => {
        const middleware = csrfMiddleware({
            expectedToken: async () => "async-token",
        });
        const { res } = makeRes();
        const next = vi.fn();

        await middleware(
            makeReq({ headers: { "x-csrf-token": "async-token" } }),
            res,
            next
        );

        expect(next).toHaveBeenCalledTimes(1);
    });

    it("matches the header case-insensitively", async () => {
        const middleware = csrfMiddleware({
            header: "X-CSRF-Token",
            expectedToken: () => "token",
        });
        const { res } = makeRes();
        const next = vi.fn();

        await middleware(
            makeReq({ headers: { "x-csrf-token": "token" } }),
            res,
            next
        );

        expect(next).toHaveBeenCalledTimes(1);
    });

    it("honours a custom safe-method list", async () => {
        const middleware = csrfMiddleware({
            safeMethods: ["POST"],
            expectedToken: () => "token",
        });
        const { res } = makeRes();
        const next = vi.fn();

        await middleware(makeReq({ method: "POST" }), res, next);

        expect(next).toHaveBeenCalledTimes(1);
    });

    it("requires an exact method and path for an exemption", async () => {
        const middleware = csrfMiddleware({
            expectedToken: () => "token",
            exempt: ["POST /webhooks"],
        });
        const { res, status } = makeRes();
        const next = vi.fn();

        await middleware(makeReq({ method: "PUT", path: "/webhooks" }), res, next);

        expect(next).not.toHaveBeenCalled();
        expect(status).toHaveBeenCalledWith(403);
    });

    it("fails double-submit mode when the cookie is missing", async () => {
        const middleware = csrfMiddleware({ cookie: { name: "csrf" } });
        const { res, status } = makeRes();
        const next = vi.fn();

        await middleware(
            makeReq({ headers: { "x-csrf-token": "value" }, cookies: {} }),
            res,
            next
        );

        expect(next).not.toHaveBeenCalled();
        expect(status).toHaveBeenCalledWith(403);
    });

    it("mounts the middleware through the plugin factory", async () => {
        const use = vi.fn();
        const plugin = csrfPlugin({ expectedToken: () => "token" });

        await plugin.factory({
            app: {} as never,
            express: { use } as never,
            logger: { info: async () => {} } as never,
        });

        expect(use).toHaveBeenCalledTimes(1);
        expect(typeof use.mock.calls[0][0]).toBe("function");
    });
});
