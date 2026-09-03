import { createOpenAiResponsesClient } from "./openai-client.js";
import { redactSecrets } from "./semantic-judge.js";

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;

export const DIGEST_WHY_BANNED_PHRASES = [
  "注目される",
  "注目されます",
  "注目すべき",
  "確認する必要がある",
  "見守る必要がある",
  "今後が注目される",
  "今後大きな影響",
  "大きな影響を与える可能性",
  "重要なニュース",
  "意義がある",
  "でしょう",
  "と考えられる",
];

export const DIGEST_META_BANNED_PHRASES = [
  "代表記事によれば",
  "入力によれば",
  "提供された情報では",
  "このニュースでは",
  "この要約では",
  "sourceによると",
];

function failed(error, extra = {}) {
  return {
    status: "failed",
    error,
    errorDetail: extra.errorDetail || null,
    headline: null,
    summary: null,
    whyItMatters: null,
  };
}

export function extractHttpUrls(text) {
  if (text == null) return [];
  const matches = String(text).match(URL_PATTERN);
  return matches ? [...new Set(matches)] : [];
}

export function generatedUrlsAreGrounded(generatedText, groundedInput) {
  const allowed = new Set(extractHttpUrls(groundedInput));
  for (const url of extractHttpUrls(generatedText)) {
    if (!allowed.has(url)) return false;
  }
  return true;
}

export function findBannedPhrase(text, phrases) {
  if (text == null) return null;
  const value = String(text);
  const lower = value.toLowerCase();
  for (const phrase of phrases) {
    if (!phrase) continue;
    if (/[A-Za-z]/.test(phrase)) {
      if (lower.includes(phrase.toLowerCase())) return phrase;
    } else if (value.includes(phrase)) {
      return phrase;
    }
  }
  return null;
}

export function validateDigestGeneration(raw, options = {}) {
  const headlineMin = options.headlineMinChars ?? 8;
  const headlineMax = options.headlineMaxChars ?? 80;
  const summaryMax = options.summaryMaxChars ?? 400;
  const whyMax = options.whyItMattersMaxChars ?? 200;
  const groundedInput = options.groundedInput ?? "";

  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return failed("invalid-json");
  }
  if (typeof raw.headline !== "string" || typeof raw.summary !== "string" || typeof raw.whyItMatters !== "string") {
    return failed("invalid-fields");
  }

  const headline = raw.headline.trim();
  const summary = raw.summary.trim();
  const whyItMatters = raw.whyItMatters.trim();
  if (!headline || !summary || !whyItMatters) {
    return failed("empty-fields");
  }
  if (headline.length < headlineMin || headline.length > headlineMax) {
    return failed("invalid-headline-length");
  }
  if (summary.length > summaryMax) {
    return failed("invalid-summary-length");
  }
  if (whyItMatters.length > whyMax) {
    return failed("invalid-why-length");
  }

  const generatedText = `${headline}\n${summary}\n${whyItMatters}`;
  if (!generatedUrlsAreGrounded(generatedText, groundedInput)) {
    return failed("ungrounded-url");
  }

  const whyBanned = findBannedPhrase(whyItMatters, DIGEST_WHY_BANNED_PHRASES);
  if (whyBanned) {
    return failed("banned-why-phrase");
  }
  const metaBanned = findBannedPhrase(generatedText, DIGEST_META_BANNED_PHRASES);
  if (metaBanned) {
    return failed("banned-meta-phrase");
  }

  return {
    status: "ok",
    error: null,
    errorDetail: null,
    headline,
    summary,
    whyItMatters,
  };
}

export function failedDigestGeneration(error) {
  const diagnostic = error && error.diagnostic ? error.diagnostic : null;
  const message =
    error && error.message ? String(error.message).split("\n")[0] : String(error);
  return failed(redactSecrets(message).slice(0, 300), { errorDetail: diagnostic });
}

export async function generateDigestItem(payload, generator, options = {}) {
  try {
    const raw = await generator(payload);
    return validateDigestGeneration(raw, {
      ...options,
      groundedInput: options.groundedInput ?? payload?.input ?? "",
    });
  } catch (error) {
    return failedDigestGeneration(error);
  }
}

export function createOpenAiDigestGenerator(options = {}) {
  const { complete } = createOpenAiResponsesClient({
    ...options,
    missingModelMessage: "Digest model is not configured",
  });
  return async function openaiDigestGenerator(payload) {
    return complete(payload);
  };
}
