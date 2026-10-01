# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [5.65.0] - 2026-09-27

Added:

- Generate versionless ai-training and skill references by dropping version metadata from templates.

Changed:

- Refresh the ai-training manifest sdkVersion.
- Sanitize the injected package.json context and removed unnecessary references.

Deprecated:

- Retired blendsdk-mcp documentation server based on the new agent skill implementation.

Removed:

- Removed references to the blendsdk-mcp documentation server in various files.

Fixed:

- Assembled agent skill from regenerated sources and migrated retired MCP guides and patterns.

## [5.64.0] - 2026-09-27

Changed: Refresh the ai-training manifest sdkVersion and remove deprecated version metadata from templates.  
Changed: Sanitize the injected package.json context by removing the reference header injection.  
Removed: Retired the blendsdk-mcp documentation server, updating relevant documentation references.  
Added: Generate versionless ai-training and skill references in newly assembled agent skill.  
Fixed: Migrated retired MCP hand-written guides and patterns into environment documentation.

## [5.63.0] - 2026-09-27

Added:

- Generate versionless ai-training and skill references by dropping version metadata from templates.

Changed:

- Sanitize injected package.json context by removing reference header injection.
- Assemble agent skill from regenerated sources, migrating retired MCP hand-written guides.

Removed:

- Retired the blendsdk-mcp documentation server and updated distribution references accordingly.

## [5.62.0] - 2026-09-26

Added:

- Generate versionless ai-training and skill references by dropping version metadata from ai-training templates.

Changed:

- Sanitize the injected package.json context by removing reference header injections.
- Regenerate all ai-training sources and assemble the agent skill with updated patterns and guides.

Removed:

- Retired the blendsdk-mcp documentation server, updating distribution references accordingly.

## [5.61.0] - 2026-09-26

Added:

- Generate versionless ai-training and skill references by dropping the version metadata line from ai-training templates.

Changed:

- Sanitize the injected package.json context by removing reference header injection.
- Regenerate and assemble all ai-training sources with DeepSeek, migrating MCP guides and patterns.

Deprecated:

- Retired the blendsdk-mcp documentation server; updated references for documentation changes.

Removed:

- Package for the blendsdk-mcp documentation server is deleted following the transition to the agent skill.

Fixed:

- Various updates to the changelog and package.json files to reflect accurate versioning across multiple packages.

## [5.60.0] - 2026-09-26

Added:

- Generate versionless ai-training and skill references by dropping version metadata from templates.

Changed:

- Refreshed the ai-training manifest sdkVersion for consistency.
- Assembled agent skill from regenerated sources with updated patterns and guides.

Deprecated:

- Retired the blendsdk-mcp documentation server, replacing it with the agent skill references.

Removed:

- Removed blendsdk-mcp documentation server references from various project files.

Fixed:

- Sanitized injected package.json context to enhance security and clarity.

## [5.59.0] - 2026-09-17

Added:

- Generate versionless ai-training and skill references by dropping version metadata from ai-training templates.

Changed:

- Bump the lockstep version to 5.58.0 after merging v5.
- Moved authz, webafx-authz, and react changelog entries to 5.58.0.
- Refresh the ai-training manifest sdkVersion.
- Retired MCP documentation server and updated blendscript distribution references.

Removed:

- Retired the blendsdk-mcp documentation server and associated references.

Fixed:

- Assembled agent skill from regenerated sources with DeepSeek and migrated documentation from retired guides.

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
- Add structured record diagnostic metadata (`reason`, `expectedType`, `nullable`, `actualType`) that never includes the rejected value.

## Changed

- Record diagnostics now expose enumerable structured members. Consumers comparing a complete diagnostic object for equality must update their expectations; partial-match checks keep working.

## [5.53.0] - 2026-09-02

## Added

- Add business expression language with CSP-safe validation, compilation, and evaluation.

## Changed

- Expose BlendScript through the umbrella package with user and integration documentation.
