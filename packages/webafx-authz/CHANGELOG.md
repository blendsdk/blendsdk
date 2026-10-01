# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [5.65.0] - 2026-09-27

Added:
- Add the route guards, identity helpers, and translator plugin including requireAccess and requireScopes functions.
- Scaffold the server authorization package with manifest and TypeScript configuration.
- Add identity and access-guard implementation tests covering various token scenarios.

Changed:
- Treat a principal whose claims are not an object as empty instead of throwing an error.
- Updated tests to cover malformed, blank, and structurally invalid tokens.

Fixed:
- Harden the guards and document the grant trust boundary, requiring that default selector's claims must hold server-written canonical grants.
- Ensure that the scopes list is filtered to strings to prevent errors.


## [5.64.0] - 2026-09-27

Added:
- Added route guards, identity helpers, and a translator plugin to enhance access control.
- Introduced `requireAccess`, which fails closed on an empty principal without throwing.
- Introduced `requireScopes` for ensuring proper scope validation.
- Added null-claims scope case to return a 403 error instead of throwing.

Changed:
- Updated the guards to harden their security and document the grant trust boundary.
- Enhanced test coverage for access-guard and identity implementations, including various edge cases.

Fixed:
- Resolved an issue where a principal with non-object claims was improperly handled; now treated as empty.
- Corrected behavior to filter scope lists to only include strings and handle malformed tokens appropriately.


## [5.63.0] - 2026-09-27

Added:
- Add the principal selector and the default claims.roles/claims.permissions selector.
- Add requireAccess, which fails closed on an empty principal.
- Add requireScopes, which requires valid claims for access verification.
- Add the route guards, identity helpers, and translator plugin.
- Add identity spec tests: token decoding, user-info passthrough, scope splitting.
- Add access-guard spec tests: allow, forbid, anonymous, unsecured authorize, custom selector.

Changed:
- State that the default selector's claims must hold server-written canonical grants.
- Treat a principal whose claims are not an object as empty instead of throwing.
- Refresh the ai-training manifest sdkVersion and content.

Fixed:
- Harden the guards and document the grant trust boundary.
- Use a null claims object in the selector regression test so it fails before the guard.
- Add a null-claims scope case that must answer 403 rather than throw.


## [5.62.0] - 2026-09-26

Added: Add the route guards, identity helpers, and translator plugin.  
Added: Add requireAccess, which fails closed on an empty principal and never throws.  
Added: Add requireScopes, which requires...  
Changed: Treat a principal whose claims are not an object as empty instead of throwing.  
Changed: Filter the scopes list to strings.  
Fixed: Harden the guards and document the grant trust boundary.  
Fixed: Use a null claims object in the selector regression test so it fails before the guard.  
Test: Cover malformed, blank, and structurally invalid tokens in access-guard spec tests.  
Test: Add the identity and access-guard implementation tests.  
Test: Add identity spec tests: token decoding, user-info passthrough, scope splitting.  
Chore: Scaffold the server authorization package with necessary configurations.


## [5.61.0] - 2026-09-26

Added:
- Add route guards, identity helpers, and translator plugin for enhanced authorization management.
- Introduce `requireAccess` and `requireScopes` functions to streamline access control.

Changed:
- Update TypeScript configurations and documentation for improved developer experience.
- Refactor guards to accept null claims and enhance error handling.

Fixed:
- Harden guards and clarify grant trust boundary documentation to prevent misconfiguration.
- Adjust behavior to treat non-object claims as empty, avoiding exceptions.

Deprecated:
- Deprecated legacy access control mechanisms in favor of new guard implementations.


## [5.60.0] - 2026-09-26

### Added
- Add the route guards, identity helpers, and translator plugin, including requireAccess and requireScopes.
- Scaffold the server authorization package with manifest and TypeScript configuration.

### Changed
- Bump every workspace and the root package to version 5.57.0.

### Fixed
- Harden guards and document the grant trust boundary, treating non-object claims as empty instead of throwing.
- Add tests for identity and access-guard implementations covering various edge cases.

### Security
- Implement the fail-closed mechanism in requireAccess, ensuring it fails without throwing in case of an empty principal.


## [5.59.0] - 2026-09-17

Changed: Bump the lockstep version to 5.58.0 after merging v5, which released 5.57.0.  
Added: Introduce route guards, identity helpers, and translator plugin, including principal selector and new methods for access and scopes verification.  
Fixed: Harden the guards to better handle claims and documented the grant trust boundary.  
Test: Add comprehensive tests for identity, access guards, scopes, and error handling scenarios.  
Chore: Scaffold the server authorization package with dependencies and configuration for the workspace.


## [5.58.0] - 2026-09-17

### Added

- WebAFX route guards `requireAccess` and `requireScopes`, returning the existing `AuthorizeFunction` shape.
- Identity helpers `decodeJwtClaims` and `buildProviderIdentity` for decoding provider tokens.
- `createClaimsTranslatorPlugin` and `CLAIMS_TRANSLATOR_SERVICE` for registering a claims translator as a singleton service.
- `defaultPrincipalSelector` and the `PrincipalSelector` contract for reading canonical grants.
