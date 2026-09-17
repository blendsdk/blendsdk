/**
 * Returns a greeting for the supplied name.
 *
 * The fixture keeps the implementation trivial: the tests only care that the
 * package has a stable public API surface to hash, not about greeting logic.
 *
 * @param name - The name to greet
 * @returns A greeting string
 */
export function greeter(name: string): string {
  return `Hello, ${name}!`;
}
