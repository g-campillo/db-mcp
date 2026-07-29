import { describe, expect, it } from "vitest";
import { normalize } from "./normalize.js";

describe("normalize", () => {
  const long = "x".repeat(100);

  it("leaves an under-cap string alone", () => {
    expect(normalize("short", 100)).toBe("short");
  });

  it("coerces a Buffer to a string", () => {
    expect(normalize(Buffer.from("bytes"), 100)).toBe("bytes");
  });

  it("leaves non-string values untouched", () => {
    expect(normalize(42, 5)).toBe(42);
    expect(normalize(null, 5)).toBe(null);
    expect(normalize(true, 5)).toBe(true);
  });

  it("renders a Date as an ISO timestamp", () => {
    expect(normalize(new Date("2026-07-29T12:34:56.000Z"), 100)).toBe(
      "2026-07-29T12:34:56.000Z",
    );
  });

  it("truncates an oversized string with a byte-count marker", () => {
    const got = normalize(long, 10);
    expect(typeof got).toBe("string");
    expect(got as string).toMatch(/^xxxxxxxxxx/);
    expect(got as string).toContain("[truncated, 100 bytes total]");
  });

  it("never splits a multibyte character at the cap boundary", () => {
    // "é" is 2 bytes, so a 5-byte cap lands mid-character.
    const multi = "é".repeat(10);
    const got = normalize(multi, 5) as string;
    expect(got).toBe("éé... [truncated, 20 bytes total]");
    // Round-tripping through UTF-8 must not change it — i.e. no U+FFFD crept in.
    expect(Buffer.from(got, "utf8").toString("utf8")).toBe(got);
    expect(got).not.toContain("�");
  });

  it("handles 4-byte characters at the boundary", () => {
    const emoji = "🙂".repeat(4); // 4 bytes each, 16 total
    const got = normalize(emoji, 6) as string;
    expect(got).toBe("🙂... [truncated, 16 bytes total]");
    expect(got).not.toContain("�");
  });

  it("treats the cap as bytes, not characters", () => {
    // 10 characters but 20 bytes: a 20-byte cap must NOT truncate.
    expect(normalize("é".repeat(10), 20)).toBe("é".repeat(10));
  });

  it("disables the cap at -1", () => {
    expect(normalize(long, -1)).toBe(long);
    expect(normalize(Buffer.from(long), -1)).toBe(long);
  });
});
