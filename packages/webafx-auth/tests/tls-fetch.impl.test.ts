/**
 * Implementation tests for the transport fetch shim.
 *
 * These cover shim internals and edge cases beyond the specification cases:
 * input validation, redirect semantics (including body-header handling and
 * cross-origin credential stripping), body handling, and response copying.
 *
 * @packageDocumentation
 */

import { afterEach, describe, expect, it } from "vitest";
import {
    createServer,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from "node:http";

import { createTlsFetch } from "../src/tls-fetch.js";

/** Running servers, closed after each test. */
const servers: Server[] = [];

afterEach(async () => {
    await Promise.all(
        servers.splice(0).map(
            server =>
                new Promise<void>(resolve => server.close(() => resolve()))
        )
    );
});

/** Start a loopback HTTP server and return its base URL. */
async function startServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<string> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    return `http://127.0.0.1:${address.port}`;
}

describe("createTlsFetch — implementation edge cases", () => {
    it("returns undefined for an empty CA list or empty CA string", () => {
        expect(createTlsFetch({ ca: [] })).toBeUndefined();
        expect(createTlsFetch({ ca: "" })).toBeUndefined();
    });

    it("returns undefined when insecure mode is explicitly false", () => {
        expect(createTlsFetch({ allowInsecureRequests: false })).toBeUndefined();
    });

    it("follows a 302 redirect as a bodyless GET and drops body headers", async () => {
        const seen: {
            method?: string;
            body?: string;
            contentLength?: string;
            contentType?: string;
        } = {};
        const base = await startServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", chunk => chunks.push(chunk));
            req.on("end", () => {
                if (req.url === "/start") {
                    res.statusCode = 302;
                    res.setHeader("location", "/end");
                    res.end();
                    return;
                }
                seen.method = req.method;
                seen.body = Buffer.concat(chunks).toString();
                seen.contentLength = req.headers["content-length"] as
                    | string
                    | undefined;
                seen.contentType = req.headers["content-type"] as
                    | string
                    | undefined;
                res.statusCode = 200;
                res.end("ok");
            });
        });

        const tlsFetch = createTlsFetch({ allowInsecureRequests: true });
        const response = await tlsFetch!(`${base}/start`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ a: "1" }),
        });

        expect(response.status).toBe(200);
        expect(seen.method).toBe("GET");
        expect(seen.body).toBe("");
        expect(seen.contentLength).toBeUndefined();
        expect(seen.contentType).toBeUndefined();
    });

    it.each([307, 308])(
        "preserves method and body across a %i redirect",
        async statusCode => {
            const seen: { method?: string; body?: string } = {};
            const base = await startServer((req, res) => {
                const chunks: Buffer[] = [];
                req.on("data", chunk => chunks.push(chunk));
                req.on("end", () => {
                    if (req.url === "/start") {
                        res.statusCode = statusCode;
                        res.setHeader("location", "/end");
                        res.end();
                        return;
                    }
                    seen.method = req.method;
                    seen.body = Buffer.concat(chunks).toString();
                    res.statusCode = 200;
                    res.end("ok");
                });
            });

            const tlsFetch = createTlsFetch({ allowInsecureRequests: true });
            await tlsFetch!(`${base}/start`, {
                method: "POST",
                body: "payload",
            });

            expect(seen.method).toBe("POST");
            expect(seen.body).toBe("payload");
        }
    );

    it("strips credential headers on a cross-origin redirect", async () => {
        const received: { authorization?: string; cookie?: string } = {};
        const target = await startServer((req, res) => {
            received.authorization = req.headers["authorization"] as
                | string
                | undefined;
            received.cookie = req.headers["cookie"] as string | undefined;
            res.statusCode = 200;
            res.end("ok");
        });
        const source = await startServer((_req, res) => {
            res.statusCode = 307;
            res.setHeader("location", `${target}/end`);
            res.end();
        });

        const tlsFetch = createTlsFetch({ allowInsecureRequests: true });
        await tlsFetch!(`${source}/start`, {
            method: "GET",
            headers: { authorization: "Bearer secret", cookie: "sid=1" },
        });

        expect(received.authorization).toBeUndefined();
        expect(received.cookie).toBeUndefined();
    });

    it("forwards credential headers on a same-origin redirect", async () => {
        const received: { authorization?: string } = {};
        const base = await startServer((req, res) => {
            if (req.url === "/start") {
                res.statusCode = 307;
                res.setHeader("location", "/end");
                res.end();
                return;
            }
            received.authorization = req.headers["authorization"] as
                | string
                | undefined;
            res.statusCode = 200;
            res.end("ok");
        });

        const tlsFetch = createTlsFetch({ allowInsecureRequests: true });
        await tlsFetch!(`${base}/start`, {
            method: "GET",
            headers: { authorization: "Bearer secret" },
        });

        expect(received.authorization).toBe("Bearer secret");
    });

    it("fails after more than five redirects", async () => {
        const base = await startServer((_req, res) => {
            res.statusCode = 302;
            res.setHeader("location", "/loop");
            res.end();
        });

        const tlsFetch = createTlsFetch({ allowInsecureRequests: true });

        await expect(tlsFetch!(`${base}/loop`)).rejects.toThrow(/redirects/);
    });

    it("forwards a Headers instance and returns a null-body 204", async () => {
        let header: string | undefined;
        const base = await startServer((req, res) => {
            header = req.headers["x-test"] as string;
            res.statusCode = 204;
            res.end();
        });

        const tlsFetch = createTlsFetch({ allowInsecureRequests: true });
        const response = await tlsFetch!(`${base}/`, {
            headers: new Headers({ "x-test": "value" }),
        });

        expect(header).toBe("value");
        expect(response.status).toBe(204);
        expect(await response.text()).toBe("");
    });

    it("rejects an unsupported request body type", async () => {
        const base = await startServer((_req, res) => {
            res.statusCode = 200;
            res.end("ok");
        });

        const tlsFetch = createTlsFetch({ allowInsecureRequests: true });

        await expect(
            tlsFetch!(`${base}/`, { method: "POST", body: new ReadableStream() })
        ).rejects.toThrow(/unsupported request body/);
    });
});
