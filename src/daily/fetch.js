// Request and body share one deadline. Native fetch honors AbortSignal; the
// enclosing stage worker is the final termination boundary. No retries here.
export class DailyError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function boundedFetch({ fetchImpl = globalThis.fetch, timeoutMs, now = () => new Date().toISOString(), observations = new Map() }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new DailyError("invalid_fetch_policy");
  return async (url, options = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let code = "fetch_source";
    try {
      const response = await fetchImpl(url, { ...options, signal: controller.signal });
      if (!response || typeof response.ok !== "boolean" || typeof response.text !== "function") throw new DailyError("fetch_malformed");
      if (!response.ok) throw new DailyError("fetch_http");
      const body = await response.text();
      if (controller.signal.aborted) throw new DailyError("fetch_timeout");
      if (typeof body !== "string" || Buffer.byteLength(body) > 8 * 1024 * 1024) throw new DailyError("fetch_malformed");
      observations.set(url, { status: "succeeded", fetchedAt: now() });
      return { ok: true, status: response.status, text: async () => body };
    } catch (error) {
      if (controller.signal.aborted) code = "fetch_timeout";
      else if (error instanceof DailyError) code = error.code;
      observations.set(url, { status: "failed", diagnostic: code });
      throw new DailyError(code);
    } finally { clearTimeout(timer); controller.abort(); }
  };
}
