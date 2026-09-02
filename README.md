# timeline-digest

複数の公開ニュースソースを、共通schemaへ取り込み、重複整理・編集判断を経て Timeline Digest を作るための統合層です。

現在実装しているのは次までです。

- X News Feed（公開 JSON）
- Webニュースの **RSS / Atom**（設定ファイルの公開Feed）
- Unified News Pool（normalized source の merge）
- News Clusters（deterministic。説明可能な relationship / cluster。item は削除しない）
- Semantic Clusters（candidate pair だけを AI 判定。deterministic cluster は上書きしない）
- News Evaluation（cluster 単位の representative / deterministic signals + 任意の 5軸 AI 評価）
- Editorial Select（local deterministic。Digest 候補の選定。AI なし）

Web検索、News API、本文スクレイピング、source横断の重複削除、ランキング、Digest生成はまだ行いません。RSS/Atom は Webニュース入力の **最初の一方式** であり、唯一の取得方式ではありません。Unify は編集ではなく、normalized item を損失なく束ねる段階です。Cluster は dedupe ではなく、同じ Pool item を残したまま関係だけを記録します。全 item の自由分類や embedding は使いません。Semantic 層の AI は、ローカル生成した候補 pair の関係分類だけです。

## 責務の境界

| 層 | 担当 |
| --- | --- |
| [x-timeline-collector](https://github.com/mook-hary/x-timeline-collector) | X取得、Daily Scope、Analyze、AI Analyze / Enrich、Public News Feed の公開 |
| **timeline-digest** | 公開Feedの取得、検証、内部共通schemaへの変換、将来の複数source統合 |

このリポジトリは x-timeline-collector の内部ファイル（Chrome profile、cookie、`timeline.json`、`daily-enriched.json` など）を参照しません。X は公開 `news-feed.json` だけを読みます。Web は `config/web-sources.json` に書いた公開 RSS/Atom URL だけを読みます。ユーザー入力URLをそのまま fetch する汎用HTTP proxyにはしません。OpenAI API は Semantic 層の任意実行（`--apply-ai`）だけに使い、キーは環境変数 `OPENAI_API_KEY` のみです。Semantic CLI はリポジトリ root の `.env` を dotenv で読みます（既に設定済みの環境変数は上書きしません）。リポジトリへキーは保存しません。

## 入力

### X News Feed

https://mook-hary.github.io/x-timeline-collector/news-feed.json

```bash
npm run ingest:x
```

1. HTTP で公開Feedを取得
2. schema を検証（失敗したら即終了）
3. raw JSON を保存
4. 内部共通 News Item へ normalize
5. normalized JSON を保存

成功時の表示例:

```
X Feed:
fetched: 33
normalized: 33
generatedAt: 2026-08-30T12:04:35.734Z
```

X は編集フィルタを行いません。Feed が N 件なら normalized も N 件です。

### Webニュース（RSS / Atom）

設定: `config/web-sources.json`

```bash
npm run ingest:web
```

1. 設定を読み、`enabled: true` の source を対象にする
2. 各Feedを HTTP 取得
3. raw XML を source ごとに保存
4. RSS 2.0 / Atom を parse し、共通 News Item へ normalize
5. 成功分をまとめて normalized JSON へ保存

表示例:

```
Web News:

sources: 4
success: 4
failed: 0
items: 87

Source:
NHK 主要ニュース: 25
BBC World: 20
```

Web側の scores はまだ無いので、すべて `null` です。AI summary / category / importance は行いません。source を跨いだ同一事件の重複削除もしません。

### Unified News Pool

設定: `config/unify-inputs.json`

```bash
npm run unify
```

normalized 済みの X / Web output を読み、共通schemaを検証して `data/normalized/news-pool.json` へまとめます。

- 入力 item は落とさない（filter / dedupe / ranking / AI なし）
- 同一 `item.id` が input 間で衝突したら fail fast（silent dedupe しない）
- `source.url` が同じでも `item.id` が違えば両方保持する
- 並び順は `publishedAt` 降順 → `collectedAt` 降順 → `id`。null / 解析不能な日時は末尾
- stats（input数、総件数、type別、provider別）は **items から計算** する
- 設定で `required: true` の input ファイルが無い場合は fail（X だけで「統合成功」に見せない）
- 入力の `generatedAt` が古くても除外しない

成功表示例:

```
Unified News Pool:

inputs: 2
items: 96

Type:
web: 63
x: 33

Provider:
bbc-world: 36
...
```

将来 `astronomy-news.json` などを足す場合は、unify コードへ source 固有分岐を増やさず `config/unify-inputs.json` に descriptor を追加します。

### News Clusters

設定: `config/cluster.json`

```bash
npm run cluster
```

`data/normalized/news-pool.json` を読み、item を削除せず relationship / cluster を `data/processed/` へ書きます。news-pool が無ければ fail します。上流の ingest / unify は自動実行しません。

- **dedupe ではない。** 全 item が必ずどれか一つの cluster に所属する（関係が無ければ singleton）
- 比較用に URL / title を normalize するが、元の `source.url` / `title` は書き換えない
- URL: hostname 小文字、default port 除去、fragment 除去、trailing slash、既知の tracking query（`utm_*`, `fbclid`, `gclid` 等）のみ除去。未知の query は残す。parse 不能なら same-url に使わない
- X の `source.url` は投稿 URL として扱う。本文から外部記事 URL は抽出しない
- title: Unicode NFKC、lowercase、空白畳み、句読点除去。日本語の文字は残す。空/null は title 判定対象外
- similarity は文字 3-gram の Dice 係数。しきい値は `config/cluster.json` の `title.similarityThreshold`（初期 0.9）。短い title は対象外。**precision 優先**（別事件の誤結合を避ける。取りこぼしは許容）
- relationship の `confidence` は AI 確率ではなく、rule の強さ（same-url=1.0、same-title=0.98、title-similarity=Dice そのもの）
- cluster は same-url / 十分な長さの same-title / 高 similarity の connected component。similarity しきい値が高いため、transitive merge はほぼ同一タイトルの連鎖に限られる
- cluster ID は `cluster:<sha256(sorted itemIds)>`。入力順では変わらない
- 出力: `data/processed/news-clusters.json` と、multi-item 確認用 `data/processed/news-clusters-review.json`
- Semantic 層はこのファイルを上書きしない。別 output を使う

成功表示例:

```
News Clusters:

items: 96
clusters: 91
multi-item: 4
singletons: 87
relationships: 6

Relationship:
same-url: 2
same-title: 1
title-similarity: 3
```

### Semantic Clusters

設定: `config/semantic.json`

AI に全 item を自由分類させません。ローカルの candidate generation が作った pair だけを判定します。deterministic cluster（`news-clusters.json`）は独立 layer として残し、上書きしません。

```bash
# どちらも AI なし（デフォルトは dry-run）
npm run semantic
npm run semantic -- --dry-run

# 実 AI。--limit は今回の新規 request 上限（cache hit は数えない）
npm run semantic -- --apply-ai --limit 1
npm run semantic -- --apply-ai --limit 10
npm run semantic -- --apply-ai
```

`--dry-run` と `--apply-ai` が両方ある場合は dry-run が勝ちます。確認のつもりで CLI を叩いても API は呼びません。`--limit 0` / `--limit -1` / `--limit abc` は明示 error です。

#### 目的

Unified News Pool → cheap deterministic candidate generation → semantic judge → semantic relationships → semantic clusters。

#### AI の責務

2つの News Item の関係分類だけです。

| relationship | 意味 | cluster |
| --- | --- | --- |
| `same-event` | 同じ具体的出来事・発表・事故・決定などを別 source が報じている | **strong edge**。membership を結合する |
| `related-event` | 同一テーマ / 出来事系列だが、同じ具体的ニュースではない | relationship として保存する。**結合しない** |
| `different-event` | 人物・企業・単語が共通していても別の具体的ニュース | 診断 / cache 用に保存してよい。**結合しない** |

`same-event` は厳しく判定します。人物 / 企業 / テーマ一致だけでは `same-event` にしません。不明なら `different-event` 寄りです（precision 優先）。

A same-event B かつ B related-event C でも、A/B/C 全部が同じ cluster にはなりません。

#### Candidate generation

全 pair は送りません（例: 96 items → 4560 pairs）。AI 前にローカルで候補を絞ります。

候補信号:

- title 3-gram Dice
- normalized title token overlap（日本語は CJK bigram も含む）
- proper noun / capitalized phrase / カタカナ連続
- URL hostname
- publication time distance
- category
- provider の違い

候補になっただけでは relationship 確定ではありません。しきい値は `config/semantic.json` の `candidate` です。初期値の例:

- `minTitleSimilarity`: 0.3（deterministic cluster の 0.9 より広い）
- `minTokenOverlap`: 0.25（かつ proper noun 共有 1 以上）
- `minSharedProperNouns`: 2
- `maxCandidatesPerItem`: 5
- `maxTotalCandidates`: 200
- `maxPublishedHoursApart`: 168（両方に timestamp がある場合のみ。null は落とさない）

候補スコア（`candidateScore`）は「同一 / 関連 event である可能性」の優先度だけです。editorial / importance ではありません。

#### Cost guard

- `maxTotalCandidates` で候補数を上限する
- デフォルト CLI は AI なし
- 実実行は `--apply-ai` のみ
- OpenAI は Chat Completions ではなく Responses API（`responses.create`）。`instructions` + `input` と `text.format.json_schema`。`temperature` は送らない
- `--limit N` は今回新しく AI へ送る最大 request 数。cache hit は含めない
- limit 外の candidate は `status: unjudged`。`different-event` にはしない。same-event merge にも使わない
- 同じ pair は cache を再利用する

dry-run 出力例:

```
News Semantic dry-run:

items: 96
candidates: N
cache hits: 0
estimated AI requests: N

Top candidates:
1. score=... dice=... time=...
   the-verge | ...
   bbc-world | ...
```

#### Cache

`data/cache/semantic-judgments.json`

key は決定論的です。sorted item IDs、title/summary 等の content hash、model、judgeVersion を含めます。item 内容や model / judgeVersion が変わると miss します。API key は保存しません。write は atomic です。ok 判定だけ cache し、failure は再試行できます。

#### Failure policy

- pair 単位 failure: `status: failed`。relationship は確定しない。`error` は短い診断文字列、`errorDetail` は HTTP status / type / code / param / message。secret / Authorization / stack は保存しない
- invalid enum / confidence / reason は failed。`same-event` 扱いしない
- AI 失敗でも `news-clusters.json` は変更しない
- semantic output は生成してよいが、failed pair は merge しない
- `--apply-ai` で全 pair 失敗: exit `1`
- 一部失敗: exit `2`
- dry-run / 全成功: exit `0`
- news-pool 欠落、または `--apply-ai` で `OPENAI_API_KEY` なし: exit `1`

#### Conflict detection

`same-event` の connected component 内に明示的な `different-event` がある場合、silent にはしません。diagnostic conflict を記録し、その merge は保留します。

#### Input / output

| path | 内容 |
| --- | --- |
| `config/semantic.json` | model / judgeVersion / candidate caps |
| `data/normalized/news-pool.json` | 入力 |
| `data/processed/news-semantic-candidates.json` | dry-run の候補 |
| `data/processed/news-semantic.json` | `--apply-ai` の judgments / clusters |
| `data/cache/semantic-judgments.json` | 判定 cache |

AI へ送るのは title / summary（短い clip）/ category / provider / publishedAt / hostname 程度です。本文全文は送りません。

#### OPENAI_API_KEY

- repo へ保存しない
- `.env` は commit しない（`.gitignore`）
- テンプレは `.env.example`（`cp .env.example .env`）
- Semantic CLI（`npm run semantic`）起動時に root `.env` を dotenv で `process.env` へ載せる。既にシェル / CI で入っている値は上書きしない
- キー自体は従来どおり `process.env.OPENAI_API_KEY` から取得する
- log しない
- News Feed content 以外の秘密情報は送らない
- 実 AI の前に必ず dry-run して候補数を確認する

model 解決順（変更なし）: `SEMANTIC_MODEL` → `OPENAI_MODEL` → `config/semantic.json` の `model`。コードへ散在させません。config の値は fallback / default です。

`OPENAI_MODEL` は x-timeline-collector と同じ変数名です。`SEMANTIC_MODEL` が未設定なら、クローラー側 `.env` と同じ `OPENAI_MODEL` でも semantic の model を指定できます。`.env.example` では `SEMANTIC_MODEL=gpt-5-mini` を推奨しています。

## failure policy

| 対象 | 失敗時 |
| --- | --- |
| X ingest | HTTP / JSON / schema 失敗で exit `1`。既存 raw / normalized は成功扱いにしない |
| Web 設定エラー（id重複、JSON不正、enabled source なし） | 開始前に失敗。exit `1` |
| Web の一部 source 失敗 | 成功した source は保存する。失敗は表示する。exit `2` |
| Web の全 source 失敗 | normalized を成功として書かない。exit `1` |
| Unify | required input 欠落、schema 不正、item.id 衝突で exit `1`。壊れた pool JSON は書かない |
| Cluster | news-pool 欠落、schema 不正、所属 invariant 違反で exit `1`。壊れた cluster JSON は書かない |
| Semantic dry-run | news-pool 欠落で exit `1`。AI は呼ばない。候補 JSON は atomic write |
| Semantic `--apply-ai` | `OPENAI_API_KEY` なし / pool 欠落 / 不正な `--limit` で exit `1`。全 pair 失敗も exit `1`。一部失敗は exit `2`。`news-clusters.json` は触らない |
| Evaluate default / dry-run | semantic / pool 欠落、cluster membership 不正で exit `1`。dry-run は書かない。AI は呼ばない |
| Evaluate `--apply-ai` | `OPENAI_API_KEY` なし / 不正な `--limit` で exit `1`。requested AI 全失敗 `1`、一部失敗 `2`。unjudged は failure ではない。`news-semantic.json` は触らない |

Web の exit `2` は partial failure です。CI で「1件でも失敗したら落とす」なら非0を失敗にしてください。silent ignore はしません。

## data directory

| path | 内容 |
| --- | --- |
| `data/raw/x-news-feed.json` | 取得した X 公開Feed |
| `data/normalized/x-news.json` | X の内部共通schema |
| `data/raw/web/<source-id>.xml` | 取得した RSS/Atom XML |
| `data/normalized/web-news.json` | Web の内部共通schema |
| `data/normalized/news-pool.json` | X + Web などを束ねた Unified News Pool |
| `data/processed/news-clusters.json` | relationship / cluster（item は削除しない） |
| `data/processed/news-clusters-review.json` | multi-item cluster の確認用 |
| `data/processed/news-semantic-candidates.json` | Semantic dry-run の候補 |
| `data/processed/news-semantic.json` | Semantic judgments / clusters |
| `data/processed/news-evaluated.json` | cluster representative / deterministic signals（scores は未評価） |
| `data/cache/semantic-judgments.json` | Semantic judge cache（API key は含まない） |
| `data/cache/evaluation-judgments.json` | Evaluation judge cache（API key は含まない） |

いずれも `.tmp` → rename の atomic write です。

## テスト

実ネットワークにはアクセスしません。fixture のみ使います。

```bash
npm test
```

X:

- 正常Feedの raw / normalized 件数一致
- `schemaVersion` / `source` / `itemCount` 契約違反で失敗
- 同一 `item.id` の重複は fail fast
- 同一 `sourceUrl` の別itemは両方保持

Web:

- RSS 2.0 / Atom の normalize
- HTML description の plain text 化
- GUID / URL からの決定論的 ID
- 無効日付は `null`
- source config id 重複で失敗
- 一部 source 失敗時の partial result
- 同一providerの stable ID 重複は当該source失敗

Unify:

- X fixture + Web fixture の件数合計が Pool 件数
- 同一 URL / 異なる id は両方保持
- 異なる input の同一 `item.id` は fail
- required input 欠落は fail
- stats は items から算出
- 並び順は決定論的

Cluster:

- item 削除なし、全 item がちょうど1 cluster
- same-url / same-title / 高 title similarity
- tracking query 差は same-url、意味のある query 差は別
- 似ているが別事件は関係付けない
- cluster ID は決定論的
- news-pool 欠落は fail

Semantic（実 API は使わない。mock judge）:

- 類似 pair を candidate にする / 無関係 pair はしない
- `maxCandidatesPerItem` / `maxTotalCandidates`
- 候補順は決定論的
- mock same-event は cluster 結合、related / different は結合しない
- invalid enum / AI failure は failed、merge しない
- cache hit では judge を呼ばない。content / model / judgeVersion 変更は miss
- same-event の transitive cluster と different-event conflict
- 全 item がちょうど1 semantic cluster
- dry-run の judge 呼び出しは 0
- `--limit` は新規 request 上限。cache hit は数えない。limit 外は unjudged
- 不正な `--limit` は fail
- cache / output は atomic write

Evaluate:

- representative / signals は決定論的
- default / dry-run は AI 0
- X 既存 scores を final にコピーしない
- dry-run はファイルを書かない
- semantic 入力は変更しない
- membership / unknown item / representative 所属を検証
- `--limit` は新規 request 上限。cache hit は数えない。limit 外は unjudged
- 不正な `--limit` は fail
- mock 5軸 scores / local baseScore / invalid score 拒否
- failed / unjudged は scores を採用しない
- cache hit では evaluator を呼ばない
- evaluation order は決定論的（multi-item first）

Select:

- selected + rejected が入力 cluster をちょうど分割する
- Evaluate scores / membership / representative は変更しない
- unevaluated と quality floor は selected に入らない
- source type だけで X を落とさない
- major / personal / general gate と cap
- related-group は原則1件
- dry-run はファイルを書かない
- 不正 config / 欠落入力は fail

### News Evaluation

設定: `config/evaluation.json`

**Evaluate** は各ニュース cluster の価値を測る段階です。**Editorial Select** は今日の Digest として何を並べるかを決める段階です。この2つは別です。

```bash
# AI なし。foundation output を書く
npm run evaluate

# AI なし。ファイルを書かない
npm run evaluate -- --dry-run

# 実 AI。--limit は今回の新規 request 上限（cache hit は数えない）
npm run evaluate -- --apply-ai --limit 3
```

`--dry-run` と `--apply-ai` が両方ある場合は dry-run が勝ちます。`--limit 0` / `--limit -1` / `--limit abc` は明示 error です。

Semantic cluster / membership / representative / signals は変更しません。default は `status: unevaluated` の foundation を `news-evaluated.json` に書きます。X の既存 scores は final scores にも prompt にも使いません。`--dry-run` はファイルを書きません。

representative: `publishedAt` 新しい → `collectedAt` 新しい → title 非空 → summary 非空 → item id 昇順。source type / provider は優先しません。

5軸（integer 1..5）: importance / informationValue / impact / novelty / personalRelevance。`baseScore` は local の weighted sum だけです。AI に baseScore は決めさせません。

personalRelevance と importance は別軸です。personalRelevance が高いだけで importance / impact を上げません。重大な政治・災害・国際ニュースは personalRelevance が低くても importance / impact を高くできます。

sourceDiversity は truth / credibility score ではありません。何社が報じたかの信号です。

Evaluation order はニュースランキングではありません。少数の real AI 確認のための **API request execution order** です。

1. multi-item cluster first
2. sourceDiversity desc
3. itemCount desc
4. representative publishedAt desc
5. clusterId asc

dry-run は上位 10 evaluation targets をこの順で表示します。

model 解決順: `EVALUATION_MODEL` → `OPENAI_MODEL` → `config/evaluation.json` の `model`（fallback `gpt-5-mini`）。

Cache: `data/cache/evaluation-judgments.json`。ok のみ保存。cluster content / model / evaluatorVersion が変わると miss。

failed / unjudged は scores / baseScore / reason を採用しません。limit による unjudged は failure ではありません。

### Editorial Select

設定: `config/select.json`

**Editorial Select** は Evaluate 済み cluster から「今日読む集合」を選びます。baseScore 上位をそのまま Digest にはしません。v1 は完全に local deterministic で、API は呼びません。

```bash
# 本番 write（atomic）
npm run select

# ファイルを書かない
npm run select -- --dry-run
```

入力: `data/processed/news-evaluated.json` と `data/processed/news-semantic.json`（related-event を redundancy に再利用）。Semantic cluster / Evaluate scores は変更しません。

quality floor / major / personal / general の3 lane、related-group は原則1件、topic の diminishing returns、target 10 / max 14、padding なし。詳細は `config/select.json`。

出力: `data/processed/news-selected.json`。related-group の人間レビュー用に `data/processed/news-selected-review.json`。`--dry-run` はどちらも書きません。

## 将来

`src/sources/` に source adapter を足し、最終的には同じ Normalized News Item へ変換します。

```
src/sources/x-feed.js       # X 公開 JSON
src/sources/web-feed.js     # RSS / Atom
src/sources/web-news.js     # 未実装（検索・API等）
src/sources/astronomy.js    # 未実装
```

Unify / deterministic Cluster / Semantic / Evaluation / Editorial Select（local）まで実装済みです。Picks、Timeline Digest 生成はまだです。
