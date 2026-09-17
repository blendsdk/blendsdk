/**
 * Specification tests for the package entry-point surface.
 *
 * The package documentation names a fixed set of providers, plugin factories,
 * a provider factory, a controller, and default constants. Consumers import
 * those names from `@blendsdk/webafx-auth`, so the entry point must keep
 * exporting them. These tests import the documented runtime names from the
 * entry point and assert they are present; a removed or renamed export fails
 * here instead of only surfacing as a consumer compile error.
 *
 * The type-only import below lists the documented type surface in one place.
 * It is a readable statement of that surface and is checked by an editor or a
 * type-checker pointed at this file; it is not machine-enforced by CI, because
 * the package build excludes test files and the test runner does not
 * type-check. The build still guarantees that every type re-exported by the
 * entry point resolves in its source module.
 *
 * @packageDocumentation
 */

import { describe, it, expect } from 'vitest';

import {
  AuthProvider,
  MemoryAuthProvider,
  JwtAuthProvider,
  IntrospectionAuthProvider,
  OidcAuthProvider,
  createAuthPlugin,
  oidcAuthPlugin,
  jwtAuthPlugin,
  introspectionAuthPlugin,
  memoryAuthPlugin,
  createAuthProvider,
  OidcAuthController,
  DEFAULT_SERVICE_NAME,
  DEFAULT_PLUGIN_PRIORITY,
  DEFAULT_COOKIE_NAME,
  DEFAULT_QUERY_PARAM_NAME,
  DEFAULT_TOKEN_SOURCES,
} from '../src/index.js';

import type {
  AuthResult,
  PrincipalType,
  AuthProviderConfig,
  JwtAuthConfig,
  IntrospectionAuthOptions,
  IntrospectionAuthConfig,
  IntrospectionAuthDynamicConfig,
  IntrospectionProviderConfig,
  TenantAuthConfig,
  MemoryAuthConfig,
  AuthFactoryConfig,
  TokenSource,
  TokenExtractor,
  ClaimsMapper,
  TenantResolver,
  TenantProviderFactory,
  AuthProviderLike,
  OidcAuthConfig,
  OidcTokens,
  AuthorizationUrlResult,
  BuildAuthorizationUrlParams,
  ExchangeCodeParams,
  OidcSessionState,
  OidcSession,
  AuthPluginOptions,
} from '../src/index.js';

describe('Public API surface — Specification Tests', () => {
  it('exports the five documented default constants', () => {
    expect(DEFAULT_SERVICE_NAME).toBeDefined();
    expect(DEFAULT_PLUGIN_PRIORITY).toBeDefined();
    expect(DEFAULT_COOKIE_NAME).toBeDefined();
    expect(DEFAULT_QUERY_PARAM_NAME).toBeDefined();
    expect(DEFAULT_TOKEN_SOURCES).toBeDefined();
  });

  it('exports the AuthProvider base class as a constructible class', () => {
    expect(AuthProvider).toBeDefined();
    expect(typeof AuthProvider).toBe('function');
  });

  it('exports the four concrete providers as constructible classes', () => {
    const providers = [
      MemoryAuthProvider,
      JwtAuthProvider,
      IntrospectionAuthProvider,
      OidcAuthProvider,
    ];

    for (const provider of providers) {
      expect(provider).toBeDefined();
      expect(typeof provider).toBe('function');
    }
  });

  it('exports the five plugin factories as callable functions', () => {
    const pluginFactories = [
      createAuthPlugin,
      oidcAuthPlugin,
      jwtAuthPlugin,
      introspectionAuthPlugin,
      memoryAuthPlugin,
    ];

    for (const factory of pluginFactories) {
      expect(factory).toBeDefined();
      expect(typeof factory).toBe('function');
    }
  });

  it('exports the createAuthProvider factory as a callable function', () => {
    expect(createAuthProvider).toBeDefined();
    expect(typeof createAuthProvider).toBe('function');
  });

  it('exports the OidcAuthController as a constructible class', () => {
    expect(OidcAuthController).toBeDefined();
    expect(typeof OidcAuthController).toBe('function');
  });
});
