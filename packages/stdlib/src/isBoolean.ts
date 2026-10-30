/**
 * Tests whether the given value is a boolean primitive.
 *
 * Uses a type predicate so TypeScript narrows the type to `boolean`
 * inside conditional blocks after calling this function.
 *
 * Note: `new Boolean(true)` creates an object wrapper, not a primitive,
 * so this function returns `false` for Boolean object wrappers.
 *
 * @export
 * @param {unknown} value - The value to test.
 * @returns {boolean} True if the value is a boolean primitive, false otherwise.
 */
export function isBoolean(value: unknown): value is boolean {
    return typeof value === "boolean";
}
