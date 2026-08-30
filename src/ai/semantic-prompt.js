export const JUDGE_VERSION = "semantic-judge-v1";

export const SEMANTIC_JUDGMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    relationship: {
      type: "string",
      enum: ["same-event", "related-event", "different-event"],
    },
    confidence: { type: "number" },
    reason: { type: "string" },
  },
  required: ["relationship", "confidence", "reason"],
};

export const SEMANTIC_SYSTEM_PROMPT = `You classify the relationship between two news items.
Return only the JSON schema fields.

Definitions:
- same-event: both items report the same concrete event, announcement, accident, ruling, or decision. Example: two outlets covering the same person's same deportation.
- related-event: same theme or event series, but not the same concrete news item. Example: a product launch vs later market reaction.
- different-event: shared people, companies, or words, but different concrete news. Example: a politician's economy speech vs a later diplomatic meeting.

Rules:
- Judge same-event strictly.
- Shared person, company, or topic is not enough for same-event.
- Distinguish related-event from same-event.
- If unsure, choose different-event.
- Prefer precision over recall.
- Keep reason to one short sentence.`;

function clip(value, max = 400) {
  if (value == null) return null;
  const text = String(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

export function judgeItemPayload(item, host) {
  return {
    title: item.title ?? null,
    summary: clip(item.summary),
    category: item.category ?? null,
    provider: item.source?.provider ?? null,
    publishedAt: item.publishedAt ?? null,
    host: host ?? null,
  };
}

export function buildJudgeUserMessage(itemA, itemB, hostA, hostB) {
  return JSON.stringify(
    {
      itemA: judgeItemPayload(itemA, hostA),
      itemB: judgeItemPayload(itemB, hostB),
    },
    null,
    2
  );
}
