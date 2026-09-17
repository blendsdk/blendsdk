import { describe, expect, it } from "vitest";
import { resolveLocale, parseAcceptLanguage } from "../src/locale-resolver.js";
import type { Request } from "express";

/**
 * Create a minimal mock Express Request for testing locale resolution.
 */
function mockRequest(overrides: {
    query?: Record<string, string>;
    headers?: Record<string, string>;
    cookies?: Record<string, string>;
} = {}): Request {
    return {
        query: overrides.query ?? {},
        headers: overrides.headers ?? {},
        cookies: overrides.cookies ?? {},
    } as unknown as Request;
}

describe("resolveLocale", () => {
    describe("query parameter", () => {
        it("should resolve from ?locale=nl", () => {
            const req = mockRequest({ query: { locale: "nl" } });
            expect(resolveLocale(req, "en", "locale")).toBe("nl");
        });

        it("should trim whitespace from query locale", () => {
            const req = mockRequest({ query: { locale: "  nl  " } });
            expect(resolveLocale(req, "en", "locale")).toBe("nl");
        });

        it("should skip empty query locale", () => {
            const req = mockRequest({ query: { locale: "  " } });
            expect(resolveLocale(req, "en", "locale")).toBe("en");
        });
    });

    describe("Accept-Language header", () => {
        it("should resolve from Accept-Language header", () => {
            const req = mockRequest({ headers: { "accept-language": "nl" } });
            expect(resolveLocale(req, "en", "locale")).toBe("nl");
        });

        it("should pick highest quality locale", () => {
            const req = mockRequest({ headers: { "accept-language": "en;q=0.8, nl;q=0.9" } });
            expect(resolveLocale(req, "en", "locale")).toBe("nl");
        });

        it("should normalize en-US to en_US", () => {
            const req = mockRequest({ headers: { "accept-language": "en-US" } });
            expect(resolveLocale(req, "en", "locale")).toBe("en_US");
        });
    });

    describe("cookie", () => {
        it("should resolve from cookie", () => {
            const req = mockRequest({ cookies: { locale: "de" } });
            expect(resolveLocale(req, "en", "locale")).toBe("de");
        });

        it("should skip cookie when cookieName is false", () => {
            const req = mockRequest({ cookies: { locale: "de" } });
            expect(resolveLocale(req, "en", false)).toBe("en");
        });
    });

    describe("priority order", () => {
        it("should prefer query over Accept-Language", () => {
            const req = mockRequest({
                query: { locale: "nl" },
                headers: { "accept-language": "de" },
            });
            expect(resolveLocale(req, "en", "locale")).toBe("nl");
        });

        it("should prefer Accept-Language over cookie", () => {
            const req = mockRequest({
                headers: { "accept-language": "de" },
                cookies: { locale: "fr" },
            });
            expect(resolveLocale(req, "en", "locale")).toBe("de");
        });

        it("should prefer cookie over default", () => {
            const req = mockRequest({ cookies: { locale: "fr" } });
            expect(resolveLocale(req, "en", "locale")).toBe("fr");
        });

        it("should fall back to default when nothing else set", () => {
            const req = mockRequest();
            expect(resolveLocale(req, "en", "locale")).toBe("en");
        });
    });
});

describe("parseAcceptLanguage", () => {
    it("should parse simple locale", () => {
        expect(parseAcceptLanguage("nl")).toBe("nl");
    });

    it("should parse with quality values", () => {
        expect(parseAcceptLanguage("nl, en;q=0.8")).toBe("nl");
    });

    it("should respect quality ordering", () => {
        expect(parseAcceptLanguage("en;q=0.8, nl;q=0.9, de;q=0.7")).toBe("nl");
    });

    it("should normalize en-US to en_US", () => {
        expect(parseAcceptLanguage("en-US,en;q=0.9")).toBe("en_US");
    });

    it("should return null for wildcard only", () => {
        expect(parseAcceptLanguage("*")).toBeNull();
    });

    it("should skip entries with q=0", () => {
        expect(parseAcceptLanguage("nl;q=0, en")).toBe("en");
    });

    it("should return null for empty header", () => {
        expect(parseAcceptLanguage("")).toBeNull();
    });
});
