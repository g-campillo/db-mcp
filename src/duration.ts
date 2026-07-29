/**
 * Go duration parsing, kept so DB_QUERY_TIMEOUT values already written into
 * project .mcp.json files ("30s", "1m30s", "500ms") keep working unchanged.
 *
 * Mirrors time.ParseDuration: an optional sign, then one or more
 * <number><unit> groups, where number may carry a fraction. A bare "0" is the
 * one value allowed without a unit.
 */

const UNIT_MS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  "µs": 1e-3, // µ U+00B5 MICRO SIGN
  "μs": 1e-3, // μ U+03BC GREEK SMALL LETTER MU
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

/** Parses a Go duration string and returns milliseconds. Throws if invalid. */
export function parseGoDuration(input: string): number {
  const s = input.trim();
  if (s === "") throw new Error(`invalid duration "${input}"`);

  let i = 0;
  let neg = false;
  if (s[i] === "-" || s[i] === "+") {
    neg = s[i] === "-";
    i++;
  }

  // Special case: a bare zero needs no unit.
  if (s.slice(i) === "0") return 0;
  if (i >= s.length) throw new Error(`invalid duration "${input}"`);

  let total = 0;
  while (i < s.length) {
    const numStart = i;
    while (i < s.length && s[i]! >= "0" && s[i]! <= "9") i++;
    if (s[i] === ".") {
      i++;
      while (i < s.length && s[i]! >= "0" && s[i]! <= "9") i++;
    }
    const numText = s.slice(numStart, i);
    if (numText === "" || numText === ".") {
      throw new Error(`invalid duration "${input}"`);
    }

    const unitStart = i;
    while (i < s.length && !(s[i]! >= "0" && s[i]! <= "9") && s[i] !== ".") i++;
    const unit = s.slice(unitStart, i);
    if (unit === "") throw new Error(`missing unit in duration "${input}"`);

    const mult = UNIT_MS[unit];
    if (mult === undefined) {
      throw new Error(`unknown unit "${unit}" in duration "${input}"`);
    }
    total += Number(numText) * mult;
  }

  return neg ? -total : total;
}
