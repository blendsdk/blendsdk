# Changelog

## 5.50.0

- Added Microsoft Graph email delivery using app-only Entra authentication.
- Added support for common BlendSDK recipients, HTML and text bodies, and direct file attachments.
- Added WebAFX plugin registration through `azureMailPlugin`.


## [5.65.0] - 2026-09-27

Changed: Bumped lockstep version to 5.64.0 and updated various package changelogs and metadata files.  
Changed: Sanitize the injected package.json context, removing unnecessary headers and references.  
Added: Generate versionless ai-training and skill references in ai-training templates, dropping version metadata line.  
Changed: Regenerate ai-training sources and assemble the agent skill with updated templates and guides.


## [5.64.0] - 2026-09-27

Added:
- Generate versionless ai-training and skill references for enhanced documentation.

Changed:
- Refresh the ai-training manifest sdkVersion for improved compatibility.
- Regenerate all ai-training sources with DeepSeek and assemble agent skill.

Removed:
- Drop the version metadata line and {{version}} prompt variable from ai-training templates.


## [5.63.0] - 2026-09-27

Changed: Updated ai-training documentation files for clarity and consistency across the series.  
Changed: Bumped all package versions to 5.62.0, incorporating all previous changes.  
Added: New versionless ai-training and skill references created for streamlined usage.  
Fixed: Sanitized injected `package.json` context to remove unnecessary reference headers.  
Removed: Version metadata dropped from ai-training templates to simplify user experience.


## [5.62.0] - 2026-09-26

Changed: Bump all package versions to 5.61.0 in the lockstep versioning system.  
Added: Generate versionless ai-training and skill references by removing version metadata from templates.  
Added: Assemble agent skill from regenerated sources, enhancing capabilities with DeepSeek.  
Fixed: Sanitize the injected package.json context removing unnecessary reference headers.


## [5.61.0] - 2026-09-26

Changed: Bumped dependencies across all workspaces to version 5.60.0.  
Added: Generate versionless AI-training and skill references, dropping the version metadata from templates.  
Fixed: Sanitized injected package.json context by removing the header injection.  
Fixed: Regenerated all AI-training sources with DeepSeek and assembled the agent skill.


## [5.60.0] - 2026-09-26

### Added
- Generate versionless ai-training and skill references by dropping version metadata from templates.

### Changed
- Refresh the ai-training manifest sdkVersion.
- Sanitize the injected package.json context to remove reference header injection.

### Fixed
- Assemble agent skill from regenerated ai-training sources to enhance capabilities.


## [5.59.0] - 2026-09-17

Changed: Bumped the lockstep version to 5.58.0 after merging v5 releases, including 5.57.0.  
Changed: Updated ai-training manifest sdkVersion to reflect the latest changes.  
Added: Generated versionless ai-training and skill references by removing version metadata from templates.  
Fixed: Sanitized injected package.json context by removing unnecessary reference headers.  
Fixed: Assembled agent skill from regenerated sources, improving overall training accuracy.


## [5.57.0] - 2026-09-16

### Added
- Generate versionless AI training and skill references by dropping version metadata from templates and prompt variables.

### Changed
- Assembled agent skill from regenerated sources, migrating retired guides and patterns.
- Sanitized the injected package.json context and removed reference header injection.

### Fixed
- Updated multiple ai-training documentation files to ensure consistency and clarity.


## [5.56.0] - 2026-09-15

Added:
- Generate versionless ai-training and skill references by dropping version metadata from templates.

Changed:
- Sanitized injected package.json context by removing reference header injection.
- Regenerated all 176 ai-training sources with DeepSeek and assembled the agent skill.
- Migrated retired MCP hand-written guides and patterns to structured references.


## [5.55.0] - 2026-09-14

Added:
- Assembled agent skill from regenerated sources using DeepSeek.

Changed:
- Migrated retired MCP hand-written guides and patterns to updated documentation structure.
- Updated multiple AI training files for clarity and depth in core concepts, usage, and best practices.


## [5.52.0] - 2026-08-29

Changed: Updated package.json to include new dependencies and versioning for enhanced functionality.

