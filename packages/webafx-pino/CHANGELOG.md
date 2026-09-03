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

