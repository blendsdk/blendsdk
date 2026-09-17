/**
 * Tests whether the given value is null or undefined.
 *
 * Uses a type predicate to narrow the type in TypeScript conditional blocks.
 * After calling `if (!isNullOrUndef(value))`, TypeScript knows `value` is
 * neither `null` nor `undefined`.
 *
 * @export
 * @param {unknown} value - The value to test.
 * @returns {boolean} True if the value is null or undefined, false otherwise.
 */
export function isNullOrUndef(value: unknown): value is null | undefined {
    return value === null || value === undefined;
}

/**
 * Tests whether the given value is null or undefined and returns
 * a default value if so.
 *
 * @export
 * @template ReturnType
 * @param {ReturnType} value - The value to test.
 * @param {ReturnType} defaultValue - The fallback value to return when value is null/undefined.
 * @returns {ReturnType} The original value if defined, otherwise the default value.
 */
export function isNullOrUndefDefault<ReturnType>(value: ReturnType, defaultValue: ReturnType): ReturnType {
    return isNullOrUndef(value) ? defaultValue : value;
}
