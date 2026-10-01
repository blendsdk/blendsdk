/**
 * Tests whether the given value is numeric.
 *
 * Accepts finite numbers and strings that represent valid, complete numbers.
 * Unlike the previous implementation that used `parseFloat` (which would
 * accept "42px" or "3.14em"), this implementation requires the entire
 * value to be a valid number.
 *
 * Specifically:
 * - Returns `true` for finite number primitives (not NaN, not Infinity).
 * - Returns `true` for string representations of finite numbers (e.g., "42", "3.14", "-100", "1e10").
 * - Returns `false` for NaN, Infinity, booleans, null, undefined, objects, arrays, etc.
 * - Returns `false` for partial numeric strings like "42px", "3.14em", "100%".
 *
 * @export
 * @param {unknown} value - The value to test.
 * @returns {boolean} True if the value is a finite number or a string that fully represents one.
 */
export function isNumeric(value: unknown): boolean {
    // Handle number primitives directly: must be finite (rejects NaN and Infinity)
    if (typeof value === "number") {
        return Number.isFinite(value);
    }

    // Handle string values: must fully represent a finite number
    if (typeof value === "string") {
        // Reject empty or whitespace-only strings
        const trimmed = value.trim();
        if (trimmed === "") {
            return false;
        }

        // Use the unary + operator which converts the full string to a number.
        // Unlike parseFloat, +"42px" returns NaN (not 42).
        const num = +trimmed;
        return Number.isFinite(num);
    }

    // All other types (boolean, null, undefined, objects, arrays, symbols, bigint, etc.)
    return false;
}
