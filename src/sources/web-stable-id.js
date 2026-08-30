import { createHash } from "node:crypto";

const MAX_RAW_ID_LEN = 180;
const SAFE_ID = /^[\w.:/?#@&=+\-%,~]+$/i;

export function compactStableId(value) {
  const trimmed = String(value).trim();
  if (trimmed.length <= MAX_RAW_ID_LEN && SAFE_ID.test(trimmed)) {
    return trimmed;
  }
  return createHash("sha256").update(trimmed, "utf8").digest("hex");
}

export function resolveOriginalId(item) {
  const guid = nonempty(item && item.guid);
  if (guid) return guid;
  const url = nonempty(item && item.url);
  if (url) return url;
  return null;
}

export function buildWebItemId(provider, originalId) {
  return `web:${provider}:${compactStableId(originalId)}`;
}

function nonempty(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}
