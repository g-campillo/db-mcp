import { describe, expect, it } from "vitest";
import { errorMessage } from "./errors.js";

describe("errorMessage", () => {
  it("returns a plain error's message", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("unwraps an AggregateError whose own message is empty", () => {
    // This is exactly what `pg` throws on a refused connection: one sub-error
    // per address family, and nothing in the outer message.
    const agg = new AggregateError([
      new Error("connect ECONNREFUSED ::1:5432"),
      new Error("connect ECONNREFUSED 127.0.0.1:5432"),
    ]);
    expect(agg.message).toBe("");
    expect(errorMessage(agg)).toBe(
      "connect ECONNREFUSED ::1:5432; connect ECONNREFUSED 127.0.0.1:5432",
    );
  });

  it("collapses identical sub-errors", () => {
    const agg = new AggregateError([new Error("same"), new Error("same")]);
    expect(errorMessage(agg)).toBe("same");
  });

  it("falls back to name and code when the message is empty", () => {
    const err = Object.assign(new Error(""), { code: "ECONNREFUSED" });
    expect(errorMessage(err)).toBe("Error (ECONNREFUSED)");
  });

  it("falls back to the error name when there is nothing else", () => {
    expect(errorMessage(new Error(""))).toBe("Error");
  });

  it("stringifies non-errors", () => {
    expect(errorMessage("just a string")).toBe("just a string");
    expect(errorMessage(42)).toBe("42");
  });

  it("keeps an AggregateError's own message when the sub-errors say nothing", () => {
    const agg = new AggregateError([], "outer explanation");
    expect(errorMessage(agg)).toBe("outer explanation");
  });
});
