/**
 * Turns anything thrown into a message worth showing.
 *
 * Node's own failures are not always self-describing: a refused TCP connection
 * arrives as an AggregateError whose `message` is the empty string, with the
 * real reasons — one per address family — hidden in `errors`. Reporting
 * `err.message` directly would print nothing at exactly the moment the user
 * most needs to know what went wrong.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof AggregateError) {
    const parts = err.errors.map(errorMessage).filter((m) => m !== "");
    const unique = [...new Set(parts)];
    if (unique.length > 0) return unique.join("; ");
  }
  if (err instanceof Error) {
    if (err.message !== "") return err.message;
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code !== "") return `${err.name} (${code})`;
    return err.name;
  }
  return String(err);
}
