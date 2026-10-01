# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [5.65.0] - 2026-09-27

Added:
- Add the typed HTTP client runtime including fetch transport and various auth strategies.
- Add CookieSession, Bearer, ApiKey, and OIDC client-credentials authentication strategies.
- Add ApiError and ApiTransport to enhance error handling capabilities.

Changed:
- Set the JSON content type for writes to ensure server keeps request body.
- Hardened authentication and header management by merging headers case-insensitively and widening body parameters.

Fixed:
- Preserve JSDoc import examples during assembly by skipping comment lines.
- Redact non-Error causes instead of passing complex objects; improve tests for redaction.
- Corrected the constructor and prototype handling in the SDK.

Deprecated:

Removed:


## [5.64.0] - 2026-09-27

### Added
- Add the typed HTTP client runtime with fetch transport, URL/body building, and envelope unwrapping.
- Implement auth strategies: CookieSession, Bearer, ApiKey, and OIDC client-credentials.
- Introduce ApiError and ApiTransport classes for improved error handling.

### Changed
- Refresh the AI training manifest sdkVersion.

### Fixed
- Preserve JSDoc import examples during assembly by skipping comment lines when rewriting.
- Harden the single-Zod guard, ensuring no second resolution can pass unnoticed.
- Set the JSON content type for write operations to ensure body persistence.
- Redact non-Error causes instead of passing them unprocessed; align auth guard documentation.


## [5.63.0] - 2026-09-27

Added:
- Add typed HTTP client runtime with fetch transport and multiple auth strategies.

Changed:
- Integrate generated client into the playground and compiler; add integration tests.

Fixed:
- Preserve JSDoc import examples and improve auth handling and redaction.
- Set JSON content type for requests and enhance header management.


## [5.62.0] - 2026-09-26

Added:
- Integrate the generated client into the playground and umbrella with auth strategies: CookieSession, Bearer, ApiKey, and OIDC client-credentials.
- Introduced the typed HTTP client runtime with fetch transport, URL/body building, and envelope unwrapping.

Changed:
- Enhanced the documentation for the runtime and client-SDK, including new templates and playbooks.

Fixed:
- Preserved JSDoc import examples during assembly by skipping comment lines.
- Hardened the single-Zod guard and improved generated naming to prevent resolution issues.
- Set the JSON content type correctly for writes to ensure server compliance.
- Redacted non-Error causes in API responses and aligned documentation for auth guards and redaction strategies.


## [5.61.0] - 2026-09-26

### Added  
- Integrate the generated client into the playground and umbrella, including a fetch transport, URL/body building, and envelope unwrapping.  
- Add CookieSession, Bearer, ApiKey, and OIDC client-credentials auth strategies.  
- Add ApiError/ApiTransport for enhanced error handling.  

### Changed  
- Refresh the ai-training manifest sdkVersion.  
- Document the runtime and add the client-SDK skill route.  
- Fix template dependencies and doc counts by adding cors, cookie-parser, and helmet to the client-SDK template, and align zod to ^4.4.3.  

### Fixed  
- Preserve JSDoc import examples during assembly by skipping comment lines when rewriting.  
- Harden the single-Zod guard and generated naming to prevent misconfigurations.  
- Set the JSON content type for writes to ensure server compatibility.  
- Redact non-Error causes, adding tests for details, requestId, causes, JWTs, and query keys.


## [5.60.0] - 2026-09-26

### Added
- Integrate the generated client into the playground and umbrella with a new fetch transport.
- Add authentication strategies: CookieSession, Bearer, ApiKey, and OIDC client-credentials.

### Changed
- Refresh the ai-training manifest SDK version.
- Update template dependencies by aligning zod to ^4.4.3 and adding cors, cookie-parser, and helmet to the client-SDK template.

### Fixed
- Preserve JSDoc import examples during assembly by skipping comment lines in import specifiers.
- Harden the single-Zod guard and generated naming to prevent resolution issues.
- Set the JSON content type for writes to ensure the server keeps the body.
- Redact non-Error causes and align documentation on the auth guard.


## [5.59.0] - 2026-09-17

Added:
- Add typed HTTP client runtime with fetch transport, URL/body building, and envelope unwrapping.
- Include CookieSession, Bearer, ApiKey, and OIDC client-credentials auth strategies.
- Introduce ApiError and ApiTransport components.

Changed:
- Bump the lockstep version to 5.58.0 after merging v5.
- Refresh the ai-training manifest SDK version.

Fixed:
- Preserve JSDoc import examples during assembly by skipping comment lines.
- Harden the single-Zod guard and improve generated naming.
- Set JSON content type for writes to ensure server retains the body.
- Redact non-Error causes and align auth guard documentation.

Deprecated:
- None

Removed:
- None

Security:
- None


## [5.57.0] - 2026-09-16

Added:
- Introduced the typed HTTP client runtime with fetch transport, URL/body building, and envelope unwrapping.
- Added new authentication strategies: CookieSession, Bearer, ApiKey, and OIDC client-credentials.

Changed:
- Updated the API client template to include cors, cookie-parser, and helmet.
- Adjusted the examples count in the runtime README for accuracy.

Fixed:
- Preserved JSDoc import examples during assembly by skipping comment lines.
- Redacted non-Error causes to enhance confidentiality and aligned auth guard documentation.
- Set JSON content type for requests to ensure the server properly processes the body.

Deprecated:
- No deprecated features noted in this release.

Removed:
- No features were removed in this release.

Security:
- Hardened auth methods, headers, and redaction processes to improve security measures.
