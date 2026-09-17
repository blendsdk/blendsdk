# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
