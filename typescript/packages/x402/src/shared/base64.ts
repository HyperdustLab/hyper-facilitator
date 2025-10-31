export const Base64EncodedRegex = /^[A-Za-z0-9+/]*={0,2}$/;
const BASE64_TRIM_REGEX = /\s+/g;

function normalizeBase64Input(data: string): string {
  const normalized = data.replace(BASE64_TRIM_REGEX, "");
  if (normalized.length === 0 || normalized.length % 4 !== 0 || !Base64EncodedRegex.test(normalized)) {
    throw new Error("Invalid base64 string");
  }
  return normalized;
}

/**
 * Encodes a string to base64 format
 *
 * @param data - The string to be encoded to base64
 * @returns The base64 encoded string
 */
export function safeBase64Encode(data: string): string {
  if (typeof globalThis !== "undefined" && typeof globalThis.btoa === "function") {
    return globalThis.btoa(data);
  }
  return Buffer.from(data).toString("base64");
}

/**
 * Decodes a base64 string back to its original format
 *
 * @param data - The base64 encoded string to be decoded
 * @returns The decoded string in UTF-8 format
 */
export function safeBase64Decode(data: string): string {
  const normalized = normalizeBase64Input(data);
  if (typeof globalThis !== "undefined" && typeof globalThis.atob === "function") {
    return globalThis.atob(normalized);
  }
  return Buffer.from(normalized, "base64").toString("utf-8");
}

/**
 * Decodes a base64 string and parses the result as JSON.
 *
 * @param data - The base64 encoded string containing JSON data
 * @returns The parsed JSON value
 */
export function safeBase64DecodeJson<T>(data: string): T {
  const decoded = safeBase64Decode(data);
  try {
    return JSON.parse(decoded) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON payload: ${message}`);
  }
}
