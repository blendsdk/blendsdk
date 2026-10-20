/**
 * Object-shaped local-state hook.
 *
 * @packageDocumentation
 */

import { useCallback, useRef, useState } from "react";

import type {
    ObjectStateReset,
    ObjectStateSetter,
    UseObjectStateResult,
} from "./object-state-types.js";

/**
 * Narrows a setter argument to the functional-updater form.
 *
 * `Partial<T>` is always a plain object, so a function value can only be the
 * updater. The guard keeps the setter free of an unsafe `as` cast.
 *
 * @template T The state shape.
 * @param update The partial patch or the functional updater.
 * @returns `true` when the argument is the functional updater.
 */
function isUpdater<T extends object>(
    update: Partial<T> | ((previous: T) => Partial<T>),
): update is (previous: T) => Partial<T> {
    return typeof update === "function";
}

/**
 * Manages an object-shaped piece of local component state.
 *
 * The factory runs lazily on mount and supplies the initial object.
 * `setState` shallow-merges a partial patch into the latest state; `reset`
 * calls the original factory again and stores a fresh object. Both callbacks
 * keep the same identity across renders.
 *
 * The hook is for plain objects. Arrays, class instances, and function values
 * are outside the contract because the merge relies on object spreading,
 * which drops prototypes and array behavior. Nested objects are replaced, not
 * deep-merged, and setting a property to `undefined` leaves the key present.
 *
 * The factory must be pure and must return a new plain object on every call.
 * React may call it twice in development StrictMode to detect side effects,
 * and `reset` calls it again.
 *
 * @remarks
 * Compared with the v3 hook, the setter and reset are stable across renders.
 * Code that listed `setState` in a dependency array and read `state` without
 * listing it must add the state values it reads, or use the functional
 * updater form. Relying on a changing setter identity is not supported.
 *
 * @example
 * ```tsx
 * import { useObjectState } from "@blendsdk/react";
 *
 * interface FormState {
 *     name: string;
 *     age: number;
 * }
 *
 * function ProfileForm() {
 *     const [state, setState, reset] = useObjectState<FormState>(() => ({
 *         name: "",
 *         age: 0,
 *     }));
 *
 *     return (
 *         <form>
 *             <input
 *                 value={state.name}
 *                 onChange={(event) => setState({ name: event.target.value })}
 *             />
 *             <button type="button" onClick={reset}>
 *                 Reset
 *             </button>
 *         </form>
 *     );
 * }
 * ```
 */
export function useObjectState<T extends object>(
    create: () => T,
): UseObjectStateResult<T> {
    const [state, setState] = useState<T>(create);
    const createRef = useRef(create);

    const setObjectState = useCallback<ObjectStateSetter<T>>((update) => {
        setState((previous) => {
            const patch = isUpdater(update) ? update(previous) : update;
            return { ...previous, ...patch };
        });
    }, []);

    const reset = useCallback<ObjectStateReset>(() => {
        setState(createRef.current());
    }, []);

    return [state, setObjectState, reset];
}
