import { MAX_EXCERPT_LENGTH } from './limits.js';
import type {
  RecordExpressionDiagnostic,
  SourceExpressionDiagnostic,
  SourceLocation,
  SourceSpan,
} from './types.js';

type SourceDiagnosticCode = SourceExpressionDiagnostic['code'];

/** Converts one UTF-16 offset into the public one-based line and column convention. */
function positionAt(source: string, offset: number): Readonly<{ line: number; column: number }> {
  let line = 1;
  let column = 1;
  let cursor = 0;
  while (cursor < offset) {
    const code = source.charCodeAt(cursor);
    if (code === 13) {
      cursor += source.charCodeAt(cursor + 1) === 10 ? 2 : 1;
      line += 1;
      column = 1;
    } else if (code === 10 || code === 0x2028 || code === 0x2029) {
      cursor += 1;
      line += 1;
      column = 1;
    } else {
      cursor += 1;
      column += 1;
    }
  }
  return { line, column };
}

/** Derives the public location for a zero-based half-open span. */
export function locationForSpan(source: string, span: SourceSpan): SourceLocation {
  const start = positionAt(source, span.start);
  const end = positionAt(source, span.end);
  return Object.freeze({
    line: start.line,
    column: start.column,
    endLine: end.line,
    endColumn: end.column,
  });
}

/** Creates and freezes a bounded source diagnostic. */
export function sourceDiagnostic(
  source: string,
  code: SourceDiagnosticCode,
  message: string,
  start: number,
  end: number
): SourceExpressionDiagnostic {
  const safeStart = Math.max(0, Math.min(start, source.length));
  const safeEnd = Math.max(safeStart, Math.min(end, source.length));
  const span = Object.freeze({ start: safeStart, end: safeEnd });
  const excerptStart = Math.max(0, Math.min(safeStart, source.length - MAX_EXCERPT_LENGTH));
  const excerpt = source.slice(excerptStart, excerptStart + MAX_EXCERPT_LENGTH);
  return Object.freeze({
    kind: 'source',
    code,
    severity: 'error',
    message,
    span,
    location: locationForSpan(source, span),
    ...(excerpt.length > 0 ? { excerpt } : {}),
  });
}

/** Creates and freezes a record diagnostic without exposing its runtime value. */
export function recordDiagnostic(
  code: RecordExpressionDiagnostic['code'],
  message: string,
  field: string
): RecordExpressionDiagnostic {
  return Object.freeze({ kind: 'record', code, severity: 'error', message, field });
}
