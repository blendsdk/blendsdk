import { readFile, readdir } from "node:fs/promises";
import { basename, resolve, dirname, extname } from "node:path";
import type { TranslationCatalog } from "./types.js";
import type { TranslationSource } from "./translation-source.js";

/**
 * Configuration for the content file translation source.
 */
export interface ContentFileSourceConfig {
    /**
     * Array of directory paths or glob patterns to scan for content files.
     *
     * Each path can be:
     * - A directory path: all matching files in the directory are loaded
     * - A glob pattern: files matching the pattern are loaded
     *
     * Files must follow the naming convention: `<locale>.<key>.<ext>`
     * where:
     * - First segment = locale (e.g., "en", "nl", "de")
     * - Last segment = file extension (e.g., "html", "md", "txt")
     * - Middle segments = translation key (e.g., "signup-email", "auth.welcome")
     *
     * @example
     * paths: ["./content/emails", "./content/pages"]
     * paths: ["./content/emails/*.html"]
     */
    paths: string[];

    /**
     * File extensions to include (with leading dot).
     * Files with other extensions are silently ignored.
     *
     * @default [".html", ".md", ".txt"]
     */
    extensions?: string[];
}

/** Default file extensions to load when none are configured */
const DEFAULT_EXTENSIONS: string[] = [".html", ".md", ".txt"];

/**
 * Parsed result from a content filename.
 */
interface ParsedContentFilename {
    /** The locale (first segment): "en", "nl", "de" */
    locale: string;
    /** The translation key (middle segments joined by dots): "signup-email", "auth.welcome" */
    key: string;
}

/**
 * Parse a content filename into locale and key.
 *
 * Convention: `<locale>.<key>.<ext>`
 * - First dot-segment = locale
 * - Last dot-segment = extension (ignored, used for filtering)
 * - Everything in between = translation key
 *
 * Requires at least 3 segments (locale + key + extension).
 *
 * @param filename - The filename (without directory path)
 * @returns Parsed locale and key, or null if filename doesn't match convention
 *
 * @example
 * parseContentFilename("nl.signup-email.html")
 * // → { locale: "nl", key: "signup-email" }
 *
 * parseContentFilename("en.auth.welcome.md")
 * // → { locale: "en", key: "auth.welcome" }
 *
 * parseContentFilename("readme.txt")
 * // → null (only 2 segments — no key)
 */
function parseContentFilename(filename: string): ParsedContentFilename | null {
    const segments = filename.split(".");

    // Need at least 3 segments: locale, key (1+), extension
    if (segments.length < 3) {
        return null;
    }

    const locale = segments[0];
    // Skip the last segment (extension) and join middle segments as key
    const key = segments.slice(1, -1).join(".");

    // Validate: locale and key must be non-empty
    if (!locale || !key) {
        return null;
    }

    return { locale, key };
}

/**
 * List all files in a directory (non-recursive).
 *
 * Returns an empty array if the directory doesn't exist,
 * allowing graceful handling of optional content directories.
 *
 * @param dirPath - Directory path to list
 * @returns Array of absolute file paths
 */
async function listDirectoryFiles(dirPath: string): Promise<string[]> {
    try {
        const entries = await readdir(resolve(dirPath));
        return entries.map((entry) => resolve(dirPath, entry));
    } catch {
        // Directory doesn't exist or can't be read — return empty
        return [];
    }
}

/**
 * Expand a simple glob pattern into matching file paths.
 *
 * Supports only `*` and `?` wildcards in the filename part (not recursive `**`).
 * This covers the primary use case for content files without needing
 * an external glob library.
 *
 * Same implementation as used by JsonFileSource for consistency.
 *
 * @param pattern - A glob pattern (e.g., "./content/*.html")
 * @returns Array of matching absolute file paths
 */
async function expandSimpleGlob(pattern: string): Promise<string[]> {
    const dir = dirname(pattern);
    const filePattern = basename(pattern);

    // Convert glob pattern to regex: * → [^/]*, ? → [^/]
    const regexStr = filePattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&") // Escape regex special chars (except * and ?)
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]");
    const regex = new RegExp(`^${regexStr}$`);

    try {
        const entries = await readdir(resolve(dir));
        return entries
            .filter((entry) => regex.test(entry))
            .map((entry) => resolve(dir, entry));
    } catch {
        // Directory doesn't exist — return empty (no matches)
        return [];
    }
}

/**
 * Translation source that loads from individual content files.
 *
 * Each file represents one translation key for one locale.
 * The filename convention is `<locale>.<key>.<ext>`:
 * - `nl.signup-email.html` → locale: "nl", key: "signup-email"
 * - `en.auth.welcome.md` → locale: "en", key: "auth.welcome"
 *
 * File content is read as UTF-8 and stored as-is (no transformation).
 *
 * @example
 * ```typescript
 * const source = new ContentFileSource({
 *     paths: ["./content/emails"],
 * });
 * const catalog = await source.load();
 * ```
 */
export class ContentFileSource implements TranslationSource {
    /** @inheritdoc */
    readonly name = "ContentFileSource";

    /** Source configuration */
    protected config: ContentFileSourceConfig;

    /** Resolved extensions (with leading dot, lowercased) */
    protected extensions: string[];

    /**
     * Create a new ContentFileSource.
     *
     * @param config - Directory paths, glob patterns, and optional extension filter
     */
    constructor(config: ContentFileSourceConfig) {
        this.config = config;
        // Normalize extensions: ensure leading dot and lowercase
        this.extensions = (config.extensions ?? DEFAULT_EXTENSIONS).map((ext) =>
            ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`
        );
    }

    /**
     * Load all translations from configured content file paths.
     *
     * 1. Resolves all paths (directories and globs) to individual file paths
     * 2. Parses each filename for locale and key using `<locale>.<key>.<ext>` convention
     * 3. Filters by supported extensions
     * 4. Reads file content as UTF-8
     * 5. Builds translation catalog with content as-is
     *
     * Files that don't match the naming convention or have unsupported
     * extensions are silently skipped.
     *
     * @returns The complete translation catalog from all matched content files
     * @throws Error if a matched file cannot be read (e.g., permission denied)
     */
    async load(): Promise<TranslationCatalog> {
        const catalog: TranslationCatalog = {};

        // Resolve all paths to individual file paths
        const filePaths = await this.resolveAllPaths();

        for (const filePath of filePaths) {
            const filename = basename(filePath);

            // Parse locale and key from filename
            const parsed = parseContentFilename(filename);
            if (!parsed) {
                // Invalid filename format — skip silently
                continue;
            }

            // Check extension is in the supported list
            const ext = extname(filename).toLowerCase();
            if (!this.extensions.includes(ext)) {
                continue;
            }

            // Read file content as-is (no transformation)
            const content = await readFile(filePath, "utf-8");

            // Add to catalog: key → { locale: content }
            if (!catalog[parsed.key]) {
                catalog[parsed.key] = {};
            }
            catalog[parsed.key][parsed.locale] = content;
        }

        return catalog;
    }

    /**
     * Resolve all configured paths to individual file paths.
     *
     * - Plain directory paths (no glob chars): list all files in the directory
     * - Glob patterns (contains * or ?): expand using simple wildcard matching
     *
     * Results are sorted for deterministic ordering so the same input
     * always produces the same catalog.
     *
     * @returns Array of resolved absolute file paths, sorted alphabetically
     */
    protected async resolveAllPaths(): Promise<string[]> {
        const allPaths: string[] = [];

        for (const configPath of this.config.paths) {
            if (configPath.includes("*") || configPath.includes("?")) {
                // Glob pattern — expand it
                const matches = await expandSimpleGlob(configPath);
                allPaths.push(...matches);
            } else {
                // Plain directory path — list files
                const files = await listDirectoryFiles(configPath);
                allPaths.push(...files);
            }
        }

        // Sort for deterministic ordering
        return allPaths.sort();
    }
}

/**
 * Create a ContentFileSource instance. Convenience factory for plugin configuration.
 *
 * @param config - Content file source configuration
 * @returns A new ContentFileSource instance
 *
 * @example
 * ```typescript
 * app.use(createI18nPlugin({
 *     sources: [
 *         contentFileSource({ paths: ["./content/emails"] }),
 *     ],
 * }));
 * ```
 */
export function contentFileSource(config: ContentFileSourceConfig): ContentFileSource {
    return new ContentFileSource(config);
}
