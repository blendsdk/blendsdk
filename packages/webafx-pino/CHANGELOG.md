# @blendsdk/webafx-pino

## 5.37.0

### Features

- Initial release of structured logging plugin for WebAFX with Pino
- `PinoLoggerProvider` — adapts pino behind the BlendSDK Logger interface
- `LoggerProvider` — abstract base class for logger providers
- `pinoLoggerPlugin()` — one-liner convenience for WebAFX plugin registration
- `createLoggerPlugin()` — two-step factory for advanced use cases
- Request-scoped `req.log` middleware with automatic requestId binding
- Log level normalization (uppercase/lowercase auto-mapping)
- Header redaction (authorization, cookie) by default
- Pretty-printing support via optional `pino-pretty` peer dependency
- Health check and graceful shutdown lifecycle hooks
- Service container registration as singleton service


## [5.65.0] - 2026-09-27

Changed: Bumped package versions to 5.64.0, 5.63.0, 5.62.0, 5.61.0, 5.60.0, 5.59.0, 5.58.0, and 5.57.0 across all workspaces.  
Added: Generated versionless ai-training and skill references, dropping version metadata from ai-training templates.  
Added: Assembled agent skill from regenerated sources, including 176 ai-training sources with enhanced capabilities.  
Fixed: Sanitized injected package.json context by removing header injection.


## [5.64.0] - 2026-09-27

Changed: Updated ai-training documentation for enhanced clarity across all sections.  
Added: Introduced versionless ai-training and skill references to streamline user experience.  
Fixed: Sanitized injected package.json context, removing unnecessary reference headers.


## [5.63.0] - 2026-09-27

Added:
  - Generate versionless ai-training and skill references by dropping version metadata from templates.

Changed:
  - Updated ai-training documentation for core concepts, usage, advanced patterns, best practices, common scenarios, testing patterns, troubleshooting, and API reference.

Fixed:
  - Sanitized injected package.json context by removing unwanted reference headers.


## [5.62.0] - 2026-09-26

Changed:
- Updated changelog entries for various packages including api-client, authz, and blendsdk.
- Refreshed ai-training documentation with better organization and updated content.

Added:
- Introduced versionless ai-training and skill references by removing version metadata from templates.

Fixed:
- Sanitized injected package.json context to improve documentation clarity and reduce redundancy.


## [5.61.0] - 2026-09-26

Added:
- Generate versionless ai-training and skill references by dropping version metadata from templates.
- Assemble agent skill from regenerated sources using DeepSeek, including migration of retired MCP guides.

Changed:
- Sanitize injected package.json context by removing header injection.

Fixed:
- Refresh the ai-training manifest sdkVersion to ensure compatibility.


## [5.60.0] - 2026-09-26

Added:
- Generate versionless ai-training and skill references by dropping the version metadata line from 11 ai-training templates.

Changed:
- Bump all workspaces and the root package to version 5.57.0 for consistency.
- Updated the ai-training manifest's sdkVersion for compatibility.

Fixed:
- Sanitize the injected package.json context to improve accuracy in documentation.


## [5.59.0] - 2026-09-17

Changed:
- Bumped the lockstep version to 5.58.0, re-bumping after merging v5.
- Moved authz, webafx-authz, and react changelog entries to 5.58.0.
- Updated the ai-training manifest SDK version.
- Bumped all workspaces and the root package to 5.57.0.
- Bumped the lockstep version to 5.57.0.
- Bumped the lockstep version to 5.56.0.

Added:
- Generated versionless ai-training and skill references by removing version metadata from templates.
- Assembled agent skill from regenerated sources with 176 ai-training sources.

Fixed:
- Sanitized injected package.json context, removing reference header injection.


## [5.57.0] - 2026-09-16

Added:
- Generated versionless AI-training and skill references by removing version metadata from templates.

Changed:
- Regenerated all AI-training sources with DeepSeek and constructed the agent skill, enhancing existing assets and references.

Fixed:
- Sanitized injected package.json context by removing reference header injections.


## [5.56.0] - 2026-09-15

## Added
- Generate versionless AI-training and skill references by dropping version metadata from templates and prompts.

## Changed
- Sanitize injected package.json context by removing reference header injection.
- Regenerated all AI-training sources with DeepSeek and assembled the agent skill.

## Deprecated
- Retired MCP hand-written guides, patterns, and templates in favor of regenerated sources.

## Fixed
- Improved overall consistency and clarity in AI-training documentation.


## [5.55.0] - 2026-09-14

### Added
- Assembled agent skill from regenerated sources using DeepSeek.

### Changed
- Migrated MCP hand-written guides and patterns to new templates and references.
- Updated multiple AI training documentation files for clarity and content improvements.


## [5.52.0] - 2026-08-29

Changed: Updated package.json for improved dependency management and version alignment.


## [5.50.0] - 2026-07-31

Added: New package: @blendsdk/webafx-pino — wraps Pino behind WebAFX Logger interface  
Changed: Updated TypeScript compatibility and adjusted compiler requirements in workspace dev dependencies  
Changed: Refreshed external dependencies and updated Yarn lockfile across all workspaces  
Fixed: Fixed the package versions in the @blendsdk/webafx-pino package


## [5.49.0] - 2026-07-31

## Added
- New package: @blendsdk/webafx-pino — wraps Pino behind WebAFX Logger interface.

## Changed
- Updated documentation and examples for structured logging with WebAFX.

## Fixed
- Fixed the package versions for @blendsdk/webafx-pino.


## [5.48.0] - 2026-06-14

Added: New package: @blendsdk/webafx-pino — wraps Pino behind WebAFX Logger interface  
Changed: Updated package versions for alignment  
Fixed: Fixed the package versions


## [5.47.0] - 2026-05-22

Added: New package: @blendsdk/webafx-pino — wraps Pino behind WebAFX Logger interface  
Changed: Updated package versions for better compatibility  
Fixed: Fixed the package versions for @blendsdk/webafx-pino


## [5.46.0] - 2026-05-21

## Added
- New package: @blendsdk/webafx-pino — wraps Pino behind WebAFX Logger interface.

## Changed
- Updated package metadata and documentation across multiple packages.

## Fixed
- Fixed the package versions for consistency.


## [5.45.0] - 2026-05-21

### Added
- New package: @blendsdk/webafx-pino — wraps Pino behind WebAFX Logger interface.

### Changed
- Updated package versions.

### Fixed
- Fixed the package versions in `@blendsdk/webafx-pino/package.json`.


## [5.44.1] - 2026-05-20

### Added
- New package: @blendsdk/webafx-pino — wraps Pino behind WebAFX Logger interface.

### Changed
- Updated logging architecture to include LoggerProvider abstract class and PinoLoggerProvider concrete adapter.

### Fixed
- Fixed the package versions for @blendsdk/webafx-pino.


## [5.44.0] - 2026-05-20

Added:
- New package: @blendsdk/webafx-pino — wraps Pino behind WebAFX Logger interface.

Changed:
- Updated documentation across multiple ai-training files in the @blendsdk/webafx-pino package.
- Improved package.json files for better version consistency.

Fixed:
- Fixed the package versions in the @blendsdk/webafx-pino package.


## [5.43.1] - 2026-05-20

### Added
- New package: @blendsdk/webafx-pino — wraps Pino behind WebAFX Logger interface.

### Changed
- Updated documentation in the ai-training directory, enhancing clarity and adding new examples.

### Fixed
- Fixed the package versions in @blendsdk/webafx-pino.


## [5.43.0] - 2026-05-19

## Added
- New package: @blendsdk/webafx-pino — wraps Pino behind WebAFX Logger interface.

## Changed
- Updated package versions for dependencies and configurations.

## Fixed
- Fixed the package versions in @blendsdk/webafx-pino.


## [5.42.0] - 2026-05-18

### Added
- New package: @blendsdk/webafx-pino — wraps Pino behind WebAFX Logger interface.

### Fixed
- Fixed the package versions.

### Changed
- Updated documentation across multiple files in the @blendsdk/webafx-pino package.


## [5.41.0] - 2026-05-17

Added: New package: @blendsdk/webafx-pino — wraps Pino behind WebAFX Logger interface  
Changed: Updated package versions across multiple packages  
Changed: Enhanced documentation for ai-training in webafx-pino  
Fixed: Fixed the package versions for webafx-pino


## [5.40.0] - 2026-05-17

### Added
- New package: @blendsdk/webafx-pino — wraps Pino behind WebAFX Logger interface.
- LoggerProvider abstract class + PinoLoggerProvider concrete adapter.
- pinoLoggerPlugin() one-liner and createLoggerPl...

### Fixed
- Fixed the package versions.


## [5.39.0] - 2026-05-07

Added:
  - New package: @blendsdk/webafx-pino — wraps Pino behind WebAFX Logger interface.
  - LoggerProvider abstract class and PinoLoggerProvider concrete adapter.
  
Changed:
  - Updated package versions in package.json.

Fixed:
  - Resolved versioning issues in the package files.

