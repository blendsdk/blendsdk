import type { TranslationSource, TranslationCatalog } from "@blendsdk/i18n";

/**
 * Configuration for the PostgreSQL translation source.
 */
export interface PostgreSQLSourceConfig {
    /**
     * A function that executes a SQL query and returns rows.
     *
     * This is a callback rather than a direct database connection
     * to decouple the source from any specific PostgreSQL client.
     *
     * @example
     * queryFn: (sql) => database.query(sql)
     */
    queryFn: (sql: string) => Promise<Array<{ key: string; locale: string; value: string }>>;

    /**
     * The table name containing translations.
     * @default "translations"
     */
    tableName?: string;

    /**
     * Optional WHERE clause filter (without the WHERE keyword).
     * Useful for filtering by application, domain, or active status.
     *
     * @example
     * filter: "active = true AND app = 'myapp'"
     */
    filter?: string;
}

/**
 * Translation source that loads from a PostgreSQL database table.
 *
 * Reads all translation rows and normalizes them into a TranslationCatalog.
 * Each row maps to one key-locale pair.
 *
 * The source supports plural values stored as JSON arrays in the `value` column:
 * - Simple string: `"Hello"` → stored as `Hello`
 * - Plural array: `["1 book", "N books"]` → stored as `["1 book","N books"]` (JSON string)
 *
 * @example
 * ```typescript
 * const source = new PostgreSQLSource({
 *     queryFn: (sql) => database.query(sql),
 *     tableName: "translations",
 * });
 * const catalog = await source.load();
 * ```
 */
export class PostgreSQLSource implements TranslationSource {
    /** @inheritdoc */
    readonly name = "PostgreSQLSource";

    /** Source configuration */
    protected config: PostgreSQLSourceConfig;

    /**
     * Create a new PostgreSQLSource.
     *
     * @param config - PostgreSQL source configuration
     */
    constructor(config: PostgreSQLSourceConfig) {
        this.config = config;
    }

    /**
     * Load all translations from the configured PostgreSQL table.
     *
     * Builds a SQL query, executes it via the configured queryFn,
     * and normalizes the rows into a TranslationCatalog.
     *
     * @returns The translation catalog from the database
     * @throws Error if the query fails
     */
    async load(): Promise<TranslationCatalog> {
        const tableName = this.config.tableName ?? "translations";
        let sql = `SELECT key, locale, value FROM ${tableName}`;
        if (this.config.filter) {
            sql += ` WHERE ${this.config.filter}`;
        }
        sql += ` ORDER BY key, locale`;

        const rows = await this.config.queryFn(sql);
        const catalog: TranslationCatalog = {};

        for (const row of rows) {
            if (!catalog[row.key]) {
                catalog[row.key] = {};
            }
            catalog[row.key][row.locale] = this.parseValue(row.value);
        }

        return catalog;
    }

    /**
     * Parse a value from the database.
     *
     * If the value is a JSON array (starts with '['), parse it as
     * a [singular, plural] tuple. Otherwise, return as plain string.
     *
     * @param value - The raw string value from the database
     * @returns Parsed TranslationValue
     */
    protected parseValue(value: string): string | [string, string] {
        if (value.startsWith("[")) {
            try {
                const parsed = JSON.parse(value);
                if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
                    return parsed as [string, string];
                }
            } catch {
                // Not valid JSON — return as plain string
            }
        }
        return value;
    }
}

/**
 * Create a PostgreSQLSource instance. Convenience factory for plugin configuration.
 *
 * @param config - PostgreSQL source configuration
 * @returns A new PostgreSQLSource instance
 *
 * @example
 * ```typescript
 * app.use(createI18nPlugin({
 *     sources: [
 *         postgresqlSource({ queryFn: (sql) => database.query(sql) }),
 *     ],
 * }));
 * ```
 */
export function postgresqlSource(config: PostgreSQLSourceConfig): PostgreSQLSource {
    return new PostgreSQLSource(config);
}
