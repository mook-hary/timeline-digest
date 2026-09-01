import OpenAI from "openai";
import { AiError } from "../lib/errors.js";
import {
  extractOpenAiErrorDiagnostic,
  formatOpenAiErrorDiagnostic,
  isRetryableHttpStatus,
} from "./openai-error.js";
import {
  SEMANTIC_JUDGMENT_SCHEMA,
  SEMANTIC_SYSTEM_PROMPT,
  buildJudgeUserMessage,
} from "./semantic-prompt.js";
import { hostnameOf } from "../sources/semantic-candidates.js";

const SCHEMA_NAME = "semantic_judgment";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function extractOutputText(response) {
  if (response && typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }
  if (!response || !Array.isArray(response.output)) {
    throw new AiError("OpenAI response missing content", { code: "AI_RESPONSE" });
  }
  const chunks = [];
  for (const item of response.output) {
    if (!item || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (content && content.type === "output_text" && content.text) {
        chunks.push(content.text);
      }
    }
  }
  const text = chunks.join("").trim();
  if (!text) {
    throw new AiError("OpenAI response missing content", { code: "AI_RESPONSE" });
  }
  return text;
}

export function buildSemanticResponsesPayload({ model, itemA, itemB }) {
  return {
    model,
    instructions: SEMANTIC_SYSTEM_PROMPT,
    input: buildJudgeUserMessage(
      itemA,
      itemB,
      hostnameOf(itemA.source?.url),
      hostnameOf(itemB.source?.url)
    ),
    text: {
      format: {
        type: "json_schema",
        name: SCHEMA_NAME,
        strict: true,
        schema: SEMANTIC_JUDGMENT_SCHEMA,
      },
    },
  };
}

function wrapProviderError(error) {
  if (error instanceof AiError) return error;
  const diagnostic = extractOpenAiErrorDiagnostic(error);
  return new AiError(formatOpenAiErrorDiagnostic(diagnostic), {
    code: diagnostic.httpStatus != null ? "AI_HTTP" : "AI",
    diagnostic,
    status: diagnostic.httpStatus ?? undefined,
    cause: error,
  });
}

function isRetryableError(error) {
  const status = error?.diagnostic?.httpStatus ?? error?.status;
  if (status != null) return isRetryableHttpStatus(status);
  return error?.code !== "AI_RESPONSE";
}

export function createOpenAiResponsesClient(options = {}) {
  const apiKey = options.apiKey;
  const model = options.model;
  const timeoutMs = options.timeoutMs ?? 30000;
  const maxRetries = options.maxRetries ?? 1;
  const sleepFn = options.sleep || sleep;
  const missingModelMessage = options.missingModelMessage || "Model is not configured";

  if (!apiKey) {
    throw new AiError("OPENAI_API_KEY is not set");
  }
  if (!model) {
    throw new AiError(missingModelMessage);
  }

  const Client = options.OpenAI || OpenAI;
  const client =
    options.client ||
    new Client({
      apiKey,
      timeout: timeoutMs,
    });

  async function complete(payload) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const response = await client.responses.create(payload);
        const text = extractOutputText(response);
        try {
          return JSON.parse(text);
        } catch (error) {
          throw new AiError("OpenAI response was not valid JSON", {
            code: "AI_RESPONSE",
            cause: error,
          });
        }
      } catch (error) {
        lastError = wrapProviderError(error);
        if (attempt < maxRetries && isRetryableError(lastError)) {
          await sleepFn(250 * (attempt + 1));
          continue;
        }
        throw lastError;
      }
    }
    throw lastError;
  }

  return { model, client, complete };
}

export function createOpenAiJudge(options = {}) {
  const { model, complete } = createOpenAiResponsesClient({
    ...options,
    missingModelMessage: "Semantic model is not configured",
  });

  return async function openaiJudge({ itemA, itemB }) {
    return complete(buildSemanticResponsesPayload({ model, itemA, itemB }));
  };
}

export function createOpenAiEvaluator(options = {}) {
  const { complete } = createOpenAiResponsesClient({
    ...options,
    missingModelMessage: "Evaluation model is not configured",
  });

  return async function openaiEvaluator(payload) {
    return complete(payload);
  };
}
