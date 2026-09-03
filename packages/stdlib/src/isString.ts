/**
 * Tests whether the given value is a string primitive.
 *
 * Uses a type predicate so TypeScript narrows the type to `string`
 * inside conditional blocks after calling this function.
 *
 * Note: `new String("hello")` creates an object wrapper, not a primitive,
 * so this function returns `false` for String object wrappers.
 *
 * @export
 * @param {unknown} value - The value to test.
 * @returns {boolean} True if the value is a string primitive, false otherwise.
 */
export function isString(value: unknown): value is string {
    return typeof value === "string";
}
