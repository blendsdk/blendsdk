import type { BlendScriptApiErrorCode } from './types.js';

/**
 * Reports invalid API arguments or other programmer misuse.
 *
 * Expression authoring problems are returned as diagnostics instead of thrown.
 */
export class BlendScriptApiError extends Error {
  /** Stable machine-readable programmer-error code. */
  public readonly code: BlendScriptApiErrorCode;

  /** Creates a programmer error with a stable code and human-readable message. */
  public constructor(code: BlendScriptApiErrorCode, message: string) {
    super(message);
    this.name = 'BlendScriptApiError';
    this.code = code;
  }
}
