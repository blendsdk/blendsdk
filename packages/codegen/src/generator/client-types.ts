/**
 * Public types for the API client generator.
 *
 * These types describe the options a caller passes to
 * {@link generateClient}/{@link checkClient}, the resolved shape of one
 * operation, and the result of a generation or drift-check run. They are
 * exported from `@blendsdk/codegen` so configuration files and tests can use
 * them without reaching into generator internals.
 *
 * @module
 */

/**
 * Options that shape generation.
 *
 * @example
 * ```typescript
 * const options: ClientGeneratorOptions = {
 *   outputDir: 'src/api-client',
 *   runtimeImport: '@blendsdk/api-client',
 * };
 * ```
 */
export interface ClientGeneratorOptions {
  /** Output directory for generated files, resolved relative to the config file. */
  outputDir: string;
  /** Emit one file per group instead of grouping every method in `client.ts`. */
  splitByGroup?: boolean;
  /**
   * Treat contract problems as errors instead of warnings. When true, a
   * missing `operationId` or 2xx schema fails generation instead of warning.
   */
  strict?: boolean;
  /** Base name of the generated client type. Defaults to `AppClient`. */
  clientName?: string;
  /** Runtime import specifier. Defaults to `blendsdk/api-client`. */
  runtimeImport?: string;
}

/**
 * One generated operation, resolved from the OpenAPI document.
 */
export interface GeneratedOperation {
  /** OpenAPI operationId, or the deterministic fallback when it was missing. */
  operationId: string;
  /** Method name; equals `operationId`, or a deterministic fallback when it is missing. */
  methodName: string;
  /** HTTP method, lowercase. */
  method: string;
  /** OpenAPI path with `{param}` placeholders. */
  path: string;
  /** Group name derived tag-first, else from the first path segment after `/api`. */
  group: string;
  /** How the runtime reads a successful response body. */
  envelope: 'data' | 'body';
  /** True when no 2xx response schema exists, so the return type is `unknown`. */
  untypedResponse: boolean;
}

/**
 * How serious a contract problem is.
 *
 * - `warning` is reported by `generate` and does not stop it.
 * - `error` is reported by `check`, which then fails.
 */
export type ContractIssueSeverity = 'warning' | 'error';

/**
 * One problem found while reading the contract.
 */
export interface ContractIssue {
  /** Whether the problem is a warning or an error. */
  severity: ContractIssueSeverity;
  /** Concise, human-readable description with the operation location. */
  message: string;
  /** The operationId, when the operation has one. */
  operationId?: string;
  /** The HTTP method of the affected operation. */
  method?: string;
  /** The path of the affected operation. */
  path?: string;
}

/**
 * The result of one generation or drift-check run.
 */
export interface GenerationResult {
  /** File names written (generate) or compared (check). */
  files: string[];
  /** Problems found while reading the contract. */
  issues: ContractIssue[];
  /** True when `check` found a difference or a contract error. */
  drifted?: boolean;
  /** The files that differ from the committed ones, for `check` reporting. */
  driftedFiles?: string[];
}

/**
 * Raised when the contract cannot be turned into a client at all.
 *
 * The only current cause is a duplicate `operationId`, which would otherwise
 * silently overwrite one generated method with another. The message names both
 * offending method/path locations so the author can fix the source route.
 */
export class ClientGenerationError extends Error {
  /**
   * Creates one fatal generation error.
   *
   * @param message - A message naming the conflicting operations.
   */
  public constructor(message: string) {
    super(message);
    this.name = 'ClientGenerationError';
  }
}
