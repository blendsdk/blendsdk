/**
 * Specification tests for the CSRF middleware.
 *
 * Mutating requests must present the expected token; safe methods and
 * configured exemptions pass through; the optional double-submit cookie mode
 * compares the header to the cookie.
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
    token?: string;
    cookie?: string;
    cookies?: Record<string, string>;
}): Request {
    const headers: Record<string, string | undefined> = {};
    if (options.token !== undefined) headers["x-csrf-token"] = options.token;
    return {
        method: options.method ?? "POST",
        path: options.path ?? "/resource",
        headers,
        cookies: options.cookies ?? {},
        query: {},
    } as unknown as Request;
}

/** Build a mock response that records status and body. */
function makeRes(): {
    res: Response;
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
} {
    const json = vi.fn().mockReturnThis();
    const status = vi.fn().mockReturnThis();
    return { res: { status, json } as unknown as Response, status, json };
}

describe("CSRF middleware — Specification Tests", () => {
    it("rejects a mutating request with no token and does not call next (ST-21)", async () => {
        const middleware = csrfMiddleware({ expectedToken: () => "expected" });
        const { res, status, json } = makeRes();
        const next = vi.fn();

        await middleware(makeReq({}), res, next);

        expect(next).not.toHaveBeenCalled();
        expect(status).toHaveBeenCalledWith(403);
        expect(json).toHaveBeenCalledWith(
            expect.objectContaining({
                success: false,
                error: expect.objectContaining({ code: "csrf_invalid" }),
            })
        );
    });

    it("rejects a mutating request with the wrong token (ST-22)", async () => {
        const middleware = csrfMiddleware({ expectedToken: () => "expected" });
        const { res, status } = makeRes();
        const next = vi.fn();

        await middleware(makeReq({ token: "wrong" }), res, next);

        expect(next).not.toHaveBeenCalled();
        expect(status).toHaveBeenCalledWith(403);
    });

    it("accepts a mutating request with the expected token (ST-23)", async () => {
        const middleware = csrfMiddleware({ expectedToken: () => "expected" });
        const { res } = makeRes();
        const next = vi.fn();

        await middleware(makeReq({ token: "expected" }), res, next);

        expect(next).toHaveBeenCalledTimes(1);
    });

    it("passes safe methods through (ST-24)", async () => {
        const middleware = csrfMiddleware({ expectedToken: () => "expected" });
        for (const method of ["GET", "HEAD", "OPTIONS"]) {
            const { res } = makeRes();
            const next = vi.fn();
            await middleware(makeReq({ method }), res, next);
            expect(next).toHaveBeenCalledTimes(1);
        }
    });

    it("passes exact exempt requests through (ST-25)", async () => {
        const middleware = csrfMiddleware({
            expectedToken: () => "expected",
            exempt: ["POST /webhooks"],
        });
        const { res } = makeRes();
        const next = vi.fn();

        await middleware(makeReq({ method: "POST", path: "/webhooks" }), res, next);

        expect(next).toHaveBeenCalledTimes(1);
    });

    it("compares header to cookie in double-submit mode (ST-26)", async () => {
        const middleware = csrfMiddleware({ cookie: { name: "csrf" } });

        const pass = makeRes();
        const nextPass = vi.fn();
        await middleware(
            makeReq({ token: "same", cookies: { csrf: "same" } }),
            pass.res,
            nextPass
        );
        expect(nextPass).toHaveBeenCalledTimes(1);

        const fail = makeRes();
        const nextFail = vi.fn();
        await middleware(
            makeReq({ token: "header", cookies: { csrf: "cookie" } }),
            fail.res,
            nextFail
        );
        expect(nextFail).not.toHaveBeenCalled();
        expect(fail.status).toHaveBeenCalledWith(403);
    });

    it("exposes a plugin definition that installs the middleware", () => {
        const plugin = csrfPlugin({ expectedToken: () => "expected" });
        expect(plugin.name).toBeTruthy();
        expect(typeof plugin.factory).toBe("function");
    });
});
