import { describe, expect, it } from "vitest";
import { parseKeychainConns, validConnName } from "./keychain.js";

describe("parseKeychainConns", () => {
  it("returns sorted, deduped db-mcp names and ignores other services", () => {
    const dump = `
keychain: "/Users/x/Library/Keychains/login.keychain-db"
class: "genp"
attributes:
    "svce"<blob>="db-mcp/navy-dev"
    "acct"<blob>="navy-dev"
class: "genp"
attributes:
    "svce"<blob>="db-mcp/ah-product"
    "acct"<blob>="ah-product"
class: "genp"
attributes:
    "svce"<blob>="some-other-service"
    "acct"<blob>="me"
class: "genp"
attributes:
    "svce"<blob>="db-mcp/navy-dev"
`;
    expect(parseKeychainConns(dump)).toEqual(["ah-product", "navy-dev"]);
  });

  it("returns nothing for an empty dump", () => {
    expect(parseKeychainConns("")).toEqual([]);
  });

  it("skips names that fail validation", () => {
    expect(parseKeychainConns('"svce"<blob>="db-mcp/has space"')).toEqual([]);
  });
});

describe("validConnName", () => {
  it.each(["navy-dev", "ah_product", "db.one", "A1"])("accepts %j", (s) => {
    expect(validConnName(s)).toBe(true);
  });

  it.each(["", "has space", "with/slash", "a;b", 'quote"'])("rejects %j", (s) => {
    expect(validConnName(s)).toBe(false);
  });
});
