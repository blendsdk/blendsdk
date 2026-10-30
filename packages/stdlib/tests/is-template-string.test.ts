import { describe, expect, it } from "vitest";
import { isTemplateString } from "../src/isTemplateString.js";

describe("isTemplateString", () => {
    describe("should return true for strings with placeholders", () => {
        it("should detect simple placeholder", () => {
            expect(isTemplateString("Hello ${name}")).toBe(true);
        });

        it("should detect placeholder with default value", () => {
            expect(isTemplateString("Hello ${name|World}")).toBe(true);
        });

        it("should detect dot-notation placeholder", () => {
            expect(isTemplateString("${user.name}")).toBe(true);
        });

        it("should detect dot-notation placeholder with default", () => {
            expect(isTemplateString("${user.name|Anonymous}")).toBe(true);
        });

        it("should detect deeply nested dot-notation", () => {
            expect(isTemplateString("${a.b.c.d}")).toBe(true);
        });

        it("should detect placeholder at start of string", () => {
            expect(isTemplateString("${name} is here")).toBe(true);
        });

        it("should detect placeholder at end of string", () => {
            expect(isTemplateString("Hello ${name}")).toBe(true);
        });

        it("should detect placeholder that is the entire string", () => {
            expect(isTemplateString("${name}")).toBe(true);
        });

        it("should detect placeholder with spaces inside braces", () => {
            expect(isTemplateString("Hello ${ name }")).toBe(true);
        });

        it("should detect multiple placeholders (at least one match)", () => {
            expect(isTemplateString("${a} and ${b}")).toBe(true);
        });

        it("should detect placeholder with empty default", () => {
            expect(isTemplateString("${name|}")).toBe(true);
        });

        it("should detect placeholder with numeric-like key", () => {
            expect(isTemplateString("${count}")).toBe(true);
        });

        it("should detect placeholder with underscore in key", () => {
            expect(isTemplateString("${user_name}")).toBe(true);
        });
    });

    describe("should return false for strings without placeholders", () => {
        it("should reject plain text", () => {
            expect(isTemplateString("Hello world")).toBe(false);
        });

        it("should reject empty string", () => {
            expect(isTemplateString("")).toBe(false);
        });

        it("should reject dollar sign without brace", () => {
            expect(isTemplateString("$100")).toBe(false);
        });

        it("should reject incomplete placeholder (no closing brace)", () => {
            expect(isTemplateString("Hello ${")).toBe(false);
        });

        it("should reject incomplete placeholder (no key)", () => {
            expect(isTemplateString("Hello ${}")).toBe(false);
        });

        it("should reject just a closing brace", () => {
            expect(isTemplateString("Hello }")).toBe(false);
        });

        it("should reject dollar-brace with only spaces", () => {
            expect(isTemplateString("${   }")).toBe(false);
        });

        it("should reject strings with only special characters", () => {
            expect(isTemplateString("!@#$%^&*()")).toBe(false);
        });

        it("should reject strings with curly braces but no dollar", () => {
            expect(isTemplateString("{name}")).toBe(false);
        });

        it("should reject strings with dollar but no braces", () => {
            expect(isTemplateString("$name")).toBe(false);
        });
    });

    describe("edge cases", () => {
        it("should handle string with dollar sign and braces separately", () => {
            expect(isTemplateString("$ {name}")).toBe(false);
        });

        it("should handle very long strings with a placeholder", () => {
            const longPrefix = "a".repeat(10000);
            expect(isTemplateString(`${longPrefix}\${name}`)).toBe(true);
        });

        it("should handle very long strings without a placeholder", () => {
            const longString = "a".repeat(10000);
            expect(isTemplateString(longString)).toBe(false);
        });
    });
});
