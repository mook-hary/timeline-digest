import { XMLParser } from "fast-xml-parser";
import { IngestError } from "../lib/errors.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  processEntities: false,
  htmlEntities: false,
  allowBooleanAttributes: true,
  trimValues: true,
  ignoreDeclaration: true,
  isArray: (name) =>
    name === "item" ||
    name === "entry" ||
    name === "category" ||
    name === "link",
});

export function asArray(value) {
  if (value == null || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

export function textOf(node) {
  if (node == null || node === "") return null;
  if (typeof node === "string" || typeof node === "number") {
    const text = String(node).trim();
    return text || null;
  }
  if (typeof node !== "object") return null;
  if (node["#text"] != null) return textOf(node["#text"]);
  return null;
}

function attr(node, name) {
  if (!node || typeof node !== "object") return null;
  const value = node[`@_${name}`];
  return value == null ? null : String(value);
}

function firstText(...nodes) {
  for (const node of nodes) {
    const text = textOf(node);
    if (text) return text;
  }
  return null;
}

function firstHref(nodes) {
  for (const node of asArray(nodes)) {
    const href = attr(node, "href") || textOf(node);
    if (href) return href;
  }
  return null;
}

function firstCategory(node) {
  for (const category of asArray(node && node.category)) {
    const value = textOf(category) || attr(category, "term") || attr(category, "label");
    if (value) return value;
  }
  return null;
}

export function parseFeedXml(xml) {
  if (typeof xml !== "string" || xml.trim() === "") {
    throw new IngestError("Feed XML is empty", { code: "PARSE" });
  }

  let parsed;
  try {
    parsed = parser.parse(xml.replace(/^\uFEFF/, "").trim());
  } catch (error) {
    throw new IngestError(`XML parse failed: ${error.message}`, {
      cause: error,
      code: "PARSE",
    });
  }

  if (parsed && parsed.rss) {
    return parseRss(parsed.rss);
  }
  if (parsed && parsed.feed) {
    return parseAtom(parsed.feed);
  }

  throw new IngestError("Unsupported feed format (expected RSS 2.0 or Atom)", {
    code: "PARSE",
  });
}

function parseRss(rss) {
  const channel = rss.channel;
  if (!channel || typeof channel !== "object") {
    throw new IngestError("RSS feed is missing channel", { code: "PARSE" });
  }

  return {
    format: "rss",
    title: textOf(channel.title),
    updatedAt: firstText(channel.lastBuildDate, channel.pubDate),
    items: asArray(channel.item).map(parseRssItem),
  };
}

function parseRssItem(item) {
  return {
    title: textOf(item.title),
    url: firstHref(item.link),
    guid: firstText(item.guid),
    summary: firstText(
      item.description,
      item["content:encoded"],
      item.content
    ),
    publishedAt: firstText(item.pubDate, item["dc:date"]),
    category: firstCategory(item),
    authorName: firstText(item["dc:creator"], item.author),
  };
}

function parseAtom(feed) {
  return {
    format: "atom",
    title: textOf(feed.title),
    updatedAt: firstText(feed.updated),
    items: asArray(feed.entry).map(parseAtomEntry),
  };
}

function parseAtomEntry(entry) {
  const links = asArray(entry.link);
  const alternate = links.find((link) => {
    const rel = attr(link, "rel");
    return !rel || rel === "alternate";
  });

  return {
    title: textOf(entry.title),
    url: firstHref(alternate || links),
    guid: firstText(entry.id),
    summary: firstText(entry.summary, entry.content),
    publishedAt: firstText(entry.published, entry.updated),
    category: firstCategory(entry),
    authorName: atomAuthorName(entry),
  };
}

function atomAuthorName(entry) {
  for (const author of asArray(entry.author)) {
    const name = textOf(author && author.name) || textOf(author);
    if (name) return name;
  }
  return null;
}
