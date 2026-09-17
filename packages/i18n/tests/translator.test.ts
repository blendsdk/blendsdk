import { describe, expect, it, vi } from "vitest";
import { Translator } from "../src/translator.js";
import type { TranslationCatalog } from "../src/types.js";

/** Shared test catalog used across translator tests */
const testCatalog: TranslationCatalog = {
    greeting: { en: "Hello ${name}", nl: "Hallo ${name}", en_GB: "Hello ${name}, mate" },
    farewell: { en: "Goodbye", nl: "Tot ziens" },
    book: {
        en: ["${count} book", "${count} books"],
        nl: ["${count} boek", "${count} boeken"],
    },
    "auth.login": { en: "Log in", nl: "Inloggen" },
};

describe("Translator", () => {
    describe("simple translate", () => {
        it("should translate a simple key", () => {
            const t = new Translator({ catalog: testCatalog });
            expect(t.translate("farewell", "en")).toBe("Goodbye");
        });

        it("should translate with parameter interpolation", () => {
            const t = new Translator({ catalog: testCatalog });
            expect(t.translate("greeting", "en", { name: "Alice" })).toBe("Hello Alice");
        });

        it("should translate to a different locale", () => {
            const t = new Translator({ catalog: testCatalog });
            expect(t.translate("greeting", "nl", { name: "Alice" })).toBe("Hallo Alice");
        });

        it("should translate dot-notation keys", () => {
            const t = new Translator({ catalog: testCatalog });
            expect(t.translate("auth.login", "en")).toBe("Log in");
            expect(t.translate("auth.login", "nl")).toBe("Inloggen");
        });
    });

    describe("locale fallback", () => {
        it("should fall back from en_GB to en when en_GB not present", () => {
            const t = new Translator({ catalog: testCatalog });
            // "farewell" only has "en", not "en_GB"
            expect(t.translate("farewell", "en_GB")).toBe("Goodbye");
        });

        it("should use exact locale match when available", () => {
            const t = new Translator({ catalog: testCatalog });
            // "greeting" has both "en" and "en_GB"
            expect(t.translate("greeting", "en_GB", { name: "Bob" })).toBe("Hello Bob, mate");
        });

        it("should normalize dash to underscore (en-GB → en_GB)", () => {
            const t = new Translator({ catalog: testCatalog });
            expect(t.translate("greeting", "en-GB", { name: "Bob" })).toBe("Hello Bob, mate");
        });

        it("should strip encoding from locale (en_GB.UTF-8)", () => {
            const t = new Translator({ catalog: testCatalog });
            expect(t.translate("greeting", "en_GB.UTF-8", { name: "Bob" })).toBe("Hello Bob, mate");
        });
    });

    describe("default locale", () => {
        it("should use default locale when none specified", () => {
            const t = new Translator({ catalog: testCatalog, defaultLocale: "nl" });
            expect(t.translate("farewell")).toBe("Tot ziens");
        });

        it("should default to en when no defaultLocale configured", () => {
            const t = new Translator({ catalog: testCatalog });
            expect(t.translate("farewell")).toBe("Goodbye");
        });
    });

    describe("missing key", () => {
        it("should return key as-is when not found", () => {
            const t = new Translator({ catalog: testCatalog });
            expect(t.translate("nonexistent", "en")).toBe("nonexistent");
        });

        it("should invoke onMissingTranslation callback", () => {
            const callback = vi.fn();
            const t = new Translator({ catalog: testCatalog, onMissingTranslation: callback });
            t.translate("nonexistent", "en");
            expect(callback).toHaveBeenCalledWith("nonexistent", "en");
        });

        it("should invoke callback when locale not found for existing key", () => {
            const callback = vi.fn();
            // Catalog only has en and nl — requesting "de" should fall through
            const t = new Translator({ catalog: testCatalog, onMissingTranslation: callback });
            expect(t.translate("farewell", "de")).toBe("farewell");
            expect(callback).toHaveBeenCalledWith("farewell", "de");
        });

        it("should return key for empty catalog", () => {
            const t = new Translator();
            expect(t.translate("anything", "en")).toBe("anything");
        });
    });

    describe("plural support", () => {
        it("should select singular for count=1", () => {
            const t = new Translator({ catalog: testCatalog });
            expect(t.translate("book", "en", { count: 1 })).toBe("1 book");
        });

        it("should select plural for count>1", () => {
            const t = new Translator({ catalog: testCatalog });
            expect(t.translate("book", "en", { count: 5 })).toBe("5 books");
        });

        it("should select plural for count=0", () => {
            const t = new Translator({ catalog: testCatalog });
            expect(t.translate("book", "en", { count: 0 })).toBe("0 books");
        });

        it("should select plural in different locale", () => {
            const t = new Translator({ catalog: testCatalog });
            expect(t.translate("book", "nl", { count: 3 })).toBe("3 boeken");
        });

        it("should default to singular for non-numeric count", () => {
            const t = new Translator({ catalog: testCatalog });
            // Singular form selected, but formatString still interpolates "many" for ${count}
            expect(t.translate("book", "en", { count: "many" })).toBe("many book");
        });

        it("should default to singular for NaN count", () => {
            const t = new Translator({ catalog: testCatalog });
            // Singular form selected, NaN is still interpolated as "NaN" string
            expect(t.translate("book", "en", { count: NaN })).toBe("NaN book");
        });

        it("should use string value even with count param", () => {
            const t = new Translator({ catalog: testCatalog });
            // "farewell" is a simple string, not a plural tuple
            expect(t.translate("farewell", "en", { count: 5 })).toBe("Goodbye");
        });
    });
});
