import { describe, expect, it } from "vitest";
import { safeBase64Decode, safeBase64Encode } from "./base64";

describe("safeBase64Encode", () => {
  it("encodes UTF-8 strings to base64", () => {
    expect(safeBase64Encode("hello world")).toBe("aGVsbG8gd29ybGQ=");
  });
});

describe("safeBase64Decode", () => {
  it("decodes base64 strings", () => {
    expect(safeBase64Decode("aGVsbG8gd29ybGQ=")).toBe("hello world");
  });

  it("ignores whitespace within base64 strings", () => {
    expect(safeBase64Decode("aGVs bG8g\nd29y bGQ=")).toBe("hello world");
  });

  it("throws for invalid base64 input", () => {
    expect(() => safeBase64Decode("invalid@@")).toThrow("Invalid base64 string");
  });
});
