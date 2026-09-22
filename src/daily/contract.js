// Fixed Daily path/policy contract. All paths are relative to the current work/.
export const FILES = {
  xRaw: "raw/x-news-feed.json", x: "normalized/x-news.json", xReceipt: "provenance/x.json",
  web: "normalized/web-news.json", webReceipt: "provenance/web.json",
  pool: "normalized/news-pool.json", cluster: "processed/news-clusters.json", clusterReview: "processed/news-clusters-review.json",
  semantic: "processed/news-semantic.json", semanticCache: "cache/semantic-judgments.json",
  evaluated: "processed/news-evaluated.json", evaluationCache: "cache/evaluation-judgments.json",
  selected: "processed/news-selected.json", selectReview: "processed/news-selected-review.json",
  digest: "processed/news-digest.json", markdown: "processed/news-digest.md", digestReview: "processed/news-digest-review.json", digestCache: "cache/digest-generations.json",
  candidates: "processed/references-candidates.json", references: "processed/references.json",
  manifest: "edition/manifest.json", editionDigest: "edition/news-digest.json", editionMarkdown: "edition/news-digest.md", editionReferences: "edition/references.json",
};
export const STAGE_ORDER = ["ingest:x", "ingest:web", "unify", "cluster", "semantic", "evaluate", "select", "digest", "references", "references:select", "validate-edition"];
export const DEGRADABLE = new Set(["ingest:web", "digest", "references"]);
export const AI_STAGES = new Set(["semantic", "evaluate", "digest"]);
export const OUTPUT_KEYS = {
  "ingest:x": ["xRaw", "x", "xReceipt"], "ingest:web": ["web", "webReceipt"],
  unify: ["pool"], cluster: ["cluster", "clusterReview"], semantic: ["semantic", "semanticCache"],
  evaluate: ["evaluated", "evaluationCache"], select: ["selected", "selectReview"],
  digest: ["digest", "markdown", "digestReview", "digestCache"], references: ["candidates"], "references:select": ["references"],
  "validate-edition": ["editionDigest", "editionMarkdown", "editionReferences", "manifest"],
};
export const DAILY_DIAGNOSTICS = new Set([
  "fetch_http", "fetch_timeout", "fetch_malformed", "fetch_source", "x_schema_invalid", "x_same_run_fetch_required",
  "x_collection_unverified", "x_collection_invalid", "x_collection_stale", "x_collection_future", "x_export_invalid", "x_export_before_collection", "x_export_future",
  "web_all_failed", "web_source_failed", "web_metadata_old", "semantic_incomplete", "evaluation_incomplete",
  "digest_fallback", "digest_failed", "references_empty", "edition_invalid", "ai_credentials_missing", "pipeline_failed",
]);
