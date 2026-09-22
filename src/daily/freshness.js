import { DailyError } from "./fetch.js";

// RFC3339 subset: explicit zone, real calendar date, no local/ambiguous dates.
export function parseTimestamp(value) {
  const m = typeof value === "string" && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m) throw new DailyError("invalid_timestamp");
  const [, y, month, day, hour, minute, second, zone] = m;
  const days = new Date(Date.UTC(Number(y), Number(month), 0)).getUTCDate();
  if (+month < 1 || +month > 12 || +day < 1 || +day > days || +hour > 23 || +minute > 59 || +second > 59 ||
    (zone !== "Z" && (+zone.slice(1, 3) > 23 || +zone.slice(4) > 59))) throw new DailyError("invalid_timestamp");
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new DailyError("invalid_timestamp");
  return time;
}

export function validateFreshnessPolicy(config) {
  const x = config?.freshness?.x, web = config?.freshness?.web;
  if (x?.field !== "collectionCompletedAt" || !Number.isFinite(x.maxAgeHours) || x.maxAgeHours <= 0 ||
    !Number.isFinite(x.futureToleranceMinutes) || x.futureToleranceMinutes < 0 ||
    !Number.isFinite(web?.oldMetadataDiagnosticDays) || web.oldMetadataDiagnosticDays <= 0 ||
    !Number.isSafeInteger(config?.fetch?.timeoutMs) || config.fetch.timeoutMs <= 0 || config.fetch.timeoutMs > 2147483647) throw new DailyError("invalid_freshness_policy");
}

export function assessXFreshness(feed, { now, policy, retrieval, runId, startedAt }) {
  if (!retrieval || retrieval.status !== "succeeded" || retrieval.runId !== runId ||
    parseTimestamp(retrieval.fetchedAt) < parseTimestamp(startedAt)) throw new DailyError("x_same_run_fetch_required");
  if (feed.collectionCompletedAt == null) throw new DailyError("x_collection_unverified");
  let collected, exported;
  try { collected = parseTimestamp(feed.collectionCompletedAt); }
  catch { throw new DailyError("x_collection_invalid"); }
  try { exported = parseTimestamp(feed.generatedAt); }
  catch { throw new DailyError("x_export_invalid"); }
  const current = parseTimestamp(now);
  const tolerance = policy.futureToleranceMinutes * 60000;
  if (parseTimestamp(retrieval.fetchedAt) > current + tolerance) throw new DailyError("x_same_run_fetch_required");
  if (current - collected > policy.maxAgeHours * 3600000) throw new DailyError("x_collection_stale");
  if (collected - current > tolerance) throw new DailyError("x_collection_future");
  if (exported < collected - tolerance) throw new DailyError("x_export_before_collection");
  if (exported - current > tolerance) throw new DailyError("x_export_future");
  return { collectionCompletedAt: feed.collectionCompletedAt, generatedAt: feed.generatedAt, assessedAt: now };
}
