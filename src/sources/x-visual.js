// Public X metadata only. This module never fetches or evaluates media.
export const VISUAL_ROLES = Object.freeze([
  "evidence", "reference", "diagram", "artwork", "screenshot", "photo",
  "production-material", "other",
]);

function object(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeVision(value) {
  if (!object(value) || value.status !== "ok" ||
      typeof value.observations !== "string" || !value.observations.trim()) {
    return null;
  }
  return {
    status: "ok",
    observations: value.observations,
    visibleText: typeof value.visibleText === "string" ? value.visibleText : null,
  };
}

export function normalizeVisual(value) {
  const neutral = { value: null, roles: [] };
  if (!object(value) ||
      !(value.value === null || (Number.isInteger(value.value) && value.value >= 1 && value.value <= 5)) ||
      !Array.isArray(value.roles) || value.roles.some((role) => !VISUAL_ROLES.includes(role))) {
    return neutral;
  }
  const roles = VISUAL_ROLES.filter((role) => value.roles.includes(role));
  return {
    value: value.value,
    roles: roles.length > 1 ? roles.filter((role) => role !== "other") : roles,
  };
}

const MEDIA_HOSTS = new Set(["pbs.twimg.com", "video.twimg.com", "ton.twimg.com"]);
const MEDIA_TYPES = new Set(["image", "video", "gif", "unknown"]);
const BLOCKED_QUERY = /^(token|auth|authorization|access[_-]?token|signature|sig|expires?|expiry|key|api[_-]?key|secret|cookie|session|sid|hmac|private|oauth|bearer|jwt)$/i;

export function normalizeMediaUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !MEDIA_HOSTS.has(url.hostname) ||
      /\/(profile_images|profile_banners|emoji|hashflags|sticky)\//i.test(url.pathname)) return null;
  const kept = [];
  for (const [key, val] of url.searchParams) {
    if (BLOCKED_QUERY.test(key)) return null;
    if (["format", "name"].includes(key.toLowerCase())) kept.push([key, val]);
  }
  url.search = "";
  url.hash = "";
  kept.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  for (const [key, val] of kept) url.searchParams.append(key, val);
  return url.toString();
}

function dimension(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function normalizeXMedia(media) {
  if (!Array.isArray(media)) return [];
  return media.flatMap((entry) => {
    if (!object(entry)) return [];
    const url = normalizeMediaUrl(entry.url);
    const previewUrl = normalizeMediaUrl(entry.previewUrl);
    if (!url && !previewUrl) return [];
    return [{
      type: MEDIA_TYPES.has(entry.type) ? entry.type : "unknown",
      url,
      previewUrl,
      altText: typeof entry.altText === "string" ? entry.altText : null,
      width: dimension(entry.width),
      height: dimension(entry.height),
    }];
  });
}
