import { FetchError } from "./errors.js";

export async function fetchJson(url, { fetchImpl = globalThis.fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
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

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new FetchError(`Invalid JSON from ${url}`, {
      cause: error,
      code: "INVALID_JSON",
    });
  }
}
