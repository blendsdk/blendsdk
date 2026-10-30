import { describe, expect, it } from "vitest";
import { mergeCatalogs } from "../src/merge-catalogs.js";
import type { TranslationCatalog } from "../src/types.js";

describe("mergeCatalogs", () => {
    it("should merge two catalogs with different keys", () => {
        const a: TranslationCatalog = { greeting: { en: "Hello" } };
        const b: TranslationCatalog = { farewell: { en: "Goodbye" } };
        const result = mergeCatalogs([a, b]);
        expect(result).toEqual({
            greeting: { en: "Hello" },
            farewell: { en: "Goodbye" },
        });
    });

    it("should override same key+locale with later catalog", () => {
        const a: TranslationCatalog = { greeting: { en: "Hello", nl: "Hallo" } };
        const b: TranslationCatalog = { greeting: { en: "Hi" } };
        const result = mergeCatalogs([a, b]);
        expect(result).toEqual({
            greeting: { en: "Hi", nl: "Hallo" }, // "en" overridden, "nl" preserved
        });
    });

    it("should merge different locales for same key", () => {
        const a: TranslationCatalog = { greeting: { en: "Hello" } };
        const b: TranslationCatalog = { greeting: { nl: "Hallo" } };
        const result = mergeCatalogs([a, b]);
        expect(result).toEqual({
            greeting: { en: "Hello", nl: "Hallo" },
        });
    });

    it("should return empty catalog for empty array", () => {
        expect(mergeCatalogs([])).toEqual({});
    });

    it("should return copy of single catalog", () => {
        const a: TranslationCatalog = { greeting: { en: "Hello" } };
        const result = mergeCatalogs([a]);
        expect(result).toEqual({ greeting: { en: "Hello" } });
        // Should be a copy, not the same reference
        expect(result).not.toBe(a);
        expect(result.greeting).not.toBe(a.greeting);
    });

    it("should handle three catalogs with progressive override", () => {
        const base: TranslationCatalog = { greeting: { en: "Hello", nl: "Hallo" } };
        const middle: TranslationCatalog = { greeting: { en: "Hi" }, farewell: { en: "Bye" } };
        const top: TranslationCatalog = { greeting: { en: "Hey" } };
        const result = mergeCatalogs([base, middle, top]);
        expect(result).toEqual({
            greeting: { en: "Hey", nl: "Hallo" },
            farewell: { en: "Bye" },
        });
    });

    it("should handle plural values in merge", () => {
        const a: TranslationCatalog = { book: { en: ["${count} book", "${count} books"] } };
        const b: TranslationCatalog = { book: { nl: ["${count} boek", "${count} boeken"] } };
        const result = mergeCatalogs([a, b]);
        expect(result).toEqual({
            book: {
                en: ["${count} book", "${count} books"],
                nl: ["${count} boek", "${count} boeken"],
            },
        });
    });
});
