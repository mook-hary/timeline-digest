# timeline-digest

複数の公開ニュースソースを、共通schemaへ取り込み、重複整理・編集判断を経て Timeline Digest を作るための統合層です。

現在実装しているのは **X News Feed の安全な取り込み** だけです。Webニュース、政治・経済、科学、天文、合気道データなどの統合、重複整理、Digest生成はまだ行いません。

## 責務の境界

| 層 | 担当 |
| --- | --- |
| [x-timeline-collector](https://github.com/mook-hary/x-timeline-collector) | X取得、Daily Scope、Analyze、AI Analyze / Enrich、Public News Feed の公開 |
| **timeline-digest** | 公開Feedの取得、検証、内部共通schemaへの変換、将来の複数source統合 |

このリポジトリは x-timeline-collector の内部ファイル（Chrome profile、cookie、`timeline.json`、`daily-enriched.json` など）を参照しません。公開インターフェースである `news-feed.json` だけを読みます。OpenAI API も使いません。

## 現在の入力

公開 X News Feed:

https://mook-hary.github.io/x-timeline-collector/news-feed.json

## 実行

Node.js 20+（標準 `fetch`）が必要です。追加依存はありません。

```bash
npm run ingest:x
```

処理は次の順です。

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

今回は編集フィルタを行いません。Feed が N 件なら normalized も N 件です。

## data directory

| path | 内容 |
| --- | --- |
| `data/raw/x-news-feed.json` | 取得した公開Feedそのもの（provenance / debug） |
| `data/normalized/x-news.json` | timeline-digest 内部の共通schema |

どちらも `.tmp` → rename の atomic write です。HTTP / JSON / schema の失敗時は既存ファイルを成功扱いにせず、exit code は非0です。

## テスト

実GitHub Pagesにはアクセスしません。fixture のみ使います。

```bash
npm test
```

カバーしているケース:

- 正常Feedの raw / normalized 件数一致
- `schemaVersion` / `source` / `itemCount` 契約違反で失敗
- null field の normalize
- scores mapping
- 同一 `sourceUrl` の別itemを両方保持
- 同一 `item.id` の重複は fail fast
- 決定論的な内部ID
- HTTP failure / invalid JSON で非0
- atomic write

## 将来

`src/sources/` に source adapter を足す想定です。今あるのは X だけです。

```
src/sources/x-feed.js      # 今回
src/sources/web-news.js    # 未実装
src/sources/astronomy.js   # 未実装
```

その後に、共通schema上での重複整理、編集判断、Timeline Digest 生成を載せる予定です。
