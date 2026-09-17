# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [5.58.0] - 2026-09-17

### Added

- WebAFX route guards `requireAccess` and `requireScopes`, returning the existing `AuthorizeFunction` shape.
- Identity helpers `decodeJwtClaims` and `buildProviderIdentity` for decoding provider tokens.
- `createClaimsTranslatorPlugin` and `CLAIMS_TRANSLATOR_SERVICE` for registering a claims translator as a singleton service.
- `defaultPrincipalSelector` and the `PrincipalSelector` contract for reading canonical grants.
