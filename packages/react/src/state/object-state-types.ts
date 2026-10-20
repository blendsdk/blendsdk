/**
 * Public types for the object-shaped local-state hook.
 *
 * @packageDocumentation
 */

/**
 * Updates object-shaped local state with a partial patch.
 *
 * The callback form receives the latest state, so consecutive updates in the
 * same event always build on each other instead of on a stale render value.
 *
 * @template T The state shape. It must be a plain object type.
 */
export type ObjectStateSetter<T extends object> = (
    update: Partial<T> | ((previous: T) => Partial<T>),
) => void;

/**
 * Restores the state produced by the hook's original factory.
 *
 * Reset stores a fresh object; it does not reuse the initial reference, so
 * later mutations cannot leak into the reset baseline. This requires the
 * factory to return a new plain object on every call.
 */
export type ObjectStateReset = () => void;

/**
 * The tuple returned by {@link useObjectState}.
 *
 * @template T The state shape.
 */
export type UseObjectStateResult<T extends object> = [
    T,
    ObjectStateSetter<T>,
    ObjectStateReset,
];
