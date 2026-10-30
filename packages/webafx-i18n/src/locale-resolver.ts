import type { Request } from "express";

/**
 * Resolve the locale for an incoming HTTP request.
 *
 * Resolution priority (first match wins):
 * 1. Query parameter: `?locale=nl`
 * 2. Accept-Language header: `Accept-Language: nl, en;q=0.8`
 * 3. Cookie: `locale=nl` (cookie name configurable)
 * 4. Default locale from config
 *
 * @param req - Express Request object
 * @param defaultLocale - Fallback locale
 * @param cookieName - Cookie name to check (false to skip)
 * @returns The resolved locale string
 *
 * @example
 * resolveLocale(req, "en", "locale") // → "nl" (if ?locale=nl)
 */
export function resolveLocale(
    req: Request,
    defaultLocale: string,
    cookieName: string | false
): string {
    // 1. Query parameter
    const queryLocale = req.query?.locale;
    if (typeof queryLocale === "string" && queryLocale.trim()) {
        return queryLocale.trim();
    }

    // 2. Accept-Language header
    const acceptLanguage = req.headers["accept-language"];
    if (acceptLanguage) {
        const parsed = parseAcceptLanguage(acceptLanguage);
        if (parsed) {
            return parsed;
        }
    }

    // 3. Cookie
    if (cookieName && req.cookies?.[cookieName]) {
        return req.cookies[cookieName];
    }

    // 4. Default
    return defaultLocale;
}

/**
 * Parse the Accept-Language header and return the highest-priority locale.
 *
 * Handles formats like:
 * - "nl" → "nl"
 * - "nl, en;q=0.8" → "nl"
 * - "en-US,en;q=0.9,nl;q=0.8" → "en_US" (normalized)
 * - "*" → null (wildcard, use default)
 *
 * @param header - The Accept-Language header value
 * @returns The best locale, or null if none can be determined
 */
export function parseAcceptLanguage(header: string): string | null {
    const entries = header
        .split(",")
        .map((entry) => {
            const [locale, ...params] = entry.trim().split(";");
            const qParam = params.find((p) => p.trim().startsWith("q="));
            const quality = qParam ? parseFloat(qParam.trim().slice(2)) : 1.0;
            return { locale: locale.trim(), quality };
        })
        .filter((e) => e.locale !== "*" && e.locale !== "" && e.quality > 0)
        .sort((a, b) => b.quality - a.quality);

    if (entries.length === 0) return null;

    // Normalize: "en-US" → "en_US"
    return entries[0].locale.replace("-", "_");
}
