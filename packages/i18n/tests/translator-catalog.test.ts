import { describe, expect, it } from "vitest";
import { Translator } from "../src/translator.js";
import type { TranslationCatalog } from "../src/types.js";

const testCatalog: TranslationCatalog = {
    greeting: { en: "Hello", nl: "Hallo", en_GB: "Hello, mate" },
    farewell: { en: "Goodbye", nl: "Tot ziens" },
    book: { en: ["${count} book", "${count} books"] },
};

describe("Translator catalog methods", () => {
    describe("getTranslationsForLocale", () => {
        it("should return all translations for a locale", () => {
            const t = new Translator({ catalog: testCatalog });
            const result = t.getTranslationsForLocale("en");
            expect(result).toEqual({
                greeting: "Hello",
                farewell: "Goodbye",
                book: ["${count} book", "${count} books"],
            });
        });

        it("should fall back to language for locale with region", () => {
            const t = new Translator({ catalog: testCatalog });
            const result = t.getTranslationsForLocale("en_GB");
            expect(result).toEqual({
                greeting: "Hello, mate", // Exact match for en_GB
                farewell: "Goodbye", // Falls back to en
                book: ["${count} book", "${count} books"], // Falls back to en
            });
        });

        it("should return empty object for unknown locale", () => {
            const t = new Translator({ catalog: testCatalog });
            const result = t.getTranslationsForLocale("de");
            expect(result).toEqual({});
        });
    });

    describe("hasKey", () => {
        it("should return true for existing key", () => {
            const t = new Translator({ catalog: testCatalog });
            expect(t.hasKey("greeting")).toBe(true);
        });

        it("should return false for missing key", () => {
            const t = new Translator({ catalog: testCatalog });
            expect(t.hasKey("nonexistent")).toBe(false);
        });

        it("should return true when key has value for specific locale", () => {
            const t = new Translator({ catalog: testCatalog });
            expect(t.hasKey("greeting", "nl")).toBe(true);
        });

        it("should return true when key falls back to language", () => {
            const t = new Translator({ catalog: testCatalog });
            // "farewell" has "en" but not "en_GB" — fallback should work
            expect(t.hasKey("farewell", "en_GB")).toBe(true);
        });

        it("should return false when key has no value for locale", () => {
            const t = new Translator({ catalog: testCatalog });
            expect(t.hasKey("farewell", "de")).toBe(false);
        });
    });

    describe("setCatalog", () => {
        it("should atomically replace the catalog", () => {
            const t = new Translator({ catalog: testCatalog });
            expect(t.translate("greeting", "en")).toBe("Hello");

            const newCatalog: TranslationCatalog = {
                greeting: { en: "Hi there" },
            };
            t.setCatalog(newCatalog);

            expect(t.translate("greeting", "en")).toBe("Hi there");
            expect(t.translate("farewell", "en")).toBe("farewell"); // No longer exists
        });
    });

    describe("getCatalog", () => {
        it("should return the current catalog", () => {
            const t = new Translator({ catalog: testCatalog });
            expect(t.getCatalog()).toBe(testCatalog);
        });
    });

    describe("getDefaultLocale", () => {
        it("should return the configured default locale", () => {
            const t = new Translator({ defaultLocale: "nl" });
            expect(t.getDefaultLocale()).toBe("nl");
        });

        it("should default to en", () => {
            const t = new Translator();
            expect(t.getDefaultLocale()).toBe("en");
        });
    });
});
