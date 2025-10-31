import { describe, expect, it } from "vitest";

import { safeBase64Decode, safeBase64DecodeJson, safeBase64Encode } from "./base64";

describe("safeBase64Encode", () => {
  it("encodes plain text to base64", () => {
    expect(safeBase64Encode("hello world")).toBe("aGVsbG8gd29ybGQ=");
  });
});

describe("safeBase64Decode", () => {
  it("decodes base64 strings", () => {
    expect(safeBase64Decode("aGVsbG8gd29ybGQ=")).toBe("hello world");
  });

  it("accepts base64 with whitespace", () => {
    expect(safeBase64Decode("aGV s\nbG8gd  29ybGQ=")).toBe("hello world");
  });

  it("rejects invalid characters", () => {
    expect(() => safeBase64Decode("%%%=")).toThrow("Invalid base64 string");
  });

  it("rejects incorrect padding", () => {
    expect(() => safeBase64Decode("aGVsbG8")).toThrow("Invalid base64 string");
  });
});

describe("safeBase64DecodeJson", () => {
  it("parses JSON payloads after decoding", () => {
    const payload = safeBase64Encode(JSON.stringify({ value: 42 }));
    expect(safeBase64DecodeJson<{ value: number }>(payload)).toEqual({ value: 42 });
  });

  it("throws when decoded content is not valid JSON", () => {
    const payload = safeBase64Encode("not json");
    expect(() => safeBase64DecodeJson(payload)).toThrow("Invalid JSON payload");
  });
});
