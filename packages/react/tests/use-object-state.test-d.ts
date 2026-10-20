/**
 * Type-level tests for the object-shaped local-state hook.
 *
 * These assertions are checked by Vitest's typecheck runner. They prove that
 * an interface-typed state is accepted without an index signature and that
 * the tuple exposes the documented setter and reset types.
 *
 * @packageDocumentation
 */

import { expectTypeOf } from "vitest";

import {
    useObjectState,
    type ObjectStateReset,
    type ObjectStateSetter,
    type UseObjectStateResult,
} from "../src/index.js";

interface FormState {
    name: string;
    age: number;
    active: boolean;
}

declare const result: UseObjectStateResult<FormState>;

expectTypeOf(result[0]).toEqualTypeOf<FormState>();
expectTypeOf(result[1]).toEqualTypeOf<ObjectStateSetter<FormState>>();
expectTypeOf(result[2]).toEqualTypeOf<ObjectStateReset>();

/**
 * Compiles only when an interface state and `Partial<T>` patches are accepted.
 * It is never executed; the typecheck runner reads the declarations.
 */
function acceptsInterfaceState(): void {
    const [state, setState, reset] = useObjectState<FormState>(() => ({
        name: "Alice",
        age: 30,
        active: true,
    }));

    expectTypeOf(state).toEqualTypeOf<FormState>();
    setState({ name: "Bob" });
    setState(previous => ({ age: previous.age + 1 }));
    reset();
}

void acceptsInterfaceState;
