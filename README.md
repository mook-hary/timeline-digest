# timeline-digest

複数の公開ニュースソースを、共通schemaへ取り込み、重複整理・編集判断を経て Timeline Digest を作るための統合層です。

現在実装しているのは次までです。

- X News Feed（公開 JSON）
- Webニュースの **RSS / Atom**（設定ファイルの公開Feed）
- Unified News Pool（normalized source の merge）

Web検索、News API、本文スクレイピング、AI評価、source横断の重複削除、ランキング、Digest生成はまだ行いません。RSS/Atom は Webニュース入力の **最初の一方式** であり、唯一の取得方式ではありません。Unify は編集ではなく、normalized item を損失なく束ねる段階です。

## 責務の境界

| 層 | 担当 |
| --- | --- |
| [x-timeline-collector](https://github.com/mook-hary/x-timeline-collector) | X取得、Daily Scope、Analyze、AI Analyze / Enrich、Public News Feed の公開 |
| **timeline-digest** | 公開Feedの取得、検証、内部共通schemaへの変換、将来の複数source統合 |

このリポジトリは x-timeline-collector の内部ファイル（Chrome profile、cookie、`timeline.json`、`daily-enriched.json` など）を参照しません。X は公開 `news-feed.json` だけを読みます。Web は `config/web-sources.json` に書いた公開 RSS/Atom URL だけを読みます。ユーザー入力URLをそのまま fetch する汎用HTTP proxyにはしません。OpenAI API も使いません。

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

## failure policy

| 対象 | 失敗時 |
| --- | --- |
| X ingest | HTTP / JSON / schema 失敗で exit `1`。既存 raw / normalized は成功扱いにしない |
| Web 設定エラー（id重複、JSON不正、enabled source なし） | 開始前に失敗。exit `1` |
| Web の一部 source 失敗 | 成功した source は保存する。失敗は表示する。exit `2` |
| Web の全 source 失敗 | normalized を成功として書かない。exit `1` |
| Unify | required input 欠落、schema 不正、item.id 衝突で exit `1`。壊れた pool JSON は書かない |

Web の exit `2` は partial failure です。CI で「1件でも失敗したら落とす」なら非0を失敗にしてください。silent ignore はしません。

## data directory

| path | 内容 |
| --- | --- |
| `data/raw/x-news-feed.json` | 取得した X 公開Feed |
| `data/normalized/x-news.json` | X の内部共通schema |
| `data/raw/web/<source-id>.xml` | 取得した RSS/Atom XML |
| `data/normalized/web-news.json` | Web の内部共通schema |
| `data/normalized/news-pool.json` | X + Web などを束ねた Unified News Pool |

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

## 将来

`src/sources/` に source adapter を足し、最終的には同じ Normalized News Item へ変換します。

```
src/sources/x-feed.js       # X 公開 JSON
src/sources/web-feed.js     # RSS / Atom
src/sources/web-news.js     # 未実装（検索・API等）
src/sources/astronomy.js    # 未実装
```

Unify の次に、共通schema上での重複整理、編集判断、Timeline Digest 生成を載せる予定です。
