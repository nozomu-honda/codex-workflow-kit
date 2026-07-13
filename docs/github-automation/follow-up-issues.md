# Follow-up Issues

GitHub automation共通化は、1タスク=1Issue=1PRで段階的に進めます。

このIssueではREADME、AGENTS、ディレクトリ構成、責務境界、導入ドキュメントを整えるだけに留め、自動レビュー・自動マージ本体は移植しません。

## 候補Issue

1. Config schemaを定義する
   - Issue #3で対応。
   - base branch、labels、protected file patterns、token env names、dry-run設定を記述できるschemaを作る。
   - 設定欠落や不正値は安全側に倒す。

2. Shared Actionの最小骨格を追加する
   - `actions/` に副作用のないdry-run可能なエントリを作る。
   - Secret-like valuesをログに出さないテストを追加する。
   - Issue #3ではまだ追加しない。

3. Reusable workflowの最小骨格を追加する
   - `reusable-workflows/` に `workflow_call` の入口を作る。
   - 導入先の薄いcaller workflowから呼べる形にする。
   - Issue #3ではまだ追加しない。

4. Caller workflow templatesを追加する
   - `issue_comment`
   - `pull_request_review`
   - `pull_request_review_comment`
   - `workflow_run`
   - `pull_request.closed`
   - `push`
   - Issue #3ではまだ追加しない。

5. ChatGPT review routingの共通化を検討する
   - 既存導入先の仕様を棚卸しし、共通化できる判定だけを切り出す。
   - 導入先固有のlabels、Variables、Secrets、Queue Issueは導入先に残す。

6. Reviewed PR auto-mergeの共通化を検討する
   - 既存の安全条件を緩めずに移植範囲を決める。
   - `expected_head_sha`、dangerous file block、secret-like added line blockを維持する。

7. Main follow-up automationの共通化を検討する
   - PR branch update、Queue Issue、Codex triggerの責務分離を整理する。
   - fork / external PRやprotected file変更は自動起動しない。

8. End-to-end導入検証を行う
   - 小さいdocs-only PRでdry-runから実行確認する。
   - 自動merge、deploy、`clasp push`、本番環境アクセスは含めない。

## 移行時の固定ルール

- `pull_request_target` は使わない。
- fork / external PRへSecretを渡さない。
- 導入先の安全条件を緩めない。
- Secret、token、OAuth情報、Cookie、実URL、実IDをdocs、logs、testsへ入れない。
- 実装移植は対象機能ごとのIssueで行う。
