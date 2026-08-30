export function toIso8601OrNull(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (raw === "") return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}
