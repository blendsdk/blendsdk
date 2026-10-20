// @vitest-environment jsdom

/**
 * Implementation tests for the object-shaped local-state hook.
 *
 * These cover the internals behind the public contract: when the factory runs,
 * whether callback identities survive re-renders, how reset treats the initial
 * reference and a later factory, shallow nesting, an explicitly undefined key,
 * StrictMode's development double-invoke, and the type-level tuple.
 *
 * @packageDocumentation
 */

import { describe, it, expect, vi } from "vitest";
import { StrictMode } from "react";
import { act, renderHook } from "@testing-library/react";
import { useObjectState } from "../src/index.js";

interface FormState {
    name: string;
    age: number;
    active: boolean;
}

/** Creates the initial form state used by the implementation cases. */
function createFormState(): FormState {
    return {
        name: "Alice",
        age: 30,
        active: true,
    };
}

describe("useObjectState — Implementation Tests", () => {
    it("should not call the factory on a re-render", () => {
        const create = vi.fn(createFormState);
        const { rerender } = renderHook(() => useObjectState(create));

        rerender();

        expect(create).toHaveBeenCalledTimes(1);
    });

    it("should keep the setter identity stable when the factory changes", () => {
        const { result, rerender } = renderHook(
            ({ create }) => useObjectState(create),
            { initialProps: { create: createFormState } },
        );
        const setter = result.current[1];

        act(() => {
            result.current[1]({ name: "Bob" });
        });
        rerender({
            create: () => ({ name: "Other", age: 1, active: false }),
        });

        expect(result.current[1]).toBe(setter);
    });

    it("should keep the reset identity stable when the factory changes", () => {
        const { result, rerender } = renderHook(
            ({ create }) => useObjectState(create),
            { initialProps: { create: createFormState } },
        );
        const reset = result.current[2];

        act(() => {
            result.current[1]({ name: "Bob" });
        });
        rerender({
            create: () => ({ name: "Other", age: 1, active: false }),
        });

        expect(result.current[2]).toBe(reset);
    });

    it("should produce a fresh object on reset", () => {
        const { result } = renderHook(() => useObjectState(createFormState));
        const initial = result.current[0];

        act(() => {
            result.current[1]({ name: "Bob" });
        });
        act(() => {
            result.current[2]();
        });

        expect(result.current[0]).not.toBe(initial);
        expect(result.current[0]).toEqual(initial);
    });

    it("should keep using the mount-time factory after a re-render", () => {
        const firstFactory = () => ({
            name: "First",
            age: 1,
            active: true,
        });
        const secondFactory = () => ({
            name: "Second",
            age: 2,
            active: false,
        });

        const { result, rerender } = renderHook(
            ({ create }) => useObjectState(create),
            { initialProps: { create: firstFactory } },
        );

        act(() => {
            result.current[1]({ name: "Changed" });
        });
        rerender({ create: secondFactory });
        act(() => {
            result.current[2]();
        });

        expect(result.current[0]).toEqual({
            name: "First",
            age: 1,
            active: true,
        });
    });

    it("should replace nested objects instead of deep-merging them", () => {
        interface NestedState {
            profile: { name: string; age?: number };
            active: boolean;
        }

        const { result } = renderHook(() =>
            useObjectState<NestedState>(() => ({
                profile: { name: "Alice", age: 30 },
                active: true,
            })),
        );

        act(() => {
            result.current[1]({ profile: { name: "Bob" } });
        });

        expect(result.current[0]).toEqual({
            profile: { name: "Bob" },
            active: true,
        });
        expect(result.current[0].profile.age).toBeUndefined();
    });

    it("should leave a key present when it is set to undefined", () => {
        interface OptionalState {
            name: string;
            nickname?: string;
        }

        const { result } = renderHook(() =>
            useObjectState<OptionalState>(() => ({
                name: "Alice",
                nickname: "Al",
            })),
        );

        act(() => {
            result.current[1]({ nickname: undefined });
        });

        expect("nickname" in result.current[0]).toBe(true);
        expect(result.current[0].nickname).toBeUndefined();
    });

    it("should keep the state correct under StrictMode's double-invoke", () => {
        const { result } = renderHook(() => useObjectState(createFormState), {
            wrapper: StrictMode,
        });

        act(() => {
            result.current[1]({ name: "Bob" });
            result.current[1]((previous) => ({ age: previous.age + 1 }));
        });

        expect(result.current[0]).toEqual({
            name: "Bob",
            age: 31,
            active: true,
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

    it("should apply a partial update and a functional update", () => {
        const { result } = renderHook(() =>
            useObjectState<FormState>(createFormState),
        );

        act(() => {
            result.current[1]({ name: "Bob" });
            result.current[1]((previous) => ({ age: previous.age + 1 }));
        });

        expect(result.current[0]).toEqual({
            name: "Bob",
            age: 31,
            active: true,
        });
    });
});
