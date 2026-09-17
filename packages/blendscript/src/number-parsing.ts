/** Shared decimal grammar prefix used by source lexing and explicit runtime conversion. */
const decimalNumberPrefix = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?/u;

/** Returns the leading BlendScript decimal number text, when one is present. */
export function matchDecimalNumberPrefix(value: string): string | undefined {
  const match = value.match(decimalNumberPrefix);
  return match?.[0];
}

/**
 * Parses text only when the complete value uses BlendScript's locale-independent
 * decimal grammar and produces a finite JavaScript number.
 */
export function parseFiniteDecimal(value: string): number | null {
  const match = matchDecimalNumberPrefix(value);
  if (match === undefined || match.length !== value.length) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}
