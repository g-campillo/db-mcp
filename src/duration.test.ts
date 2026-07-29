import { describe, expect, it } from "vitest";
import { parseGoDuration } from "./duration.js";

describe("parseGoDuration", () => {
  it.each<[string, number]>([
    ["0", 0],
    ["30s", 30_000],
    ["1m", 60_000],
    ["1m30s", 90_000],
    ["500ms", 500],
    ["2h", 7_200_000],
    ["1h15m", 4_500_000],
    ["1.5s", 1_500],
    ["100us", 0.1],
    ["100µs", 0.1],
    ["1000ns", 0.001],
    ["-5s", -5_000],
    ["+5s", 5_000],
  ])("parses %j", (input, want) => {
    expect(parseGoDuration(input)).toBeCloseTo(want, 6);
  });

  it.each(["", "nope", "30", "s", "1x", "..", "1.s2"])("rejects %j", (input) => {
    expect(() => parseGoDuration(input)).toThrow();
  });
});
