/**
 * Implementation tests for the principal discriminator helper.
 *
 * These cover the internal precedence contract of `withPrincipalType` and the
 * default claims mapper, plus the Memory provider's fallback to the configured
 * type when its stored result does not carry one.
 *
 * @packageDocumentation
 */

import { describe, it, expect } from "vitest";

import { AuthProvider } from "../src/abstract-auth-provider.js";
import { MemoryAuthProvider } from "../src/memory-auth-provider.js";
import type { AuthProviderConfig, AuthResult } from "../src/types.js";

/** Minimal concrete provider that exposes the protected helper for testing. */
class ExposedProvider extends AuthProvider {
    constructor(config: AuthProviderConfig = {}) {
        super(config);
    }

    async validate(): Promise<AuthResult | undefined> {
        return undefined;
    }

    async health(): Promise<boolean> {
        return true;
    }

    async shutdown(): Promise<void> {
        // no-op
    }

    /** Expose the protected stamping helper. */
    stamp(result: AuthResult | undefined): AuthResult | undefined {
        return this.withPrincipalType(result);
    }

    /** Expose the protected default claims mapper. */
    mapDefault(token: string, claims: Record<string, unknown>): AuthResult {
        return this.defaultClaimsMapper(token, claims);
    }
}

/** An AuthResult with no principal type. */
function plainResult(): AuthResult {
    return { sub: "user-1", claims: {}, token: "token" };
}

describe("Implementation: principal discriminator", () => {
    it("fills the configured type when the result has none", () => {
        const provider = new ExposedProvider({ principalType: "client" });

        const stamped = provider.stamp(plainResult());

        expect(stamped?.principalType).toBe("client");
    });

    it("keeps a value already present on the result", () => {
        const provider = new ExposedProvider({ principalType: "client" });
        const existing: AuthResult = { ...plainResult(), principalType: "user" };

        const stamped = provider.stamp(existing);

        expect(stamped?.principalType).toBe("user");
    });

    it("leaves the result unchanged when no type is configured", () => {
        const provider = new ExposedProvider();

        const stamped = provider.stamp(plainResult());

        expect(stamped).toEqual(plainResult());
        expect(stamped?.principalType).toBeUndefined();
    });

    it("returns undefined unchanged", () => {
        const provider = new ExposedProvider({ principalType: "client" });

        expect(provider.stamp(undefined)).toBeUndefined();
    });

    it("includes the configured type in the default claims mapper", () => {
        const provider = new ExposedProvider({ principalType: "user" });

        const mapped = provider.mapDefault("token", { sub: "s" });

        expect(mapped.principalType).toBe("user");
    });

    it("omits the type from the default mapper when unconfigured", () => {
        const provider = new ExposedProvider();

        const mapped = provider.mapDefault("token", { sub: "s" });

        expect(mapped.principalType).toBeUndefined();
    });

    it("fills the Memory provider result from config when it has no type", async () => {
        const provider = new MemoryAuthProvider({
            principalType: "client",
            validTokens: { "memory-token": plainResult() },
        });

        const result = await provider.validate("memory-token");

        expect(result?.principalType).toBe("client");
        expect(await provider.validate("missing-token")).toBeUndefined();
    });

    it("does not overwrite a Memory result that already carries a type", async () => {
        const stored: AuthResult = { ...plainResult(), principalType: "user" };
        const provider = new MemoryAuthProvider({
            principalType: "client",
            validTokens: { "memory-token": stored },
        });

        const result = await provider.validate("memory-token");

        expect(result?.principalType).toBe("user");
    });
});
