// @vitest-environment jsdom

/**
 * Specification tests for the object-shaped local-state hook.
 *
 * These cases describe the public contract: the factory supplies the initial
 * object, updates merge shallowly into the latest state, a functional updater
 * sees that latest state, reset restores the initial values, and two hook
 * instances stay isolated. A failure here means the implementation is wrong,
 * never the test.
 *
 * @packageDocumentation
 */

import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useObjectState } from "../src/index.js";

interface FormState {
    name: string;
    age: number;
    active: boolean;
}

/** Creates the initial form state used by the specification cases. */
function createFormState(): FormState {
    return {
        name: "Alice",
        age: 30,
        active: true,
    };
}

describe("useObjectState — Specification Tests", () => {
    it("should return the factory's initial object", () => {
        const { result } = renderHook(() => useObjectState(createFormState));

        expect(result.current[0]).toEqual({
            name: "Alice",
            age: 30,
            active: true,
        });
    });

    it("should merge a partial update and preserve untouched fields", () => {
        const { result } = renderHook(() => useObjectState(createFormState));

        act(() => {
            result.current[1]({ name: "Bob" });
        });

        expect(result.current[0]).toEqual({
            name: "Bob",
            age: 30,
            active: true,
        });
    });

    it("should update multiple fields in one call", () => {
        const { result } = renderHook(() => useObjectState(createFormState));

        act(() => {
            result.current[1]({ name: "Carol", age: 41 });
        });

        expect(result.current[0]).toEqual({
            name: "Carol",
            age: 41,
            active: true,
        });
    });

    it("should pass the latest state to a functional updater", () => {
        const { result } = renderHook(() => useObjectState(createFormState));

        act(() => {
            result.current[1]((previous) => ({ age: previous.age + 1 }));
            result.current[1]((previous) => ({ age: previous.age + 1 }));
        });

        expect(result.current[0]).toEqual({
            name: "Alice",
            age: 32,
            active: true,
        });
    });

    it("should restore the initial values on reset", () => {
        const { result } = renderHook(() => useObjectState(createFormState));

        act(() => {
            result.current[1]({ name: "Bob", age: 55, active: false });
        });
        act(() => {
            result.current[2]();
        });

        expect(result.current[0]).toEqual({
            name: "Alice",
            age: 30,
            active: true,
        });
    });

    it("should isolate two hook instances", () => {
        const first = renderHook(() => useObjectState(createFormState));
        const second = renderHook(() => useObjectState(createFormState));

        act(() => {
            first.result.current[1]({ name: "First" });
        });

        expect(first.result.current[0].name).toBe("First");
        expect(second.result.current[0].name).toBe("Alice");
    });
});
