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
