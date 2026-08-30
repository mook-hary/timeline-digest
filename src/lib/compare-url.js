const DEFAULT_TRACKING_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "fbclid",
  "gclid",
  "gclsrc",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
];

function trackingSet(params) {
  const list = Array.isArray(params) ? params : DEFAULT_TRACKING_PARAMS;
  return new Set(list.map((param) => String(param).toLowerCase()));
}

export function normalizeUrlForCompare(value, options = {}) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (raw === "") return null;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }

  const host = url.hostname.replace(/\.$/, "").toLowerCase();
  const isDefaultPort =
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443") ||
    url.port === "";
  const port = isDefaultPort ? "" : `:${url.port}`;

  let pathname = url.pathname || "/";
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }

  const blocked = trackingSet(options.trackingParams);
  const pairs = [];
  for (const [key, val] of url.searchParams.entries()) {
    if (blocked.has(key.toLowerCase())) continue;
    pairs.push([key, val]);
  }
  pairs.sort((a, b) => {
    if (a[0] < b[0]) return -1;
    if (a[0] > b[0]) return 1;
    if (a[1] < b[1]) return -1;
    if (a[1] > b[1]) return 1;
    return 0;
  });

  const search = new URLSearchParams(pairs).toString();
  return `//${host}${port}${pathname}${search ? `?${search}` : ""}`;
}
