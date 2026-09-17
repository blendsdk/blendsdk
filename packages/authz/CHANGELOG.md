# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [5.58.0] - 2026-09-17

### Added

- Provider-agnostic authorization vocabulary: `Role`, `Permission`, `AccessPrincipal`, `AccessRequirement`, `AllowedGrants`, and the profile and translator contracts.
- Evaluation helpers `hasRole`, `hasPermission`, and `satisfiesAccess`, plus the `isOneOf` guard.
- Claim translation through `createClaimsTranslator`, `resolveGrants`, and `grantKey`, with the generic OIDC and Azure Entra profiles.
