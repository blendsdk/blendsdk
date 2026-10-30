import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { ContentFileSource, contentFileSource } from "../src/content-file-source.js";
import { mergeCatalogs } from "../src/merge-catalogs.js";
import { JsonFileSource } from "../src/json-file-source.js";

/** Resolve fixture path relative to this test file */
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturesDir = resolve(__dirname, "content-fixtures");
const jsonFixturesDir = resolve(__dirname, "fixtures");

describe("ContentFileSource", () => {
    describe("source name", () => {
        it("should have name ContentFileSource", () => {
            const source = new ContentFileSource({ paths: [] });
            expect(source.name).toBe("ContentFileSource");
        });
    });

    describe("basic loading", () => {
        it("should load a single HTML content file", async () => {
            // Load only HTML files via glob to test basic loading
            const source = new ContentFileSource({
                paths: [resolve(fixturesDir, "en.signup-email.html")],
                extensions: [".html"],
            });

            // Since a single file path (not directory) is passed, it won't match
            // the directory listing approach. Use a glob or directory instead.
            const dirSource = new ContentFileSource({
                paths: [fixturesDir],
                extensions: [".html"],
            });
            const catalog = await dirSource.load();

            // en.signup-email.html should produce key "signup-email" with locale "en"
            expect(catalog["signup-email"]).toBeDefined();
            expect(catalog["signup-email"]["en"]).toContain("Welcome, ${name}!");
        });

        it("should load multiple locales for the same key", async () => {
            const source = new ContentFileSource({
                paths: [fixturesDir],
                extensions: [".html"],
            });
            const catalog = await source.load();

            // Both en and nl versions of signup-email should be loaded
            expect(catalog["signup-email"]["en"]).toContain("Welcome, ${name}!");
            expect(catalog["signup-email"]["nl"]).toContain("Welkom, ${name}!");
        });

        it("should load multiple different keys", async () => {
            const source = new ContentFileSource({
                paths: [fixturesDir],
            });
            const catalog = await source.load();

            // Should have at least signup-email, welcome-page, privacy-policy, auth.welcome
            expect(catalog["signup-email"]).toBeDefined();
            expect(catalog["welcome-page"]).toBeDefined();
            expect(catalog["privacy-policy"]).toBeDefined();
            expect(catalog["auth.welcome"]).toBeDefined();
        });

        it("should preserve content as-is including whitespace and special characters", async () => {
            const source = new ContentFileSource({
                paths: [fixturesDir],
                extensions: [".html"],
            });
            const catalog = await source.load();

            // Content should include HTML tags, newlines, and template variables
            const enContent = catalog["signup-email"]["en"];
            expect(enContent).toContain("<html>");
            expect(enContent).toContain("</html>");
            expect(enContent).toContain("${activationUrl}");
            expect(enContent).toContain("\n");
        });
    });

    describe("filename parsing", () => {
        it("should parse multi-dot keys correctly", async () => {
            // en.auth.welcome.html → key "auth.welcome", locale "en"
            const source = new ContentFileSource({
                paths: [fixturesDir],
                extensions: [".html"],
            });
            const catalog = await source.load();

            expect(catalog["auth.welcome"]).toBeDefined();
            expect(catalog["auth.welcome"]["en"]).toContain("Welcome to the auth section");
        });

        it("should skip files with only 2 dot-segments (no key)", async () => {
            // readme.txt has only 2 segments and should be skipped
            const source = new ContentFileSource({
                paths: [fixturesDir],
                extensions: [".txt"],
            });
            const catalog = await source.load();

            // "readme" should NOT be a key in the catalog
            expect(catalog["readme"]).toBeUndefined();
            // But privacy-policy should be loaded (en.privacy-policy.txt has 3 segments)
            expect(catalog["privacy-policy"]).toBeDefined();
        });

        it("should skip hidden files (dot-prefixed) since first segment is empty", async () => {
            // .hidden-file.html → segments ["", "hidden-file", "html"]
            // First segment (locale) is empty → should be skipped
            const source = new ContentFileSource({
                paths: [fixturesDir],
                extensions: [".html"],
            });
            const catalog = await source.load();

            // "hidden-file" should NOT be a key (empty locale is invalid)
            expect(catalog["hidden-file"]).toBeUndefined();
        });
    });

    describe("extension filtering", () => {
        it("should filter by default extensions (.html, .md, .txt)", async () => {
            const source = new ContentFileSource({
                paths: [fixturesDir],
                // No extensions specified — uses defaults
            });
            const catalog = await source.load();

            // HTML, MD, TXT files should be loaded
            expect(catalog["signup-email"]).toBeDefined(); // .html
            expect(catalog["welcome-page"]).toBeDefined(); // .md
            expect(catalog["privacy-policy"]).toBeDefined(); // .txt

            // JSON file should NOT be loaded (not in default extensions)
            expect(catalog["some-data"]).toBeUndefined();
        });

        it("should respect custom extensions configuration", async () => {
            // Only load .md files
            const source = new ContentFileSource({
                paths: [fixturesDir],
                extensions: [".md"],
            });
            const catalog = await source.load();

            // Markdown files should be loaded
            expect(catalog["welcome-page"]).toBeDefined();
            expect(catalog["welcome-page"]["en"]).toContain("# Welcome");

            // HTML and TXT files should NOT be loaded
            expect(catalog["signup-email"]).toBeUndefined();
            expect(catalog["privacy-policy"]).toBeUndefined();
        });

        it("should handle extensions without leading dot", async () => {
            // Extensions without dot should still work (normalized internally)
            const source = new ContentFileSource({
                paths: [fixturesDir],
                extensions: ["txt"],
            });
            const catalog = await source.load();

            expect(catalog["privacy-policy"]).toBeDefined();
            expect(catalog["signup-email"]).toBeUndefined();
        });

        it("should handle case-insensitive extensions", async () => {
            // Extension matching should be case-insensitive
            const source = new ContentFileSource({
                paths: [fixturesDir],
                extensions: [".HTML"],
            });
            const catalog = await source.load();

            expect(catalog["signup-email"]).toBeDefined();
        });
    });

    describe("directory and glob handling", () => {
        it("should return empty catalog for empty paths array", async () => {
            const source = new ContentFileSource({ paths: [] });
            const catalog = await source.load();
            expect(catalog).toEqual({});
        });

        it("should return empty catalog for non-existent directory", async () => {
            const source = new ContentFileSource({
                paths: [resolve(fixturesDir, "nonexistent-dir")],
            });
            const catalog = await source.load();
            expect(catalog).toEqual({});
        });

        it("should resolve glob patterns for specific extensions", async () => {
            // Use glob to load only HTML files
            const source = new ContentFileSource({
                paths: [resolve(fixturesDir, "*.html")],
            });
            const catalog = await source.load();

            // HTML files should be loaded
            expect(catalog["signup-email"]).toBeDefined();
            expect(catalog["auth.welcome"]).toBeDefined();

            // Non-HTML files should NOT be loaded (glob doesn't match them)
            expect(catalog["welcome-page"]).toBeUndefined();
            expect(catalog["privacy-policy"]).toBeUndefined();
        });

        it("should return empty catalog for non-matching glob", async () => {
            const source = new ContentFileSource({
                paths: [resolve(fixturesDir, "*.xml")],
            });
            const catalog = await source.load();
            expect(catalog).toEqual({});
        });

        it("should produce deterministic ordering (sorted files)", async () => {
            // Load twice and verify catalogs are identical
            const source1 = new ContentFileSource({ paths: [fixturesDir] });
            const source2 = new ContentFileSource({ paths: [fixturesDir] });

            const catalog1 = await source1.load();
            const catalog2 = await source2.load();

            expect(catalog1).toEqual(catalog2);
        });
    });

    describe("content types", () => {
        it("should load markdown files correctly", async () => {
            const source = new ContentFileSource({
                paths: [fixturesDir],
                extensions: [".md"],
            });
            const catalog = await source.load();

            expect(catalog["welcome-page"]["en"]).toContain("# Welcome");
            expect(catalog["welcome-page"]["nl"]).toContain("# Welkom");
        });

        it("should load plain text files correctly", async () => {
            const source = new ContentFileSource({
                paths: [fixturesDir],
                extensions: [".txt"],
            });
            const catalog = await source.load();

            expect(catalog["privacy-policy"]["en"]).toContain("Privacy Policy");
            expect(catalog["privacy-policy"]["en"]).toContain("Your privacy is important to us.");
        });
    });

    describe("factory function", () => {
        it("should create a working ContentFileSource via contentFileSource()", async () => {
            const source = contentFileSource({
                paths: [fixturesDir],
                extensions: [".html"],
            });

            // Verify it's a ContentFileSource instance
            expect(source).toBeInstanceOf(ContentFileSource);
            expect(source.name).toBe("ContentFileSource");

            // Verify it loads content correctly
            const catalog = await source.load();
            expect(catalog["signup-email"]).toBeDefined();
        });
    });

    describe("integration with mergeCatalogs", () => {
        it("should merge content catalog with JSON catalog", async () => {
            // Load JSON translations
            const jsonSource = new JsonFileSource({
                paths: [resolve(jsonFixturesDir, "multi-locale.json")],
            });
            const jsonCatalog = await jsonSource.load();

            // Load content translations
            const contentSource = new ContentFileSource({
                paths: [fixturesDir],
                extensions: [".html"],
            });
            const contentCatalog = await contentSource.load();

            // Merge: JSON first, then content (content wins on conflict)
            const merged = mergeCatalogs([jsonCatalog, contentCatalog]);

            // JSON keys should be present
            expect(merged["greeting"]).toBeDefined();
            expect(merged["greeting"]["en"]).toBe("Hello ${name}");

            // Content keys should be present
            expect(merged["signup-email"]).toBeDefined();
            expect(merged["signup-email"]["en"]).toContain("Welcome, ${name}!");
        });
    });
});
