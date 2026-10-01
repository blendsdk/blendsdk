import { describe, expect, it } from "vitest";
import { formatString } from "../src/formatString.js";

describe("formatString", () => {
    describe("simple substitution", () => {
        it("should replace a single placeholder", () => {
            expect(formatString("Hello ${name}", { name: "John" })).toBe("Hello John");
        });

        it("should replace multiple placeholders", () => {
            expect(formatString("${a} and ${b}", { a: "X", b: "Y" })).toBe("X and Y");
        });

        it("should replace a placeholder at the start of the string", () => {
            expect(formatString("${name} is here", { name: "Alice" })).toBe("Alice is here");
        });

        it("should replace a placeholder at the end of the string", () => {
            expect(formatString("Hello ${name}", { name: "Bob" })).toBe("Hello Bob");
        });

        it("should replace a placeholder that is the entire string", () => {
            expect(formatString("${name}", { name: "Charlie" })).toBe("Charlie");
        });

        it("should handle adjacent placeholders", () => {
            expect(formatString("${a}${b}", { a: "Hello", b: "World" })).toBe("HelloWorld");
        });

        it("should replace the same key used multiple times", () => {
            expect(formatString("${x} + ${x} = 2${x}", { x: "A" })).toBe("A + A = 2A");
        });
    });

    describe("default values", () => {
        it("should use default when key is missing from params", () => {
            expect(formatString("Hello ${name|Guest}")).toBe("Hello Guest");
        });

        it("should use default when key is undefined", () => {
            expect(formatString("Hello ${name|Guest}", { name: undefined })).toBe("Hello Guest");
        });

        it("should use default when key is null", () => {
            expect(formatString("Hello ${name|Guest}", { name: null })).toBe("Hello Guest");
        });

        it("should use default when value is empty string", () => {
            expect(formatString("Hello ${name|Guest}", { name: "" })).toBe("Hello Guest");
        });

        it("should ignore default when value is provided", () => {
            expect(formatString("Hello ${name|Guest}", { name: "John" })).toBe("Hello John");
        });

        it("should handle empty default (pipe with nothing after it)", () => {
            expect(formatString("Hello ${name|}", { name: "" })).toBe("Hello ");
        });

        it("should handle default with spaces", () => {
            expect(formatString("Hello ${name|John Doe}")).toBe("Hello John Doe");
        });

        it("should handle default value that contains special chars", () => {
            expect(formatString("Contact: ${email|no-reply@example.com}")).toBe(
                "Contact: no-reply@example.com"
            );
        });
    });

    describe("dot-notation (nested object access)", () => {
        it("should resolve simple nested path", () => {
            expect(formatString("${user.name}", { user: { name: "Alice" } })).toBe("Alice");
        });

        it("should resolve deeply nested path", () => {
            const params = { a: { b: { c: { d: "deep" } } } };
            expect(formatString("${a.b.c.d}", params)).toBe("deep");
        });

        it("should resolve multiple nested paths", () => {
            const params = { user: { name: "Alice", city: "Amsterdam" } };
            expect(formatString("${user.name} lives in ${user.city}", params)).toBe(
                "Alice lives in Amsterdam"
            );
        });

        it("should keep placeholder when nested path is missing", () => {
            expect(formatString("${user.age}", { user: { name: "Alice" } })).toBe("${user.age}");
        });

        it("should use default when nested path is missing", () => {
            expect(formatString("${user.age|unknown}", { user: { name: "Alice" } })).toBe(
                "unknown"
            );
        });

        it("should keep placeholder when intermediate segment is missing", () => {
            expect(formatString("${user.address.city}", { user: {} })).toBe(
                "${user.address.city}"
            );
        });

        it("should keep placeholder when root is missing", () => {
            expect(formatString("${org.name}", { user: { name: "Alice" } })).toBe("${org.name}");
        });
    });

    describe("numeric and boolean values", () => {
        it("should convert number to string", () => {
            expect(formatString("Found ${count} items", { count: 42 })).toBe("Found 42 items");
        });

        it("should convert zero to string (not treat as missing)", () => {
            expect(formatString("Count: ${n}", { n: 0 })).toBe("Count: 0");
        });

        it("should convert negative number to string", () => {
            expect(formatString("Temp: ${t}°C", { t: -5 })).toBe("Temp: -5°C");
        });

        it("should convert float to string", () => {
            expect(formatString("Price: ${price}", { price: 9.99 })).toBe("Price: 9.99");
        });

        it("should convert boolean false to string (not treat as missing)", () => {
            expect(formatString("Active: ${flag}", { flag: false })).toBe("Active: false");
        });

        it("should convert boolean true to string", () => {
            expect(formatString("Active: ${flag}", { flag: true })).toBe("Active: true");
        });
    });

    describe("fast paths", () => {
        it("should return template unchanged when params is undefined", () => {
            expect(formatString("Hello ${name}")).toBe("Hello ${name}");
        });

        it("should return template unchanged when params is explicitly undefined", () => {
            expect(formatString("Hello ${name}", undefined)).toBe("Hello ${name}");
        });

        it("should return template unchanged when no ${ in template", () => {
            expect(formatString("Hello world", { name: "John" })).toBe("Hello world");
        });

        it("should return empty string for empty template", () => {
            expect(formatString("")).toBe("");
        });

        it("should return empty string for empty template with params", () => {
            expect(formatString("", { name: "John" })).toBe("");
        });

        it("should return plain text with no placeholders untouched", () => {
            expect(formatString("No placeholders here")).toBe("No placeholders here");
        });
    });

    describe("missing keys (no default)", () => {
        it("should keep placeholder when key is not in params", () => {
            expect(formatString("Hello ${unknown}", { name: "John" })).toBe("Hello ${unknown}");
        });

        it("should keep placeholder when params is empty object", () => {
            expect(formatString("Hello ${name}", {})).toBe("Hello ${name}");
        });

        it("should mix resolved and unresolved placeholders", () => {
            expect(formatString("${a} and ${b}", { a: "X" })).toBe("X and ${b}");
        });
    });

    describe("whitespace tolerance in placeholders", () => {
        it("should handle spaces inside braces around key", () => {
            expect(formatString("Hello ${ name }", { name: "John" })).toBe("Hello John");
        });

        it("should handle spaces inside braces around key with default", () => {
            expect(formatString("Hello ${ name | Guest }", {})).toBe("Hello  Guest ");
        });
    });

    describe("edge cases", () => {
        it("should handle template with dollar sign but no brace", () => {
            expect(formatString("Price is $100", { "100": "val" })).toBe("Price is $100");
        });

        it("should handle incomplete placeholder syntax", () => {
            expect(formatString("Hello ${", {})).toBe("Hello ${");
        });

        it("should handle placeholder with only closing brace", () => {
            expect(formatString("Hello }", {})).toBe("Hello }");
        });

        it("should handle very long template with many placeholders", () => {
            const params: Record<string, string> = {};
            let template = "";
            for (let i = 0; i < 100; i++) {
                params[`key${i}`] = `val${i}`;
                template += `${i}: \${key${i}} `;
            }
            const result = formatString(template, params);
            expect(result).toContain("0: val0");
            expect(result).toContain("99: val99");
        });

        it("should not interpret backslash-dollar as escape", () => {
            // We don't support escaping — backslash stays, placeholder is replaced
            expect(formatString("\\${name}", { name: "test" })).toBe("\\test");
        });

        it("should handle template with only a placeholder", () => {
            expect(formatString("${x}", { x: "value" })).toBe("value");
        });

        it("should handle params with extra unused keys", () => {
            expect(formatString("${a}", { a: "1", b: "2", c: "3" })).toBe("1");
        });
    });
});
