import { isNullOrUndef } from "./isNullOrUndef.js";

/**
 * Wraps the given value in an array if it is not already an array.
 *
 * Returns an empty array if the value is null or undefined.
 * Returns the value unchanged if it is already an array.
 * Otherwise wraps the value in a single-element array.
 *
 * @export
 * @template T - The type of elements in the resulting array.
 * @param {unknown} obj - The value to wrap.
 * @returns {Array<T>} An array containing the value, or the value itself if already an array.
 */
export function wrapInArray<T>(obj: unknown): T[] {
    return Array.isArray(obj) ? obj : isNullOrUndef(obj) ? [] : [obj as T];
}
