# References Selection V1 — NEWS-REFERENCES-001 Phase 2

References Candidatesを通常表示用のselectedと補助表示用のsecondaryに分類する、独立したローカル処理です。AI・ネットワーク・UIはありません。ニュースCluster、Evaluate、Editorial Select、Digestの入力・評価式・順位には影響しません。

```text
Unified Pool → References Candidates → References Selection → references.json
```

## 責務と実行

Phase 1はX・利用可能media・有効Visual Valueを検査して候補を収集します。`DEFAULT_REFERENCES_THRESHOLD = 3` は変更していません。Phase 2はCandidatesのみを入力とし、Poolへの再結合、X再正規化、候補条件の再判定、ニューススコア参照を行いません。

```sh
npm run references:select
```

既定入力: `data/processed/references-candidates.json`

設定: `config/references-selection.json`

出力: `data/processed/references.json`

CLIは設定読込→入力読込→検証→分類→atomic write→件数表示の順で実行します。欠落入力は既存Poolを使う `npm run references` を案内し、終了コード1。上流処理を自動実行しません。ライブラリとCLI関数には一時入力・出力先および固定時計を注入できます。

## 設定と互換性

```json
{
  "schemaVersion": 1,
  "policyId": "references-select-v1",
  "primaryMinValue": 4
}
```

schemaVersionは1、policyIdは空白のみでない文字列、primaryMinValueは整数1〜5。型変換や不正値の既定値への置換は行いません。

`Candidates.threshold > primaryMinValue` はエラーです。上流で除外された候補を復元できないため、必要な閾値以下でCandidatesを再生成するよう案内します。3→4、3→3は許可、4→3、5→4は拒否します。

primaryMinValue=4は暫定表示policyであり、品質の保証ではありません。3件の過去レビューだけで恒久化した値ではなく、追加レビューに応じて設定を調整できます。policyIdと実際の閾値を出力に保存し、閾値変更だけではschema変更を必要としません。

## Candidates入力契約

必須envelope: `schemaVersion:1, generatedAt, sourcePool:{generatedAt,itemCount}, threshold, candidateCount, items`。

- generatedAtは空白のみでない文字列。日時解析・鮮度判定はしません。
- thresholdは整数1〜5。candidateCountはitems.lengthと一致する非負整数、sourcePool.itemCountはcandidateCount以上の非負整数。
- itemsは空配列も許可。IDは空白のみでない文字列かつ重複不可。
- sourceは `type, provider` が空白のみでない文字列、`url, originalId` が文字列またはnull、authorは `name, handle` が文字列またはnullのobject。
- title、summary、publishedAtは必須キーで、文字列またはnull。
- visual.valueは整数1〜5。rolesはPhase 1の8種の文字列配列、重複不可。役割の並べ替えはしません。
- visionはnull、または `status:"ok", observations:空白のみでない文字列, visibleText:文字列またはnull`。
- mediaは非空配列。各要素は `type, url, previewUrl, altText, width, height`。typeはimage/video/gif/unknown。URLはnullまたは認証情報なしのHTTPS URLで、url/previewUrlの少なくとも一方が必要。altTextは文字列またはnull、寸法は正の整数またはnull。

この検証は公開データの構造検証です。Xのホスト許可リスト・取得可能性・source.typeのX限定条件・候補valueと候補閾値の比較は再実行しません。候補としての採用判断は入力を作ったPhase 1の責任です。最終選定の契約は将来の非X候補にも対応できますが、Web候補生成の実装は対象外です。

必須キー欠落や不正値は入力全体を拒否し、黙ってitemを削除・補正しません。余分なキーは受け入れても出力へコピーしません。source.urlは既存の文字列/null契約を維持するため、将来UI側でリンクの安全な扱いが必要です。

## 選定とEvidence

- value >= primaryMinValue: `selection:{status:"selected",reason:"meets-primary-threshold"}`
- それ未満: `selection:{status:"secondary",reason:"below-primary-threshold"}`

すべての入力候補を1回ずつ保持します。`selected + secondary == inputCandidates`。

Evidenceは第3のstatusではありません。`visual.roles`にevidenceを含むitem数をstats.evidenceへ計上します。selected/secondaryのどちらにも重複でき、`selected + secondary + evidence` を総件数とみなしません。将来のVisual References/Evidenceビューは1つのitemを別の観点から表示できます。

rolesによる加点、除外、ニュース的価値の推測はしません。混合rolesもそのまま保持します。

## 出力契約

```json
{
  "schemaVersion": 1,
  "generatedAt": "実行日時",
  "sourceCandidates": {
    "path": "data/processed/references-candidates.json",
    "generatedAt": "入力生成日時",
    "threshold": 3
  },
  "selectionPolicy": { "id": "references-select-v1", "primaryMinValue": 4 },
  "stats": { "inputCandidates": 3, "selected": 2, "secondary": 1, "evidence": 1 },
  "items": []
}
```

上記itemsは形の説明のため省略しています。実際には統計と一致する件数を格納します。

各itemはCandidatesの `id, source, title, summary, publishedAt, media, vision, visual` とselectionだけ。source/author、media各要素、Vision/Visualも公開キーを明示コピーします。生のX本文、任意metadata、AI理由・model、ニュース点数、cluster情報、追加rankはコピーしません。

入力item順をそのまま維持します。Phase 1の通常順序はvalue降順→ID昇順ですが、この段階では並べ替えも順序の補正も行いません。rolesとmedia配列の順序、Visionの原文も保持します。

同一入力・設定・固定時計では同一JSONです。通常実行ではgeneratedAtのみが変わり得ます。人気、著者、現在のニュース文脈、network状態は使いません。

検証をすべて終えた後、既存のwriteJsonAtomicで同一ディレクトリの一時ファイルからrenameします。検証失敗時に既存出力を変更せず、書込/rename失敗時には一時ファイルを削除します。

## 制限と検証

上流valueの妥当性、画像内容、mediaの到達可能性は再評価しません。UI、AI、Web拡張、件数制限、重複排除、Digest統合、画像ダウンロードは対象外です。

テストは決定的fixtureのみを使い、公開フィールド保持、閾値互換性、全件保持、重複するEvidence集計、順序、再現性、不正入力、atomic write失敗、CLI、依存グラフ、ニュース処理非干渉を検証します。過去の無視対象データはテスト依存にしません。
