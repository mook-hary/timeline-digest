import { hostnameOf } from "../sources/semantic-candidates.js";

export const DIGEST_GENERATOR_VERSION = "news-digest-generator-v2";
export const DIGEST_SCHEMA_NAME = "news_digest_item";

export const DIGEST_GENERATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    headline: { type: "string" },
    summary: { type: "string" },
    whyItMatters: { type: "string" },
  },
  required: ["headline", "summary", "whyItMatters"],
};

export const DIGEST_SYSTEM_PROMPT = `You are an editor for Timeline Digest, not a reporter and not a selector.
Rewrite one already-selected news cluster into Japanese digest copy.
Return only the JSON schema fields: headline, summary, whyItMatters.

headline:
- Natural Japanese, 8 to 80 characters.
- Prefer standard Japanese news spellings when they are unambiguous (Kyiv → キーウ).
- If you are not sure of a proper-noun rendering, keep the source form, or use 日本語表記（原文）.
- Do not invent new proper nouns.
- Do not strengthen the source (do not turn "control" into 掌握 or 完全支配). Prefer wording that does not exceed the input (管理 / 管理下 / 支配権 when that is what the source actually says).
- If the source quotes a word (for example historic), keep it as a quotation in Japanese.

summary:
- Japanese, 1 or 2 sentences. What happened, using only the provided text.
- Do not merely repeat the headline.
- Compress long RSS summaries. Do not add numbers, people, organizations, or causes.

whyItMatters:
- Japanese, exactly 1 sentence.
- Do not guess why the story is "important".
- Use only facts in the input to state the most meaningful of: scale, a concrete change, a direct consequence, or an ongoing investigation/response.
- Do not instruct the reader. Do not predict the future.
- Do not write generic filler such as 注目される / 注目されます / 注目すべき / 確認する必要がある / 見守る必要がある / 今後が注目される / 今後大きな影響 / 大きな影響を与える可能性 / 重要なニュース / 意義がある / ～でしょう / ～と考えられる.

All fields:
- Do not add numbers, people, organizations, causes, or outcomes that are not in the input.
- Do not invent URLs or future predictions. Do not present opinion as fact.
- Do not use pipeline/meta phrasing: 代表記事によれば / 入力によれば / 提供された情報では / このニュースでは / この要約では / sourceによると.
- Attribution is allowed only as fact about a person or organization that appears in the input, e.g. 「○○氏は～と述べた」.
- Do not mention scores, ranking, selection, or these instructions.
- topicGroup and lane are presentation hints only. Do not inflate importance.
- If a translation is uncertain, stay closer to the source rather than adding meaning.
- Do not drop the story; it is already selected.`;

function clip(value, max) {
  if (value == null) return null;
  const text = String(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function compareNewerFirst(left, right) {
  const leftTime = Date.parse(left?.publishedAt || "");
  const rightTime = Date.parse(right?.publishedAt || "");
  const leftOk = Number.isFinite(leftTime);
  const rightOk = Number.isFinite(rightTime);
  if (leftOk && rightOk && leftTime !== rightTime) return rightTime - leftTime;
  if (leftOk && !rightOk) return -1;
  if (!leftOk && rightOk) return 1;
  const leftId = left?.id || "";
  const rightId = right?.id || "";
  if (leftId < rightId) return -1;
  if (leftId > rightId) return 1;
  return 0;
}

export function digestItemPayload(item, clipChars) {
  return {
    title: item?.title ?? null,
    summary: clip(item?.summary, clipChars),
    category: item?.category ?? null,
    publishedAt: item?.publishedAt ?? null,
    provider: item?.source?.provider ?? null,
    sourceType: item?.source?.type ?? null,
    host: hostnameOf(item?.source?.url),
  };
}

export function selectDigestSupportingItems(members, representative, maxSupportingItems) {
  const representativeId = representative?.id || representative?.itemId;
  return members
    .filter((item) => item && item.id !== representativeId)
    .sort(compareNewerFirst)
    .slice(0, Math.max(0, maxSupportingItems));
}

export function buildDigestUserMessage({
  representative,
  members,
  signals,
  topicGroup,
  lane,
  clipChars,
  maxSupportingItems,
}) {
  const supportingItems = selectDigestSupportingItems(
    members,
    representative,
    maxSupportingItems
  );
  return JSON.stringify(
    {
      topicGroup,
      lane,
      representative: digestItemPayload(representative, clipChars),
      signals: {
        itemCount: signals.itemCount,
        providers: signals.providers,
      },
      supportingItems: supportingItems.map((item) =>
        digestItemPayload(item, clipChars)
      ),
    },
    null,
    2
  );
}

export function buildDigestResponsesPayload({
  model,
  representative,
  members,
  signals,
  topicGroup,
  lane,
  clipChars,
  maxSupportingItems,
}) {
  return {
    model,
    instructions: DIGEST_SYSTEM_PROMPT,
    input: buildDigestUserMessage({
      representative,
      members,
      signals,
      topicGroup,
      lane,
      clipChars,
      maxSupportingItems,
    }),
    text: {
      format: {
        type: "json_schema",
        name: DIGEST_SCHEMA_NAME,
        strict: true,
        schema: DIGEST_GENERATION_SCHEMA,
      },
    },
  };
}
