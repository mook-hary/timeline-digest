function escapeMd(value) {
  return String(value ?? "").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

function formatSourceLine(item) {
  const provider = item.representative?.source?.provider || "source";
  const url = item.representative?.source?.url;
  if (url) {
    return `  出典: [${escapeMd(provider)}](${url})`;
  }
  return `  出典: ${provider}`;
}

function formatArticle(item) {
  const lines = [`- **${item.headline || "(untitled)"}**`];
  if (item.summary) {
    lines.push(`  ${item.summary}`);
  }
  if (item.whyItMatters) {
    lines.push(`  なぜ重要: ${item.whyItMatters}`);
  }
  lines.push(formatSourceLine(item));
  const extra = Math.max(0, (item.sources || []).length - 1);
  if (extra > 0) {
    lines.push(`  他 ${extra} ソース`);
  }
  return lines.join("\n");
}

export function renderDigestMarkdown(document) {
  const major = document.items.filter((item) => item.lane === "major");
  const personal = document.items.filter((item) => item.lane === "personal");
  const lines = [
    `# Timeline Digest`,
    "",
    document.digestDate,
    "",
    "## 主要ニュース",
    "",
  ];
  if (major.length === 0) {
    lines.push("(なし)", "");
  } else {
    for (const item of major) {
      lines.push(formatArticle(item), "");
    }
  }
  lines.push("## 関心ニュース", "");
  if (personal.length === 0) {
    lines.push("(なし)", "");
  } else {
    for (const item of personal) {
      lines.push(formatArticle(item), "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
