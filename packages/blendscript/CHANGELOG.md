# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [5.57.0] - 2026-09-16

- Added: Generate versionless AI-training and skill references.
- Changed: Removed version metadata line and {{version}} prompt variable from AI-training templates.
- Changed: Retired blendsdk-mcp documentation server; updated references and consolidated documentation.
- Changed: Assembled agent skill from regenerated sources; migrated MCP guides into updated structure.
- Removed: Deleted blendsdk-mcp package and related documentation files.


## [5.56.0] - 2026-09-15

Added:
- Generate versionless AI training and skill references by removing version metadata from AI training templates.

Changed:
- Sanitize the injected `package.json` context by removing the reference header injection.
- Regenerated all AI training sources using DeepSeek and assembled the agent skill with updated guides and patterns.

Deprecated:
- Retire the blendsdk-mcp documentation server, replaced by the agent skill documentation.

Removed:
- The blendsdk-mcp documentation server package and associated references.

Fixed:
- Improved organization and clarity in various AI training documents concerning concepts, usage, and testing patterns.


## [5.55.0] - 2026-09-14

Changed:
- Retired the blendsdk-mcp documentation server; references updated to use the new agent skill.

Added:
- Assembled agent skill from regenerated sources; migrated content from retired MCP guides and patterns.

Fixed:
- Updated documentation for core concepts, usage, best practices, and examples in ai-training materials.


## [5.54.0] - 2026-09-03

## Added
- Support for mixed scalar fields that retain strings or finite numbers.

## Changed
- Added explicit `tryNumber` and text conversions without implicit coercion.  
- Preserved compatibility, diagnostics, limits, and distribution types.


## [Unreleased]

## Added

- Add string-or-finite-number scalar fields with explicit `tryNumber` and `text` conversions.

## [5.53.0] - 2026-09-02

## Added

- Add business expression language with CSP-safe validation, compilation, and evaluation.

## Changed

- Expose BlendScript through the umbrella package with user and integration documentation.
