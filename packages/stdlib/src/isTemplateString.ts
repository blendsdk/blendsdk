/**
 * Regex pattern for detecting ${...} placeholders in a string.
 *
 * Matches: ${name}, ${name|default}, ${user.name}, ${user.name|fallback}
 *
 * Pattern breakdown:
 * \$\{           — literal ${
 * \s*            — optional whitespace
 * [\w.]+         — one or more word chars or dots (the key path)
 * \s*            — optional whitespace
 * (?:\|[^}]*)?   — optional: pipe + default value (anything except })
 * \s*            — optional whitespace
 * \}             — literal }
 *
 * Does NOT use the 'g' flag — we only need to find one match to confirm
 * the string is a template.
 */
const PLACEHOLDER_REGEX = /\$\{\s*[\w.]+\s*(?:\|[^}]*)?\s*\}/;

/**
 * Check if a string contains ${...} template placeholders.
 *
 * Returns true if the string contains at least one valid placeholder
 * matching the ${key}, ${key|default}, or ${path.to.key} syntax.
 *
 * @param value - The string to check
 * @returns true if the string contains at least one ${...} placeholder
 *
 * @example
 * isTemplateString("Hello ${name}")        // → true
 * isTemplateString("Hello ${name|World}")  // → true
 * isTemplateString("${user.name}")         // → true
 * isTemplateString("Hello world")          // → false
 * isTemplateString("")                     // → false
 */
export function isTemplateString(value: string): boolean {
    return PLACEHOLDER_REGEX.test(value);
}
