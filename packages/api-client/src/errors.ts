/**
 * Error types for the API client runtime.
 *
 * A non-2xx response becomes an {@link ApiError} carrying the server's error
 * envelope. A failure that happens before a response exists becomes an
 * {@link ApiTransportError}. Neither ever includes a token or credential.
 *
 * @module
 */

/**
 * Recognized fields of the server error envelope.
 */
interface ServerErrorEnvelope {
  /** Machine-readable error code. */
  code?: unknown;
  /** Human-readable error message. */
  message?: unknown;
  /** Structured details, when the server provides them. */
  details?: unknown;
  /** Server request id, when the server provides it. */
  requestId?: unknown;
}

/**
 * A non-2xx response, carrying the server's error envelope.
 *
 * @example
 * ```typescript
 * try {
 *   await client.products.getProduct({ id: 42 });
 * } catch (error) {
 *   if (error instanceof ApiError && error.code === 'not_found') {
 *     // handle a missing product
 *   }
 * }
 * ```
 */
export class ApiError extends Error {
  /** HTTP status code. */
  readonly statusCode: number;
  /** Machine-readable error code from the server envelope. */
  readonly code: string;
  /** Optional structured details. */
  readonly details?: unknown;
  /** Server request id, when present. */
  readonly requestId?: string;
  /** The operation id that produced the error. */
  readonly operationId: string;

  /**
   * @param message - Human-readable message, already redacted.
   * @param options - Status code, code, and optional envelope details.
   */
  constructor(
    message: string,
    options: {
      statusCode: number;
      code: string;
      details?: unknown;
      requestId?: string;
      operationId: string;
    }
  ) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = options.statusCode;
    this.code = options.code;
    this.details = options.details;
    this.requestId = options.requestId;
    this.operationId = options.operationId;
  }
}

/**
 * A failure before a response existed (network error or abort).
 */
export class ApiTransportError extends Error {
  /** The operation id that produced the error. */
  readonly operationId: string;
  /** The underlying cause, when available. */
  readonly cause?: unknown;

  /**
   * @param message - Human-readable message, already redacted.
   * @param options - The operation id and optional cause.
   */
  constructor(message: string, options: { operationId: string; cause?: unknown }) {
    super(message);
    this.name = 'ApiTransportError';
    this.operationId = options.operationId;
    this.cause = options.cause;
  }
}

/**
 * Builds an {@link ApiError} from a non-2xx response.
 *
 * A malformed body falls back to a generic code and a status-based message so
 * the caller still gets a usable error.
 *
 * @param statusCode - The HTTP status code.
 * @param body - The parsed response body.
 * @param operationId - The operation id that produced the error.
 * @returns The constructed error.
 */
export function createApiError(statusCode: number, body: unknown, operationId: string): ApiError {
  const envelope = extractErrorEnvelope(body);

  const code = typeof envelope?.code === 'string' ? envelope.code : 'http_error';
  const message =
    typeof envelope?.message === 'string'
      ? envelope.message
      : `Request failed with status ${statusCode}`;

  return new ApiError(redactSensitive(message), {
    statusCode,
    code,
    details: envelope?.details === undefined ? undefined : redactValue(envelope.details),
    requestId:
      typeof envelope?.requestId === 'string' ? redactSensitive(envelope.requestId) : undefined,
    operationId,
  });
}

/**
 * Builds an {@link ApiTransportError} from a thrown cause.
 *
 * The cause is redacted before it is stored so a token embedded in a transport
 * message (for example a query API key in a failed URL) cannot leak through the
 * error's `cause` property.
 *
 * @param cause - The error thrown by the adapter.
 * @param operationId - The operation id that produced the error.
 * @returns The constructed error.
 */
export function createTransportError(cause: unknown, operationId: string): ApiTransportError {
  const raw =
    cause instanceof Error ? cause.message : 'The request failed before a response was received';
  return new ApiTransportError(redactSensitive(raw), {
    operationId,
    cause: redactCause(cause),
  });
}

/**
 * Removes credential material from a message before it reaches the caller.
 *
 * Authorization schemes (`Bearer`, `Basic`), JWT-shaped values, and common
 * query-string credential parameters are the ways a token can leak into a log
 * or message, so their values are replaced with `[redacted]`.
 *
 * @param message - The raw message.
 * @returns The message with credential values removed.
 */
export function redactSensitive(message: string): string {
  return message
    .replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/([?&](?:api[_-]?key|access_token|token|key)=)[^&\s]+/gi, '$1[redacted]');
}

/**
 * Recursively redacts every string leaf of a structured value.
 *
 * Server-supplied error details can echo request headers, so they are walked
 * and redacted before being attached to an error.
 *
 * @param value - The value to redact.
 * @returns A copy with credential material removed from its strings.
 */
export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactSensitive(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = redactValue(entry);
    }
    return result;
  }
  return value;
}

/**
 * Produces a redacted copy of a thrown cause.
 *
 * @param cause - The original cause.
 * @returns An `Error` with a redacted message, a redacted string, or the cause.
 */
function redactCause(cause: unknown): unknown {
  if (cause instanceof Error) {
    const copy = new Error(redactSensitive(cause.message));
    copy.name = cause.name;
    return copy;
  }
  if (typeof cause === 'string') {
    return redactSensitive(cause);
  }
  return redactValue(cause);
}

/**
 * Extracts the server error envelope from a response body.
 *
 * @param body - The parsed response body.
 * @returns The envelope, or undefined when the body is not an error envelope.
 */
function extractErrorEnvelope(body: unknown): ServerErrorEnvelope | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return undefined;
  }
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null || Array.isArray(error)) {
    return undefined;
  }
  return error as ServerErrorEnvelope;
}
