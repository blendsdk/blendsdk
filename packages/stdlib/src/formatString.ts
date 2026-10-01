/**
 * Global regex for matching all ${...} placeholders in a template.
 * Uses the 'g' flag to match all occurrences.
 *
 * Pattern breakdown:
 * \$\{        — literal ${
 * \s*         — optional whitespace inside braces
 * (           — capture group 1: the full expression
 *   [\w.]+   — one or more word chars or dots (the key path)
 *   (?:\s*\|[^}]*)? — optional: pipe + default value (anything except })
 * )
 * \s*         — optional trailing whitespace
 * \}          — literal }
 *
 * Capture groups:
 * - Group 1: The full expression inside ${ } (e.g., "name|default")
 */
const PLACEHOLDER_REGEX_G = /\$\{\s*([\w.]+(?:\s*\|[^}]*)?)\s*\}/g;

/**
 * Resolve a dot-notation path against a nested object.
 *
 * Walks each segment of the dot-separated path, returning `undefined`
 * if any intermediate segment is null or undefined.
 *
 * @param obj - The root object to resolve against
 * @param path - Dot-separated path (e.g., "user.name", "address.city")
 * @returns The resolved value, or undefined if any segment is missing
 *
 * @example
 * resolveNestedKey({ user: { name: "Alice" } }, "user.name") // → "Alice"
 * resolveNestedKey({ user: { name: "Alice" } }, "user.age")  // → undefined
 * resolveNestedKey({ name: "Bob" }, "name")                   // → "Bob"
 */
function resolveNestedKey(obj: Record<string, unknown>, path: string): unknown {
    return path.split(".").reduce<unknown>((current, segment) => {
        // Bail out early if we hit a null/undefined intermediate
        if (current === null || current === undefined) return undefined;
        return (current as Record<string, unknown>)[segment];
    }, obj);
}

/**
 * Format a string by replacing ${...} placeholders with values from a params object.
 *
 * Supported placeholder syntax:
 * - `${name}` — Simple substitution from params.name
 * - `${name|default}` — Use "default" if params.name is undefined/null/empty
 * - `${user.name}` — Dot-notation for nested object access
 * - `${user.name|Anonymous}` — Dot-notation with default value
 *
 * Behavior:
 * - If a key is found in params and is not null/undefined/empty-string, its string value is used
 * - If a key is not found and a default is provided, the default is used
 * - If a key is not found and no default is provided, the raw placeholder is kept
 *   (e.g., "${unknown}" stays as "${unknown}")
 * - Zero (0) and false are valid values — they are converted to string
 * - Empty string ("") is treated as missing — falls through to default
 *
 * @param template - The template string containing ${...} placeholders
 * @param params - Object with values to substitute (supports nested objects)
 * @returns The formatted string with placeholders replaced
 *
 * @example
 * // Simple substitution
 * formatString("Hello ${name}", { name: "John" })
 * // → "Hello John"
 *
 * // Default value
 * formatString("Hello ${name|Guest}")
 * // → "Hello Guest"
 *
 * // With provided value (default ignored)
 * formatString("Hello ${name|Guest}", { name: "John" })
 * // → "Hello John"
 *
 * // Dot-notation
 * formatString("${user.name} lives in ${user.city}", { user: { name: "Alice", city: "Amsterdam" } })
 * // → "Alice lives in Amsterdam"
 *
 * // Missing key (no default) — placeholder kept
 * formatString("Hello ${unknown}")
 * // → "Hello ${unknown}"
 *
 * // Numeric values
 * formatString("Found ${count} items", { count: 42 })
 * // → "Found 42 items"
 *
 * // Empty string with default
 * formatString("Hello ${name|Guest}", { name: "" })
 * // → "Hello Guest"
 */
export function formatString(template: string, params?: Record<string, unknown>): string {
    // Fast path: no placeholders in template at all
    if (!template.includes("${")) {
        return template;
    }

    // Use empty object when no params provided — defaults still need to be resolved
    const resolvedParams = params ?? {};

    return template.replace(PLACEHOLDER_REGEX_G, (match, expression: string) => {
        // Split on first pipe to separate key from default value
        const pipeIndex = expression.indexOf("|");
        const key = (pipeIndex >= 0 ? expression.slice(0, pipeIndex) : expression).trim();
        const defaultValue = pipeIndex >= 0 ? expression.slice(pipeIndex + 1) : undefined;

        // Resolve the value from params (supports dot-notation paths)
        const value = resolveNestedKey(resolvedParams, key);

        // Use the value if it's defined, not null, and not empty string
        if (value !== undefined && value !== null && value !== "") {
            return String(value);
        }

        // Fall back to default value if provided (pipe was present)
        if (defaultValue !== undefined) {
            return defaultValue;
        }

        // No value and no default — keep the raw placeholder unchanged
        return match;
    });
}
