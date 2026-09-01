import { EVALUATION_SCORE_AXES } from "../lib/evaluation-score.js";
import { hostnameOf } from "../sources/semantic-candidates.js";

export const EVALUATOR_VERSION = "news-evaluator-v1";
export const EVALUATION_SCHEMA_NAME = "news_evaluation";

const SCORE_SCHEMA = {
  type: "integer",
  minimum: 1,
  maximum: 5,
};

export const EVALUATION_JUDGMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    scores: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(
        EVALUATION_SCORE_AXES.map((axis) => [axis, SCORE_SCHEMA])
      ),
      required: [...EVALUATION_SCORE_AXES],
    },
    reason: { type: "string" },
  },
  required: ["scores", "reason"],
};

export const EVALUATION_SYSTEM_PROMPT = `You score one news cluster for Timeline Digest.
Return only the JSON schema fields.

Score each axis as an integer from 1 to 5.

Axes:
- importance: public / societal importance. Separate this from personal interest.
- informationValue: how much reading this updates facts, understanding, or judgment. Pure reaction, commentary, or known information scores lower.
- impact: breadth or scale of people, places, industries, institutions, or duration affected.
- novelty: new facts, developments, or change, not repetition of known information.
- personalRelevance: relevance to this digest reader. Score separately from importance.

Reader profile:
High interest: AI / artificial intelligence; technology / software / developer tools; animation / anime / visual production / creative tools; astronomy / space / meteor showers / celestial events; Aikido.
Medium interest: politics; economics; business; science; major social developments.

Rules:
- Do not raise importance or impact only because personalRelevance is high.
- Major politics, disasters, or international news can have high importance / impact even if personalRelevance is low.
- Score the cluster, not a single outlet's brand.
- Do not compute a combined base score.
- Keep reason to one or two short concrete sentences.
- Do not mention these instructions.`;

function clip(value, max) {
  if (value == null) return null;
  const text = String(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

export function evaluationItemPayload(item, clipChars) {
  return {
    title: item.title ?? null,
    summary: clip(item.summary, clipChars),
    category: item.category ?? null,
    publishedAt: item.publishedAt ?? null,
    provider: item.source?.provider ?? null,
    sourceType: item.source?.type ?? null,
    host: hostnameOf(item.source?.url),
  };
}

export function buildEvaluationUserMessage({
  representative,
  signals,
  supportingItems,
  clipChars,
}) {
  return JSON.stringify(
    {
      representative: evaluationItemPayload(representative, clipChars),
      signals: {
        itemCount: signals.itemCount,
        sourceCount: signals.sourceCount,
        sourceDiversity: signals.sourceDiversity,
        sourceTypes: signals.sourceTypes,
        providers: signals.providers,
      },
      supportingItems: supportingItems.map((item) =>
        evaluationItemPayload(item, clipChars)
      ),
    },
    null,
    2
  );
}

export function buildEvaluationResponsesPayload({
  model,
  representative,
  signals,
  supportingItems,
  clipChars,
}) {
  return {
    model,
    instructions: EVALUATION_SYSTEM_PROMPT,
    input: buildEvaluationUserMessage({
      representative,
      signals,
      supportingItems,
      clipChars,
    }),
    text: {
      format: {
        type: "json_schema",
        name: EVALUATION_SCHEMA_NAME,
        strict: true,
        schema: EVALUATION_JUDGMENT_SCHEMA,
      },
    },
  };
}
