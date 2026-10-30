/**
 * Specification tests for createAuthProvider().
 *
 * `createAuthProvider()` selects a concrete AuthProvider from an
 * `AuthFactoryConfig`. These tests verify the dispatch for each supported
 * `type` and the validation error raised when required fields are missing.
 *
 * @remarks No Docker required — all unit tests.
 */

import { describe, it, expect } from "vitest";

import { createAuthProvider } from "../src/auth-factory.js";
import { IntrospectionAuthProvider } from "../src/introspection-auth-provider.js";
import { JwtAuthProvider } from "../src/jwt-auth-provider.js";
import { OidcAuthProvider } from "../src/oidc-auth-provider.js";
import { MemoryAuthProvider } from "../src/memory-auth-provider.js";
import type { AuthFactoryConfig } from "../src/types.js";

// ---------------------------------------------------------------------------
// Specification Tests
// ---------------------------------------------------------------------------

describe("createAuthProvider — Specification Tests", () => {
    describe("ST-127: introspection dispatch", () => {
        it("returns an IntrospectionAuthProvider for static credentials", () => {
            const provider = createAuthProvider({
                type: "introspection",
                introspectionUrl: "https://auth.example.com/introspect",
                clientId: "client",
                clientSecret: "secret",
            });

            expect(provider).toBeInstanceOf(IntrospectionAuthProvider);
        });
    });

    describe("ST-128: jwt dispatch", () => {
        it("returns a JwtAuthProvider when a secret is provided", () => {
            const provider = createAuthProvider({
                type: "jwt",
                secret: "a-secret-that-is-long-enough-for-hs256",
            });

            expect(provider).toBeInstanceOf(JwtAuthProvider);
        });
    });

    describe("ST-129: oidc dispatch", () => {
        it("returns an OidcAuthProvider when an issuerUrl is provided", () => {
            const provider = createAuthProvider({
                type: "oidc",
                issuerUrl: "https://auth.example.com",
                clientId: "client",
            });

            expect(provider).toBeInstanceOf(OidcAuthProvider);
        });
    });

    describe("ST-130: memory dispatch", () => {
        it("returns a MemoryAuthProvider", () => {
            const provider = createAuthProvider({ type: "memory" });

            expect(provider).toBeInstanceOf(MemoryAuthProvider);
        });
    });

    describe("ST-131: introspection requires credentials or a factory", () => {
        it("throws naming the missing fields", () => {
            expect(() =>
                createAuthProvider({ type: "introspection" })
            ).toThrow(/introspectionUrl/);
        });
    });

    describe("ST-132: jwt requires a secret", () => {
        it("throws naming the secret", () => {
            expect(() => createAuthProvider({ type: "jwt" })).toThrow(
                /secret/
            );
        });
    });

    describe("ST-133: introspection with a configFactory", () => {
        it("returns an IntrospectionAuthProvider", () => {
            const config: AuthFactoryConfig = {
                type: "introspection",
                configFactory: async () => ({
                    introspectionUrl: "https://auth.example.com/introspect",
                    clientId: "client",
                    clientSecret: "secret",
                }),
            };

            expect(createAuthProvider(config)).toBeInstanceOf(
                IntrospectionAuthProvider
            );
        });
    });
});
