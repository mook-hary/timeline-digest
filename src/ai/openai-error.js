import { redactSecrets } from "./semantic-judge.js";

const MESSAGE_MAX = 180;
const FIELD_MAX = 80;
const ERROR_STRING_MAX = 300;

function firstLine(value) {
  return String(value).split("\n")[0].trim();
}

function safeField(value, max = FIELD_MAX) {
  if (value == null) return null;
  const text = redactSecrets(firstLine(value));
  if (!text) return null;
  return text.slice(0, max);
}

function safeMessage(value) {
  return safeField(value, MESSAGE_MAX);
}

function asHttpStatus(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 100 || number > 599) return null;
  return number;
}

export function isRetryableHttpStatus(status) {
  return status === 429 || (typeof status === "number" && status >= 500);
}

export function extractOpenAiErrorDiagnostic(error) {
  const nested =
    error && error.error && typeof error.error === "object" && !Array.isArray(error.error)
      ? error.error
      : {};
  const httpStatus = asHttpStatus(
    error?.status ?? error?.statusCode ?? nested.status
  );
  return {
    category: "openai-api",
    httpStatus,
    type: safeField(error?.type ?? nested.type),
    code: safeField(error?.code ?? nested.code),
    param: safeField(error?.param ?? nested.param),
    message: safeMessage(nested.message ?? error?.message),
  };
}

export function formatOpenAiErrorDiagnostic(diagnostic) {
  const parts = [diagnostic?.category || "openai-api"];
  if (diagnostic?.httpStatus != null) parts.push(`HTTP ${diagnostic.httpStatus}`);
  if (diagnostic?.type) parts.push(`type=${diagnostic.type}`);
  if (diagnostic?.code) parts.push(`code=${diagnostic.code}`);
  if (diagnostic?.param) parts.push(`param=${diagnostic.param}`);
  if (diagnostic?.message) parts.push(`message=${diagnostic.message}`);
  return redactSecrets(parts.join(" ")).slice(0, ERROR_STRING_MAX);
}
