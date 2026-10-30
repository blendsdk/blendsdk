import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { JsonFileSource } from "../src/json-file-source.js";

/** Resolve fixture path relative to this test file */
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturesDir = resolve(__dirname, "fixtures");

describe("JsonFileSource", () => {
    describe("multi-locale file", () => {
        it("should load a multi-locale JSON file", async () => {
            const source = new JsonFileSource({
                paths: [resolve(fixturesDir, "multi-locale.json")],
            });
            const catalog = await source.load();

            expect(catalog.greeting).toEqual({
                en: "Hello ${name}",
                nl: "Hallo ${name}",
            });
            expect(catalog.farewell).toEqual({
                en: "Goodbye",
                nl: "Tot ziens",
            });
        });

        it("should load plural values from multi-locale file", async () => {
            const source = new JsonFileSource({
                paths: [resolve(fixturesDir, "multi-locale.json")],
            });
            const catalog = await source.load();

            expect(catalog.book).toEqual({
                en: ["${count} book", "${count} books"],
                nl: ["${count} boek", "${count} boeken"],
            });
        });
    });

    describe("single-locale files", () => {
        it("should load single-locale files with locale from filename", async () => {
            const source = new JsonFileSource({
                paths: [
                    resolve(fixturesDir, "en.json"),
                    resolve(fixturesDir, "nl.json"),
                ],
            });
            const catalog = await source.load();

            expect(catalog.greeting).toEqual({ en: "Hello", nl: "Hallo" });
            expect(catalog.farewell).toEqual({ en: "Goodbye", nl: "Tot ziens" });
            expect(catalog.welcome).toEqual({
                en: "Welcome to our app",
                nl: "Welkom bij onze app",
            });
        });
    });

    describe("glob pattern resolution", () => {
        it("should resolve *.json glob pattern", async () => {
            const source = new JsonFileSource({
                paths: [resolve(fixturesDir, "*.json")],
            });
            const catalog = await source.load();

            // Should have loaded multiple files
            expect(Object.keys(catalog).length).toBeGreaterThan(0);
            // The en.json and nl.json are single-locale, so they should have locale entries
            expect(catalog.greeting).toBeDefined();
        });

        it("should return empty catalog for non-existent directory", async () => {
            const source = new JsonFileSource({
                paths: [resolve(fixturesDir, "nonexistent/*.json")],
            });
            const catalog = await source.load();
            expect(catalog).toEqual({});
        });
    });

    describe("multiple files merged", () => {
        it("should merge multiple files with later overriding earlier", async () => {
            const source = new JsonFileSource({
                paths: [
                    resolve(fixturesDir, "multi-locale.json"),
                    resolve(fixturesDir, "override.json"),
                ],
            });
            const catalog = await source.load();

            // Override should have replaced the greeting
            expect(catalog.greeting.en).toBe("Hi ${name}");
            expect(catalog.greeting.nl).toBe("Hoi ${name}");
            // Farewell should still be from the original
            expect(catalog.farewell.en).toBe("Goodbye");
        });
    });

    describe("source name", () => {
        it("should have name JsonFileSource", () => {
            const source = new JsonFileSource({ paths: [] });
            expect(source.name).toBe("JsonFileSource");
        });
    });

    describe("error handling", () => {
        it("should throw on non-existent file (plain path)", async () => {
            const source = new JsonFileSource({
                paths: [resolve(fixturesDir, "does-not-exist.json")],
            });
            await expect(source.load()).rejects.toThrow();
        });
    });
});
