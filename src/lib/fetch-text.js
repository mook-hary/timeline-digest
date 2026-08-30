import { FetchError } from "./errors.js";

const DEFAULT_HEADERS = {
  Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
  "User-Agent": "timeline-digest/0.1",
};

const MAX_BODY_BYTES = 8 * 1024 * 1024;

export async function fetchText(url, { fetchImpl = globalThis.fetch, headers } = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { ...DEFAULT_HEADERS, ...headers },
    });
  } catch (error) {
    throw new FetchError(`Network failure fetching ${url}: ${error.message}`, {
      cause: error,
      code: "NETWORK",
    });
  }

  if (!response || typeof response.ok !== "boolean") {
    throw new FetchError(`Invalid fetch response from ${url}`, {
      code: "FETCH",
    });
  }

  if (!response.ok) {
    throw new FetchError(`HTTP ${response.status} fetching ${url}`, {
      code: "HTTP_STATUS",
      status: response.status,
    });
  }

  let text;
  try {
    text = await response.text();
  } catch (error) {
    throw new FetchError(`Failed to read body from ${url}: ${error.message}`, {
      cause: error,
      code: "NETWORK",
    });
  }

  if (typeof text !== "string") {
    throw new FetchError(`Invalid body from ${url}`, { code: "FETCH" });
  }

  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    throw new FetchError(`Feed body exceeds ${MAX_BODY_BYTES} bytes from ${url}`, {
      code: "FETCH",
    });
  }

  return text;
}
