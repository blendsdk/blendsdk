import { describe, expect, it, vi } from "vitest";
import { PostgreSQLSource, postgresqlSource } from "../src/postgresql-source.js";

describe("PostgreSQLSource", () => {
    describe("load", () => {
        it("should load simple translations from mock queryFn", async () => {
            const mockQueryFn = vi.fn().mockResolvedValue([
                { key: "greeting", locale: "en", value: "Hello" },
                { key: "greeting", locale: "nl", value: "Hallo" },
                { key: "farewell", locale: "en", value: "Goodbye" },
            ]);

            const source = new PostgreSQLSource({ queryFn: mockQueryFn });
            const catalog = await source.load();

            expect(catalog).toEqual({
                greeting: { en: "Hello", nl: "Hallo" },
                farewell: { en: "Goodbye" },
            });
        });

        it("should parse plural JSON arrays from value column", async () => {
            const mockQueryFn = vi.fn().mockResolvedValue([
                { key: "book", locale: "en", value: '["${count} book","${count} books"]' },
                { key: "book", locale: "nl", value: '["${count} boek","${count} boeken"]' },
            ]);

            const source = new PostgreSQLSource({ queryFn: mockQueryFn });
            const catalog = await source.load();

            expect(catalog.book).toEqual({
                en: ["${count} book", "${count} books"],
                nl: ["${count} boek", "${count} boeken"],
            });
        });

        it("should treat invalid JSON array as plain string", async () => {
            const mockQueryFn = vi.fn().mockResolvedValue([
                { key: "note", locale: "en", value: "[not valid json" },
            ]);

            const source = new PostgreSQLSource({ queryFn: mockQueryFn });
            const catalog = await source.load();

            expect(catalog.note.en).toBe("[not valid json");
        });

        it("should treat JSON array with != 2 elements as plain string", async () => {
            const mockQueryFn = vi.fn().mockResolvedValue([
                { key: "note", locale: "en", value: '["only one"]' },
            ]);

            const source = new PostgreSQLSource({ queryFn: mockQueryFn });
            const catalog = await source.load();

            expect(catalog.note.en).toBe('["only one"]');
        });

        it("should use default table name", async () => {
            const mockQueryFn = vi.fn().mockResolvedValue([]);
            const source = new PostgreSQLSource({ queryFn: mockQueryFn });
            await source.load();

            expect(mockQueryFn).toHaveBeenCalledWith(
                "SELECT key, locale, value FROM translations ORDER BY key, locale"
            );
        });

        it("should use custom table name", async () => {
            const mockQueryFn = vi.fn().mockResolvedValue([]);
            const source = new PostgreSQLSource({
                queryFn: mockQueryFn,
                tableName: "i18n_strings",
            });
            await source.load();

            expect(mockQueryFn).toHaveBeenCalledWith(
                "SELECT key, locale, value FROM i18n_strings ORDER BY key, locale"
            );
        });

        it("should apply filter clause", async () => {
            const mockQueryFn = vi.fn().mockResolvedValue([]);
            const source = new PostgreSQLSource({
                queryFn: mockQueryFn,
                filter: "active = true AND app = 'myapp'",
            });
            await source.load();

            expect(mockQueryFn).toHaveBeenCalledWith(
                "SELECT key, locale, value FROM translations WHERE active = true AND app = 'myapp' ORDER BY key, locale"
            );
        });

        it("should return empty catalog for empty result", async () => {
            const mockQueryFn = vi.fn().mockResolvedValue([]);
            const source = new PostgreSQLSource({ queryFn: mockQueryFn });
            const catalog = await source.load();

            expect(catalog).toEqual({});
        });

        it("should throw when queryFn fails", async () => {
            const mockQueryFn = vi.fn().mockRejectedValue(new Error("Connection refused"));
            const source = new PostgreSQLSource({ queryFn: mockQueryFn });

            await expect(source.load()).rejects.toThrow("Connection refused");
        });
    });

    describe("source metadata", () => {
        it("should have name PostgreSQLSource", () => {
            const source = new PostgreSQLSource({ queryFn: async () => [] });
            expect(source.name).toBe("PostgreSQLSource");
        });
    });

    describe("factory function", () => {
        it("should create a PostgreSQLSource via factory", () => {
            const source = postgresqlSource({ queryFn: async () => [] });
            expect(source).toBeInstanceOf(PostgreSQLSource);
            expect(source.name).toBe("PostgreSQLSource");
        });
    });
});
