# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [5.65.0] - 2026-09-27

## Added
- Add claim profiles and the package entry point with userInfo/idToken/accessToken precedence.
- Add grant translation with an explicit allowlist, including map-first grants.
- Add the authorization evaluator with hasRole and hasPermission functionalities.
- Add the isOneOf value guard to accept only strings in the application-owned list.
- Define the authorization vocabulary types including Role, Permission, and AccessPrincipal.

## Changed
- Refresh the ai-training manifest sdkVersion for better documentation clarity.
- Update authorization examples to fix incorrect usage of requirement prop.
- Improve the generation of ai-training documentation for clarity and accessibility.

## Fixed
- Harden grant translation against malformed map entries to improve error handling.
- Ignore invalid mapped entries that are not non-null objects instead of throwing errors.

## Deprecated
- None

## Removed
- None

## Security
- None


## [5.64.0] - 2026-09-27

### Added
- Add claim profiles and the package entry point with Azure claim precedence.
- Add grant translation with an explicit allowlist and mapping features.
- Add the authorization evaluator with role and permission checks.
- Add the isOneOf value guard for application-owned string lists.
- Define the authorization vocabulary types including Role and Permission.

### Changed
- Refresh the ai-training manifest sdkVersion.
- Correct generated authorization examples for the <RequireAccess> component.
- Update documentations and reflect feature review findings across multiple phases.

### Fixed
- Harden grant translation against malformed map entries by requiring arrays.
- Implement tests for claim profiles and evaluation, confirming all corresponding specs pass.

### Security
- No security vulnerabilities were noted in this release.


## [5.63.0] - 2026-09-27

### Added
- Add claim profiles and the package entry point with userInfo/idToken/accessToken precedence.
- Add grant translation with an explicit allowlist including grantKey and resolveGrants.
- Add the authorization evaluator with hasRole and hasPermission functions.
- Define the authorization vocabulary types, including Role, Permission, and AccessRequirement.
- Add the isOneOf value guard to restrict values to a predefined list.

### Changed
- Refresh the ai-training manifest sdkVersion.
- Improve the documentation of authorization examples to use the requirement prop.
- Update the authorization feature's roadmap documents to reflect completion.

### Fixed
- Harden grant translation against malformed map entries by requiring an array for mapped values.
- Fix invalid example imports in the generated webafx-authz and react docs.

### Security
- No security-related changes have been made in this release.


## [5.62.0] - 2026-09-26

- Added generic and Azure claim profiles with userInfo/idToken/accessToken precedence.
- Added grantKey and resolveGrants with map-first grants and canonical allowlist.
- Added hasRole and hasPermission against a principal in the authorization evaluator.
- Added the isOneOf value guard, accepting only strings present in the application-owned list.
- Defined the authorization vocabulary types, including Role, Permission, and AccessPrincipal.
- Hardened grant translation against malformed map entries.
- Fixed <RequireAccess> examples to use the requirement prop and corrected the generated authorization examples. 
- Marked the authz feature as done following the phase six review with no findings. 
- Verified end-to-end functionality and confirmed all tests for the authz suite passed with no type errors.


## [5.61.0] - 2026-09-26

### Added
- Add claim profiles and the package entry point, supporting userInfo/idToken/accessToken precedence.
- Add grant translation with an explicit allowlist, including map-first grants and canonical allowlist features.
- Add the authorization evaluator with hasRole and hasPermission functionality.
- Add the isOneOf value guard to restrict values to the application-owned list.
- Define the authorization vocabulary types including Role, Permission, and AccessPrincipal.

### Changed
- Read the principal through the WebAFX service container instead of req.principal.
- Update generated authorization examples to use the requirement prop for <RequireAccess>.

### Fixed
- Harden grant translation against malformed map entries by requiring an array before appending mapped values.
- Ignore non-null object mapped entries instead of throwing errors during grant translation.

### Security
- No security vulnerabilities identified in this release.


## [5.60.0] - 2026-09-26

Added:
- Add generic and Azure claim profiles with userInfo/idToken/accessToken precedence.
- Add grant translation with an explicit allowlist and resolveGrants functionality.
- Add the authorization evaluator with hasRole and hasPermission features.
- Add the isOneOf value guard to restrict values to a predefined list.
- Define the authorization vocabulary types including Role, Permission, AccessPrincipal, etc.

Changed:
- Update documentation to record the phase six review verdict and mark the feature complete.

Fixed:
- Harden grant translation against malformed map entries to prevent iteration over non-arrays.
- Correct invalid example imports in generated documentation for webafx-authz and react.

Security:
- No security vulnerabilities addressed in this release.


## [5.59.0] - 2026-09-17

Added:
- Add claim profiles and the package entry point with userInfo/idToken/accessToken precedence.
- Add grant translation with an explicit allowlist, including grantKey and resolveGrants.
- Add the authorization evaluator with hasRole and hasPermission features.
- Add the isOneOf value guard to only accept application-owned strings.
- Define the authorization vocabulary types: Role, Permission, AccessPrincipal, AccessMode, AccessRequirement, and AllowedGrants.

Changed:
- Update the lockstep version to 5.58.0 after merging the previous version.
- Mark the authz feature as Done and sync the portfolio roadmap.
- Refresh the ai-training manifest sdkVersion and correct generated documents.

Fixed:
- Harden grant translation against malformed map entries to ensure stable operation.
- Fix invalid example imports in generated webafx-authz and react docs.

Deprecated:
- N/A

Removed:
- N/A

Security:
- N/A


## [5.58.0] - 2026-09-17

### Added

- Provider-agnostic authorization vocabulary: `Role`, `Permission`, `AccessPrincipal`, `AccessRequirement`, `AllowedGrants`, and the profile and translator contracts.
- Evaluation helpers `hasRole`, `hasPermission`, and `satisfiesAccess`, plus the `isOneOf` guard.
- Claim translation through `createClaimsTranslator`, `resolveGrants`, and `grantKey`, with the generic OIDC and Azure Entra profiles.
