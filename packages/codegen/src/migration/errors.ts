import type { MigrationErrorKind, MigrationExitCode } from './types.js';

/** Constructor values for a typed migration failure. */
export interface MigrationErrorOptions {
  /** Stable machine-readable category. */
  readonly kind: MigrationErrorKind;
  /** Process exit class used by the command-line adapter. */
  readonly exitCode: MigrationExitCode;
  /** Concise human-readable message. Database URLs are redacted automatically. */
  readonly message: string;
  /** Sensitive SQL or provider detail that must never appear in normal output. */
  readonly sensitiveDetail?: string;
}

/**
 * Error raised for expected migration configuration, history, filesystem, and database failures.
 *
 * The public message is sanitized at construction time so ordinary error logging cannot expose a
 * PostgreSQL connection URL. Sensitive provider details are intentionally not retained.
 */
export class MigrationError extends Error {
  /** Stable machine-readable category. */
  public readonly kind: MigrationErrorKind;

  /** Process exit class used by the command-line adapter. */
  public readonly exitCode: MigrationExitCode;

  /**
   * Creates one sanitized migration error.
   *
   * @param options - Stable classification and safe operator context.
   */
  public constructor(options: MigrationErrorOptions) {
    super(redactMigrationMessage(options.message));
    this.name = 'MigrationError';
    this.kind = options.kind;
    this.exitCode = options.exitCode;
  }
}

/**
 * Formats a migration error for normal command-line output.
 *
 * @param error - Typed migration error to render.
 * @returns Stable category and sanitized message without SQL or credentials.
 *
 * @example
 * ```ts
 * formatMigrationError(
 *   new MigrationError({ kind: 'CONFIGURATION', exitCode: 2, message: 'Missing config' })
 * );
 * // "CONFIGURATION: Missing config"
 * ```
 */
export function formatMigrationError(error: MigrationError): string {
  return `${error.kind}: ${redactMigrationMessage(error.message)}`;
}

/**
 * Removes complete PostgreSQL URLs and common credential assignments from operator-facing text.
 *
 * Redacting the complete URL also protects query-string credentials and certificate paths whose
 * exact shapes are not controlled by BlendSDK.
 *
 * @param message - Potentially sensitive error text.
 * @returns Text safe for ordinary operator output.
 */
function redactMigrationMessage(message: string): string {
  return message
    .replace(/\bpostgres(?:ql)?:\/\/[^\s]+/giu, '[REDACTED_DATABASE_URL]')
    .replace(/\b(password|pass|secret|token)\s*=\s*[^\s,;]+/giu, '$1=[REDACTED]');
}
