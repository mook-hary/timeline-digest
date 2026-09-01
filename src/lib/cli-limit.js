import { ValidationError } from "./errors.js";

export function parseRequestLimitArg(argv) {
  const equals = argv.find((arg) => arg.startsWith("--limit="));
  let raw = null;
  if (equals) {
    raw = equals.slice("--limit=".length);
  } else {
    const index = argv.indexOf("--limit");
    if (index === -1) return null;
    raw = argv[index + 1];
    if (raw == null || raw.startsWith("--")) {
      throw new ValidationError(
        "Invalid --limit. Use a positive integer (new AI requests, not cache hits)."
      );
    }
  }
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new ValidationError(
      `Invalid --limit: ${raw}. Use a positive integer (new AI requests, not cache hits).`
    );
  }
  return Number(raw);
}

export function validateRequestLimit(value) {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 1) {
    throw new ValidationError(
      "Invalid --limit. Use a positive integer (new AI requests, not cache hits)."
    );
  }
  return value;
}
