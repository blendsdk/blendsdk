/**
 * Errors raised by the `blendsdk api` commands.
 *
 * The CLI maps each error to a process exit code: `2` for a usage or
 * configuration problem, and `1` for an operational failure. Keeping the exit
 * code on the error keeps the mapping in one place.
 *
 * @module
 */

/**
 * A failure that carries the process exit code the CLI should return.
 */
export class ApiCliError extends Error {
  /** Process exit class: `1` for operational failure, `2` for usage/config. */
  public readonly exitCode: number;

  /**
   * Creates one CLI error.
   *
   * @param message - A concise, secret-free message.
   * @param exitCode - The process exit code (`1` or `2`).
   */
  public constructor(message: string, exitCode: number) {
    super(message);
    this.name = 'ApiCliError';
    this.exitCode = exitCode;
  }
}

/**
 * Creates a usage or configuration error (`exitCode` 2).
 *
 * @param message - A concise description of the problem.
 * @returns A typed CLI error.
 */
export function configurationError(message: string): ApiCliError {
  return new ApiCliError(message, 2);
}
