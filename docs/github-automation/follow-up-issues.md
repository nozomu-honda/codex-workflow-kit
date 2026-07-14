# Follow-up Issues

GitHub automation共通化は、1タスク=1Issue=1PRで段階的に進めます。

このIssueではREADME、AGENTS、ディレクトリ構成、責務境界、導入ドキュメントを整えるだけに留め、自動レビュー・自動マージ本体は移植しません。

## 候補Issue

1. Config schemaを定義する
   - Issue #3で対応。
   - base branch、labels、protected file patterns、token env names、dry-run設定を記述できるschemaを作る。
   - 設定欠落や不正値は安全側に倒す。

2. Shared Actionの最小骨格を追加する
   - Issue #7で対応。
   - `actions/` に副作用のないdry-run可能なエントリを作る。
   - Secret-like valuesをログに出さないテストを追加する。
   - GitHub API write、自動レビュー、自動マージ、Codex起動は含めない。

3. Reusable workflowの最小骨格を追加する
   - Issue #9で対応。
   - `reusable-workflows/` に `workflow_call` の入口を作る。
   - 導入先の薄いcaller workflowから呼べる形にする。
   - GitHub API write、自動レビュー、自動マージ、Codex起動は含めない。
   - Issue #13で内部 `actions/validate-config` 参照をレビュー済み40桁commit SHAへ固定。

4. Caller workflow templatesを追加する
   - Issue #11で設定検証用caller workflowテンプレートを対応。
   - 初期テンプレートは `workflow_dispatch` のみ。
   - reusable workflow refは `v1.2.3` 形式の完全なversion tagまたは40桁commit SHAへ固定する。
   - GitHub API write、自動レビュー、自動マージ、Codex起動は含めない。
   - Issue #23で実イベント受付、payload正規化、安全判定、実イベント用caller workflow templateを対応。
   - `issue_comment`
   - `pull_request_review`
   - `pull_request_review_comment`
   - `workflow_run`
   - `pull_request.closed`
   - `push`
   - 実イベントのwrite処理は後続Issueで追加する。

5. ChatGPT review routingの共通化を検討する
   - Issue #24で対応。
   - 既存導入先の仕様を棚卸しし、共通化できる判定だけを切り出す。
   - Issue #23の正規化outputsを使い、ChatGPTレビュー依頼へ進めるかのrouting planを作る。
   - `should_route`、`skip_reason`、`actor_trust`、`dedupe_key` などをoutputsとして返す。
   - 導入先固有のlabels、Variables、Secrets、Queue Issueは導入先に残す。
   - GitHub API write、ChatGPT実行、コメント投稿、label操作、reviewer追加は含めない。

6. Reviewed PR auto-mergeの共通化を検討する
   - Issue #25で対応。
   - 既存の安全条件を緩めず、auto-merge候補plan生成までを共通化する。
   - `expected_head_sha` 相当のhead SHA一致、dangerous file block、secret-like added line blockを維持する。
   - `eligible`、`should_enable_auto_merge`、`should_merge`、`skip_reason`、`dedupe_key` などをoutputsとして返す。
   - GitHub API write、auto-merge有効化、merge queue投入、merge API呼び出し、comment投稿、label操作、branch削除は含めない。

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
