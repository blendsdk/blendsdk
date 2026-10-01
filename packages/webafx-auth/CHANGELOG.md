# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [5.65.0] - 2026-09-27

Added:
- Introduced OidcAuthConfig.rotateSessionIdOnRefresh for session ID rotation on refresh.
- Implemented IntrospectionAuthProvider for validating opaque tokens as per RFC 7662.
- Added CSRF protection middleware with configurable options for security.
- Generated versionless ai-training and skill references for better documentation consistency.

Changed:
- Enhanced error handling for OIDC processes, classifying ID-token key-selection and parse failures as flow errors.
- Regenerated ai-training documentation with updates to concepts and best practices.
- Updated documentation to clarify callback outcomes and introduce hardened returnTo validation rules.

Fixed:
- Fixed oidc_error message to use a consistent and accurate response.
- Addressed security flaws by rejecting unsafe returnTo values in redirect processes.
- Adjusted system to treat UserInfo 403 responses as authorization outcomes.
- Revised handling of ID-token verification failures to return corrected error codes.


## [5.64.0] - 2026-09-27

### Added
- Added OAUTH_KEY_SELECTION_FAILED and OAUTH_PARSE_ERROR to AUTHORIZATION_FLOW_CODES.
- Added CSRF protection with constant-time token comparison and signed cookie modes.
- Added absolute session lifetime configuration and validation.
- Added OidcAuthConfig.rotateSessionIdOnRefresh to manage session ID rotation on refresh.

### Changed
- Updated callback returnTo validation to only allow relative same-origin paths; unsafe values are rejected.
- Regenerated ai-training docs and techdocs for improved clarity and accuracy.

### Fixed
- Fixed parsing and selection failures for ID tokens, returning proper flow errors.
- Resolved unsafe returnTo handling and reflected error messages accurately from providers.
- Fixed support for handling UserInfo 403 responses as authorization outcomes.
- Addressed independent review findings to enhance correctness and security.

### Deprecated
- None.

### Removed
- None.


## [5.63.0] - 2026-09-27

- Added OAUTH_KEY_SELECTION_FAILED and OAUTH_PARSE_ERROR to AUTHORIZATION_FLOW_CODES and documented their usage.
- Added CSRF protection middleware and configuration with detailed documentation.
- Added verification of OIDC ID-token signatures by default and session lifetime functionality.
- Added the ability to rotate the OIDC session ID on refresh.
- Added the IntrospectionAuthProvider for validating opaque tokens via RFC 7662 introspection endpoint.
- Changed the handling of oauth exchange and ID-token verification failures to return fixed error responses.
- Changed returnTo guard logic to simplify URL sanitization and validation in callback processing.
- Fixed the callback returnTo validation process and ensured unsafe paths are rejected.
- Fixed handling of various OIDC and UserInfo error conditions to communicate appropriate response codes.
- Fixed OIDC session artifact resolution and error propagation during user authentication.
- Deprecated the previous methods of handling session lifetime and validation throughput configuration. 
- Regenerated documentation for ai-training and updated references based on the latest source changes.


## [5.62.0] - 2026-09-26

### Added
- Add CSRF protection middleware with configurable options.
- Implement IntrospectionAuthProvider for opaque token validation via RFC 7662.
- Add absolute OIDC session lifetime setting in configuration.

### Changed
- Simplified returnTo guard and refined callback re-sanitization.

### Deprecated
- No entries.

### Removed
- No entries.

### Fixed
- Reject unsafe returnTo values and prevent reflecting provider error messages.
- Correctly handle OIDC UserInfo 403 as an authorization outcome.
- Address issues where OIDC code exchange or ID-token verification fails with proper error responses.
- Ensure independent review findings are recorded and addressed.

### Security
- Harden TLS shim against credential header exposure on cross-origin redirects.
- Implement verification of OIDC ID-token signatures by default, improving security.


## [5.61.0] - 2026-09-26

- Added CSRF protection with constant-time compare, safe methods, and exemptions.
- Added optional OIDC transport security with a zero-dependency node:http/https fetch shim.
- Added absolute OIDC session lifetime and validation for session expiry.
- Added user/client discriminator to AuthResult and support for PrincipalType.
- Added support for IntrospectionAuthProvider validating opaque tokens via RFC 7662.
- Added rotation of OIDC session id on refresh with OidcAuthConfig settings.
- Changed the default behavior to verify OIDC ID-token signatures.
- Changed the OIDC auth provider to coalesce refreshes and handle session logic more effectively.
- Fixed propagation of OIDC resolveUser errors to better match infrastructure error expectations.
- Fixed issues causing stale session hanging during redirects by improving TLS shim handling.
- Fixed edge cases in OIDC session-rotation implementation and tests.


## [5.60.0] - 2026-09-26

### Added
- Add opt-in OIDC transport security with `AuthTransportSecurity` and `AuthProviderConfig.transport`.
- Add CSRF protection with `csrfMiddleware/csrfPlugin` supporting constant-time comparison and unsigned double-submit cookie mode.
- Add support for absolute OIDC session lifetime with `sessionAbsoluteTtl`.
- Add verification of OIDC ID-token signatures by default.
- Implement `IntrospectionAuthProvider` for opaque token validation via RFC 7662.

### Changed
- Thread the resolved config through login, callback, refresh, and logout processes.
- Harden TLS shim to strip credential headers on cross-origin redirects.

### Fixed
- Resolve error propagation in the OIDC bearer path to ensure proper error handling.
- Fix to prevent shim hangs by dropping body-header set during redirect rewrites.

### Deprecated
- No entries.

### Removed
- No entries.

### Security
- Add transport security measures that enforce secure HTTP requests and CSRF protections.


## [Unreleased]

### Added

- Add opt-in transport security (`AuthTransportSecurity` via `transport`) for OIDC discovery, JWKS, and token calls, with private-CA trust and a development-only insecure mode.
- Add `OidcAuthConfig.sessionAbsoluteTtl` and `OidcSession.createdAt` to cap total session lifetime independently of refresh activity.
- Add opt-in CSRF protection to the OIDC browser flow (`OidcAuthConfig.csrf`, `OidcSession.csrfToken`, `OidcAuthProvider.getCsrfConfig()`).
- Add a per-request configuration hook (`OidcAuthController.resolveConfig`) and OpenAPI annotations for the five OIDC routes.
- Add `OidcTokens.subject` with the verified ID-token subject from the code exchange.
- Add `OidcAuthConfig.verifyUserInfoSubject` (default `true`), `OidcAuthProvider.shouldVerifyUserInfoSubject()`, and the exported `OidcUserInfoSubjectMismatchError`.
- Coalesce concurrent OIDC refreshes: `OidcAuthProvider.refreshToken()` shares one grant per tenant and token, and `OidcAuthController.handleRefresh()` shares one grant, session store, and rotation per session.
- Add the exported `OidcCodeExchangeError` and `OidcUserInfoForbiddenError` typed flow errors.
- Add `OidcTokens.idTokenClaims` with the verified ID-token claims (present only when the signature was verified and a string `sub` exists).
- Add `OidcAuthConfig.userInfoDenied` (default `'error'`) and `notAuthorizedPath` (default `'/'`) with the `OidcAuthProvider.getUserInfoDeniedMode()` and `getNotAuthorizedPath()` accessors.
- Add `OidcSession.authorized` and `AuthResult.authorized`, exposed by `GET /me`, so an opt-in unauthorized session can be presented or denied by policy.

### Changed

- Verify OIDC ID-token signatures by default (`verifyIdTokenSignature`, default `true`). This is the one intentional behavior change; set `verifyIdTokenSignature: false` to opt out while the `iss`, `aud`, `nonce`, and `exp` checks remain enforced.
- Verify the UserInfo subject against the verified ID-token subject by default (`verifyUserInfoSubject`, default `true`): a mismatch aborts the callback with `400 userinfo_subject_mismatch` and creates no session. Set `verifyUserInfoSubject: false` only for a provider whose UserInfo subject cannot be validated.
- A failed OIDC code exchange or ID-token verification now returns a fixed `400 oidc_exchange_failed` instead of a `500`; network, discovery, and `5xx` failures still surface as server errors.
- A UserInfo `403` now returns a fixed `403 userinfo_forbidden` instead of a `500`. With `userInfoDenied: 'unauthorized-session'`, the callback instead stores a session with `authorized: false`, built only from the verified ID-token identity, and redirects to `notAuthorizedPath`.

### Fixed

- Validate the OIDC post-login redirect target: only a relative, same-origin path is honored, so an absolute, protocol-relative, backslash, control-character, or non-string `returnTo` value now falls back to `/` instead of redirecting off-site.
- The `400 oidc_error` callback response now carries a fixed message and no longer reflects the provider's `error` or `error_description` query text.

## [5.59.0] - 2026-09-17

Changed:
- Bumped lockstep version to 5.58.0 after merging previous changes.
- Updated authz, webafx-authz, and react changelog entries to version 5.58.0.
- Refresh ai-training manifest sdkVersion for consistency.
  
Added:
- Introduced user/client discriminator to AuthResult with optional AuthResult.principalType.
- Added support for sliding session cookies and JWT validation hardening.
- Implemented IntrospectionAuthProvider for validating opaque tokens, with caching and checks.

Fixed:
- Fixed OIDC resolveUser error propagation for asynchronous issues leading to clearer error handling.

Security:
- Enhanced OIDC/JWT validation hardening to mitigate potential security risks.

## [5.57.0] - 2026-09-16

- Added OidcAuthConfig.rotateSessionIdOnRefresh and support for rotating session ID on refresh.
- Added support for IntrospectionAuthProvider for validating opaque tokens via RFC 7662 introspection.
- Added PrincipalType and optional AuthResult.principalType to AuthResult.
- Added principal-discriminator tests for OIDC cases and implementation.
- Changed documentation to clarify the expected behavior of tenant factory caching.
- Changed the assembly export check to list all documented exports.
- Fixed OIDC resolveUser error propagation to ensure proper error handling.
- Fixed issues with handling of OIDC session rotation and added corresponding tests.
- Fixed session cookie handling and improved session validation hardening.


## [5.56.0] - 2026-09-15

- Added PrincipalType and optional AuthResult.principalType to enhance authentication results.
- Added AuthProviderConfig.principalType and a withPrincipalType helper for improved user/client discrimination.
- Added OidcAuthConfig.rotateSessionIdOnRefresh to manage session rotation on refresh events.
- Added sliding session cookies and OIDC/JWT validation hardening features to improve security.
- Added IntrospectionAuthProvider for token validation via RFC 7662 introspection endpoints.
- Changed documentation to clarify factory caching behaviors and widen export checks.
- Changed AI-training templates to remove version metadata and enhance clarity.
- Changed OIDC session handling to propagate errors correctly for failed user resolution.
- Changed structure of the public API surface to align with documented exports accurately.
- Fixed user-friendly error propagation in OIDC resolveUser for better error handling.
- Fixed assertion tests to cover updated public API surfaces and ensure correct implementation.
- Fixed implementation tests and specs for OIDC session rotation and principal discriminator behaviors.
- Removed outdated version metadata from AI-training templates to streamline the documentation.


## [5.55.0] - 2026-09-14

### Added
- Assembled agent skill from regenerated sources with DeepSeek.

### Changed
- Migrated and updated retired MCP hand-written guides and patterns within the AI training documentation.

### Fixed
- Revised content across various AI training documentation files for clarity and accuracy.


## [5.52.0] - 2026-08-29

Changed: Updated package.json to reflect version 5.51.1 and other dependency changes.


## [5.50.0] - 2026-07-31

Added:
- Added OidcAuthProvider and OidcAuthController for BFF authentication.
- Added LinkedIn authentication and refactored the auth package.
- Introduced convenience factories: oidcAuthPlugin, jwtAuthPlugin, memoryAuthPlugin.

Changed:
- Updated TypeScript compatibility and CI configurations.
- Refactored authentication-related classes for modularity and maintainability.
- Updated existing documentation and added new training materials for webafx-auth.

Fixed:
- Fixed issues with token management and session storage.
- Corrected various bugs including authorization checks and method names.
- Improved test coverage and reliability across multiple components in the package.

Removed:
- Removed deprecated methods and optimized existing functionalities for better performance.


## [5.49.0] - 2026-07-31

Added: Added createAuthPlugin, convenience factories, and updated JSDoc for improved documentation support.  
Added: Introduced convenience factories for oidcAuthPlugin, jwtAuthPlugin, and memoryAuthPlugin for easier plugin creation.  
Added: Implemented session and state CRUD operations with configurable TTL in OidcAuthProvider.  
Added: Enhanced OidcAuthProvider with getSessionCookieName and getStateCookieName methods for better cookie management.  
Changed: Refactored OidcAuthController to use dependency injection pattern for provider resolution.  
Changed: Updated test suite to replace DI-based specs for improved coverage and accuracy.  
Fixed: Resolved issues with missing parameters in token handling and improved session management logic.  
Fixed: Corrected various typing errors and improved method implementations throughout the package.  
Fixed: Updated multiple tests to ensure correct functionality in response handling and state management.  
Security: Set secure flag on authentication cookies to enhance session security.


## [5.48.0] - 2026-06-14

## Added
- Added plugin integration exports to allow convenience factories for `oidcAuthPlugin`, `jwtAuthPlugin`, and `memoryAuthPlugin`.
- Introduced `createAuthPlugin` factory and associated types for authentication plugins.
- Added session/state CRUD methods to `OidcAuthProvider`, including configurable TTL and cookie name methods.

## Changed
- Refactored `OidcAuthController` to use dependency injection instead of abstract methods for improved extensibility.
- Updated documentation with complete usage examples for the OIDC auth controllers and providers.

## Fixed
- Addressed multiple test failures and improved coverage for authentication components.
- Revised token handling methods and session management to ensure proper session expiration and handling.
- Corrected caching behavior and added more robust error handling across auth-related modules.

## Removed
- Deprecated abstract methods from `OidcAuthController` to streamline the authentication flow.


## [5.47.0] - 2026-05-22

## Changed
- Marked auth-plugin-refactor plan completion with all 34 tasks done.
- Updated OidcAuthController JSDoc with a complete usage example and refactored to resolve OidcAuthProvider from the DI container.

## Added
- Introduced createAuthPlugin, oidcAuthPlugin, jwtAuthPlugin, and memoryAuthPlugin as convenience factories.
- Added session/state CRUD methods and cookie name methods to OidcAuthProvider.
- Implemented createAuthPlugin factory along with necessary specification and implementation tests.
- Added LinkedIn authentication capabilities to the auth package.

## Fixed
- Added support for asynchronous session store resolution in OidcAuthController.
- Corrected various issues in tests and configuration, including updates for better error handling and enhanced session management.

## Removed
- Eliminated abstract methods from OidcAuthController in accordance with DI-based design changes.


## [5.46.0] - 2026-05-21

## Added
- Support async CacheProvider resolution in `OidcAuthController` by updating `getSessionStore()` return type to `CacheProvider | Promise<CacheProvider>`.
- Introduced dual-mode authentication with Bearer JWT and session cookie fallback in `OidcAuthProvider`.
- Added `parseCookieByName()` function for cookie parsing without cookies-parser dependency.
- Created `OidcAuthController` with comprehensive authentication routes and state management.
- Implemented `MemoryAuthProvider` and `JwtAuthProvider` for enhanced testing scenarios.

## Changed
- Made `getProvider()` and `createProvider()` methods asynchronous in `OidcAuthController`.
- Replaced cookie-based sessions with server-side sessions via `CacheProvider`.

## Fixed
- Addressed various edge cases and errors in `OidcAuthController` and `OidcAuthProvider` with comprehensive test coverage.
- Resolved issues with session cookie naming and UUID uniqueness in session storage.
- Fixed key type handling and ensured correct functionality in `tokenauth`.

## Security
- Implemented secure cookies by default in `session` handling for improved security posture.


## [5.45.0] - 2026-05-21

### Added
- Add server-side session store using CacheProvider for improved session management.
- Introduced dual-mode authentication with Bearer JWT and session cookie fallback.
- Implemented comprehensive tests for OidcAuthController covering various edge cases.

### Changed
- Enhanced OidcAuthController to parse cookies without dependencies on cookie-parser.
- Refined parameter interfaces and methods throughout the auth providers.

### Fixed
- Resolved cookie parsing issues related to session data quality and cache errors.
- Corrected UUID format validation issues in OidcAuthController.

### Deprecated
- Transitioned away from cookie-based session handling in favor of CacheProvider storage solutions.

### Security
- Added secure flag to session cookies to enhance security during authentication.


## [5.44.1] - 2026-05-20

Added: OidcAuthProvider and OidcAuthController for BFF authentication, including JWT validation and cookie session management.  
Added: LinkedIn authentication integration in webafx-auth functionality.  
Changed: Refactored token management for improved performance and maintainability in webafx-auth.  
Changed: Enhanced documentation with multiple training guides and examples for webafx-auth.  
Fixed: Various bugs related to JWT token handling and session storage in webafx-auth.  
Fixed: Updated tests to cover new authentication routes and flows, including LinkedIn integration.  
Fixed: Resolved issues with caching strategies in webafx-auth to improve performance.  
Removed: Deprecated code associated with previous authentication architectures in webafx-auth.  
Security: Added secure cookie flags to session management in webafx-auth to improve security standards.


## [5.44.0] - 2026-05-20

### Added
- Add OidcAuthProvider and OidcAuthController for BFF authentication.
- Add MemoryAuthProvider and JwtAuthProvider with tests.
- Implement LinkedIn authentication in webafx-auth-linkedin.

### Changed
- Refactor auth package to improve readability and structure.
- Update ai-training documentation for webafx-auth to include new features and best practices.

### Fixed
- Fix typo in session management implementation.
- Fix session storage mechanism and add ttl for cookies.
- Fix authorization routes in oauth implementation.
- Fix incorrect handling of client session key in auth.

### Removed
- Remove deprecated code and unused packages from the project.


## [5.43.1] - 2026-05-20

### Added
- Add OidcAuthProvider and OidcAuthController for BFF authentication with cookie-based session management.
- Implement MemoryAuthProvider and JwtAuthProvider with tests.
- Add LinkedIn authentication in the webafx-auth-linkedin package.

### Changed
- Updated documentation and ai-training guides for webafx-auth.
- Introduced new modular structure for webafx-auth, refactoring existing authentication methods.

### Fixed
- Fixed various issues in session handling and type errors in the auth package.
- Resolved bugs related to request handling in the OAuth implementation.
- Refactored auth methods to improve their modularity and maintainability.

### Removed
- Deprecated and unused methods and properties to streamline the authentication process.


## [5.43.0] - 2026-05-19

### Added  
- Added OidcAuthProvider and OidcAuthController for BFF authentication, including cookie-based session management and token retrieval.  
- Implemented MemoryAuthProvider and JwtAuthProvider, providing essential mock and JWT capabilities.  
- Introduced OidcSessionState and OidcSession interfaces for enhanced OIDC handling.  
- Added documentation for ai-training, core concepts, usage, and advanced patterns in the webafx-auth package.  
- Created a parameter interface in webafx-auth for authorization management.  

### Changed  
- Refactored token handling, implementing async behavior and improving session state management.  
- Updated session storage mechanisms for better performance and management.  
- Enhanced createRequestContextGetUserMethod to support async operations and accommodate new request flows.  

### Fixed  
- Fixed various bugs related to token validation and session management in webafx-auth.  
- Resolved issues with HTTP request handling, including parameter processing for non-GET requests.  
- Corrected type and interface definitions throughout the codebase for improved type safety.  

### Removed  
- Deleted deprecated or unnecessary methods from the authentication flow in webafx-auth.


## [5.42.0] - 2026-05-18

### Added
- Add OidcAuthProvider and OidcAuthController for BFF authentication including cookie-based session management.
- Implement OidcAuthProvider with OIDC discovery and BFF methods.
- Introduced MemoryAuthProvider and JwtAuthProvider with corresponding tests.
- Added AI training documentation covering usage and best practices.

### Changed
- Implemented public mirror infrastructure for package configuration and publication.
- Refactored various auth methods for improved modularity and readability.

### Fixed
- Added explicit session extender for better session management.
- Fixed various typos and inconsistencies across the codebase.
- Updated session storage management to include new parameters and enhanced security features.

### Deprecated
- Deprecated previous styles of cookie management across the application.

### Removed
- Removed old, unused packages to clean up the project.


## [5.41.0] - 2026-05-17

### Added
- Implemented MemoryAuthProvider and JwtAuthProvider with associated tests.
- Consolidated all '@blendsdk/*' packages into a single 'blendsdk' npm package with subpath exports.
- Added comprehensive ai-training documentation with multiple structured documents.
- Added LinkedIn authentication feature in webafx-auth-linkedin package.

### Changed
- Refactored webafx-auth to improve modularity and maintainability.

### Fixed
- Fixed various issues including missing parameters, incorrect session handling, and improved error handling and response formats.
- Renamed methods and fixed typos throughout the codebase.
- Updated session storage and authentication cookie configurations.

### Removed
- Deprecated and unnecessary code has been removed from the codebase for clarity and efficiency.


## [5.40.0] - 2026-05-17

### Added
- Implemented MemoryAuthProvider and JwtAuthProvider with tests for authentication scenarios.
- Created comprehensive ai-training documentation covering core concepts, best practices, and troubleshooting.

### Changed
- Consolidated all 12 @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.

### Fixed
- Refactored token and authentication methods for improved clarity and performance.
- Fixed oauth routes and added missing error type checks.
- Adjusted session storage handling to include cache key and TTL.
- Updated logging facilities to improve target logging outputs.

### Security
- Set auth cookie secure flag to prevent potential security vulnerabilities.


## [5.39.0] - 2026-05-07

Added:
- Implemented MemoryAuthProvider and JwtAuthProvider with corresponding tests.
- Added ai-training documentation with various subjects regarding usage and best practices for authentication.

Changed:
- Consolidated all @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.
- Updated the root package.json repository URL to point to the new GitHub location.

Fixed:
- Added support for extracting parameters from non-GET requests in HttpRequest.
- Renamed method to correct a typo in the token management module.
- Resolved issues with missing exports and improved type safety across multiple files.


## [5.38.0] - 2026-04-13

### Added
- Implemented MemoryAuthProvider and JwtAuthProvider with tests to enhance authentication options.
- Added ai-training documentation for webafx-auth, including core concepts, usage patterns, and best practices.

### Changed
- Refactored the token handling in webafx-auth for better modularity and organization.

### Fixed
- Fixed various issues related to session management and token handling in webafx-auth.
- Added secure cookie settings and adjusted session token parameters to improve security.
- Updated multiple test cases to ensure accuracy and comprehensive coverage.

### Removed
- Removed outdated and unused abstract methods from the webafx-auth authentication classes.


## [5.37.0] - 2026-03-23

### Added
- Implemented MemoryAuthProvider and JwtAuthProvider with tests for improved authentication options.
- Added AI training documentation with structured guides and best practices.

### Changed
- Consolidated all @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.
- Updated the API reference and examples within the AI training documentation.

### Fixed
- Fixed bugs related to token expiration and JWT verification in authentication process.
- Adjusted caching mechanisms in the auth library to improve performance.
- Resolved issues with session storage updates and cookie parameters.

### Security
- Set the secure flag for cookies in the authentication library to enhance security.


## [5.36.0] - 2026-03-23

- Added: ai-training documentation with structured content including core concepts, usage patterns, and best practices.
- Added: MemoryAuthProvider and JwtAuthProvider implementations with associated tests.
- Changed: Implemented single-package distribution for @blendsdk/* packages into a consolidated 'blendsdk' npm package.
- Fixed: Token handling methods, including added caching and security options for authentication.
- Fixed: Renamed abstract methods and improved type definitions across the package.
- Fixed: Addressed various bugs relating to session management and response formatting, including JWT handling.


## [5.35.0] - 2026-03-20

### Added
- Implemented single-package distribution consolidating 12 @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.
- Introduced MemoryAuthProvider and JwtAuthProvider, including tests for both providers.
- Created basic auth test in `webafx-auth`.
- Added the `ttl` option to session storage in `webafx-auth`.
- Added cache functionality to the authentication process.
- Added LinkedIn authentication and refactored the auth package.

### Changed
- Updated `package.json` files across multiple packages to reflect version changes and new features.

### Fixed
- Re-introduced and refactored the tokenExpireAt functionality.
- Added missing error type checks in `HttpRequest`.
- Fixed typo issues in various files within `webafx-auth`.
- Updated the session storage to be compatible with recent changes.
- Fixed oauth routes in `webafx-auth`.
- Modified authentication methods to allow client-side redirection.

### Deprecated
- Removed old authentication methods and related code segments to streamline the export and usage of `webafx-auth`.

### Removed
- Deleted old packages and imports that were no longer necessary.
