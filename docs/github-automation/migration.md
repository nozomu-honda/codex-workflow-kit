# Migration

既存リポジトリからGitHub automationを共通化するときは、1タスク=1Issue=1PRで小さく移行します。

## 方針

- まず現行workflow/script/docs/testsを棚卸しする
- 共通化できる判定ロジックと、導入先に残す設定を分ける
- Secret、labels、Queue Issue、fine-grained PATは導入先に残す
- caller workflowは薄く保つ
- 移行中も導入先の安全条件を緩めない

## このIssueで移行しないもの

- 自動レビュー本体
- 自動マージ本体
- main追従自動化本体
- 導入先のSecretsやVariables

実装移行は後続Issueで、対象機能ごとに分割します。

## 既存variable名のmapping

設定schemaでは、review-fix系とmain-followup系のmax attempts variable名を分けます。

| 目的 | logical field | 既存/想定variable名 |
|---|---|---|
| review fix Codex自動修正の最大試行回数 | `variables.reviewFixMaxAttempts` | `CODEX_AUTO_FIX_MAX_ATTEMPTS` |
| main follow-up Codex自動修正の最大試行回数 | `variables.mainFollowupMaxAttempts` | `MAIN_FOLLOWUP_CODEX_AUTO_FIX_MAX_ATTEMPTS` |

後続移行では、既存導入先が単一名を使っている場合でも暗黙に統合せず、対象処理ごとに対応先を明示します。
