# References Candidates V1 (NEWS-REFERENCES-001 Phase 1)

References は、後で見返す画像・図・作品・スクリーンショット・写真・制作資料などの候補を集める独立レーンです。重要ニュースの選定ではありません。

```text
X/Web → Normalize → Unified Pool → Cluster → Semantic → Evaluate → Select → Digest
                                → References Candidates
```

## 入力と保存

入力は既存の `data/normalized/news-pool.json`（schemaVersion 1）。
X正規化に次の3フィールドを追加します。従来のニュースフィールド、ID、スコアは変更しません。

- `vision`: object、`status === "ok"`、空白のみでない文字列 `observations` が揃う場合のみ、`{status, observations, visibleText}` を保存。observationsは原文を保持し、visibleTextは文字列以外をnullにします。それ以外・欠落は `null`。追加キーは破棄します。
- `visual`: `{value, roles}` のみ。valueはnullまたは整数1〜5、rolesは許可リストの文字列配列。値やrolesのいずれかが不正・欠落なら全体を `{value:null, roles:[]}` にします。重複は除き、`evidence, reference, diagram, artwork, screenshot, photo, production-material, other` の順序にします。otherと他のroleが混在する場合はotherを除きます。上流の公開契約と同じ方針です。
- `media`: 既存の上流公開契約 `{type, url, previewUrl, altText, width, height}` のみ。typeはimage/video/gif/unknown、不明値はunknown。altTextは文字列またはnull、寸法は正の整数またはnull。配列順・複数mediaを保持します。欠落・不正配列は `[]`。

media URLはHTTPS、認証情報なし、標準ポート、`pbs.twimg.com` / `video.twimg.com` / `ton.twimg.com` に限定。プロフィール画像等の既知の非投稿パスと認証queryを拒否し、queryはformat/nameだけをキー順で保持、fragmentは除去します。URLとpreviewUrlのどちらも利用不能ならmedia行を除外します。previewだけの動画も利用可能です。外部画像取得や画像の実在確認は行いません。

Poolは既存どおり入力itemをそのまま保存します。追加フィールドを必須化しないため、旧X行とWeb行はフィールド不在のまま利用できます。PoolでのバックフィルやWeb正規化の変更はありません。ID衝突は従来どおりエラー、同一URLでも別IDは保持します。References側でmetadataを再正規化するため、古い・不正な任意metadataも候補処理をクラッシュさせません。従来の必須ニュースschema違反は引き続き入力エラーです。

## 候補ルール

次の条件をすべて満たすitemのみを採用します。

1. 正規化済みの `source.type === "x"`。
2. 安全なurlまたはpreviewUrlを持つmediaが1つ以上。
3. 正規化済みvisual.valueが整数1〜5で、threshold以上。

既定thresholdは名前付き定数 `DEFAULT_REFERENCES_THRESHOLD = 3`。ローカルJS関数 `buildReferencesCandidates` / `generateReferencesCandidates` / `runReferences` の `threshold` オプションで整数1〜5に変更可能です。CLIは既定値を使います。Visionは不要で、mediaから値やrolesを推測しません。

並び順はvisual.value降順、同点は正規化IDの辞書順（JavaScriptの文字列 `<` / `>`、locale非依存）です。ニューススコア・人気・著者・日時を順位やフィルタに使いません。範囲は既存Pool全体です。

## 実行と出力

```sh
npm run references
```

既存Poolを読み、`data/processed/references-candidates.json` にatomic writeします。上流処理は自動実行しません。Pool欠落時は `npm run unify` と既存正規化入力を案内して終了コード1。空Pool/Web-onlyは0候補で成功します。

```json
{
  "schemaVersion": 1,
  "generatedAt": "実行日時",
  "sourcePool": { "generatedAt": "入力の生成日時", "itemCount": 96 },
  "threshold": 3,
  "candidateCount": 0,
  "items": []
}
```

各candidateは `id, source, title, summary, publishedAt, media, vision, visual` のみ。source内に既存の `type, provider, url, originalId, author:{name,handle}` を保存し、同じ情報をトップレベルへ重複させません。生の投稿本文、スコア、任意の内部キーは追加しません。既存source.urlは既存ニュース契約のままで、今回のURL安全化はmediaに適用します。

同じ入力・threshold・generatedAtでは同じJSONです。通常はgeneratedAtのみ変化します。テストでは固定時計と一時出力先を使います。

## ニュース処理との分離・制限

vision/visual/mediaはクラスタリング、semantic判定、ニュース評価、Editorial Select、Digestや各AI入力・cache hashへ追加しません。既存ニュース処理・評価式は変更しません。回帰テストはmetadata有無でニュース出力とAI入力が一致すること、非空の選定結果が変わらないことを確認します。Referencesの依存関係にAI・network処理はありません。

上流valueを再評価せず利用するため、候補の品質は上流metadataに依存します。欠落・不正なmetadataの候補は拾えません。media契約はXの既存公開形式に限定し、画像の内容や到達可能性は検証しません。重複排除、最終References編集選定、件数制限、保存状態管理、UIはPhase 1の対象外です。
