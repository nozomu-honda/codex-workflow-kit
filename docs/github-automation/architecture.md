# Architecture

GitHub automation共通化では、共通側と導入先側を明確に分けます。

## 共通側

このリポジトリが提供するもの:

- 判定ロジック
- 設定スキーマ
- fail-closed validator
- caller workflow templates
- reusable workflow / Action
- tests
- 導入・移行・検証ドキュメント

## 設定schema

GitHub automationの導入先ごとの差分は、バージョン付き設定で表現します。

機械判定の正本:

- `packages/chatgpt-automation-core/src/config/index.js`

関連する構造schemaとsample:

- `schemas/chatgpt-automation.schema.json`
- `templates/chatgpt-automation.yml`

validatorは副作用を持ちません。設定欠落、型不一致、危険な上書き、未対応versionがある場合はfail closedになり、write capabilityを有効化しません。
JSON Schemaは導入先設定の構造契約として提供し、代表的なvalid / invalid fixtureでvalidatorとのparityをテストします。normalized config、warnings、capabilitiesはvalidatorの結果を正とします。

## Shared Action

`actions/validate-config` は、導入先の設定ファイルを読み込み、上記validatorを実行する最小Shared Actionです。

- default config pathは `.github/chatgpt-automation.yml`
- `dry-run` のdefaultは `true`
- `dist/index.js` はコミット済み配布物で、共通validatorと `yaml` 依存をbundleする
- 利用先リポジトリで `npm ci` や `npm install` を要求しない
- validation失敗時はfail closedになり、すべてのcapabilityを `false` として出力する
- `capabilities-json` はboolean capabilityだけを含む
- Secret-like values、config全文、正規化済みconfig全文をログへ出さない

このActionはGitHub API write、label変更、Issue/PRコメント、自動レビュー、自動マージ、Codex起動、Queue Issue操作を行いません。caller workflowは後続Issueで追加します。

## Reusable workflow

`reusable-workflows/validate-config.yml` は、`workflow_call` で設定検証Actionを呼び出す読み取り専用reusable workflowです。

- inputsは `config-file` と `dry-run` のみ
- workflow outputsは `ok`、`error-count`、`warning-count`、`capabilities-json`、`dry-run`
- permissionsはworkflow / jobとも `contents: read`
- Secret input、`secrets: inherit`、write permissionは使わない
- `actions/checkout@v4` でcaller repositoryをcheckoutする
- `actions/validate-config` は `nozomu-honda/codex-workflow-kit/actions/validate-config@master` として明示参照し、caller repositoryの相対pathとは誤認させない

このreusable workflowはGitHub API write、label変更、Issue/PRコメント、自動レビュー、自動マージ、Codex起動、Queue Issue操作を行いません。導入先caller workflow templateと実イベントtriggerは後続Issueで追加します。refは将来的にtagまたはcommit SHAへ固定します。

導入先設定で弱体化できない安全条件:

- 共通hard-block defaults
- fenced code block内markerの無視
- review request commentの判定除外
- 最新 `changes_requested` で停止
- secret-like hard block
- fork / same-repository安全境界

## 導入先側

各リポジトリが保持するもの:

- `issue_comment`
- `pull_request_review`
- `pull_request_review_comment`
- `workflow_run`
- `pull_request.closed`
- `push`

などのイベントを受ける薄いcaller workflow。

さらに、導入先リポジトリ固有の以下を保持します。

- labels
- repository variables
- repository secrets
- fine-grained PAT
- Queue Issue
- project-specific config

## このIssueで行わないこと

- 既存導入先のworkflow/script移植
- 自動レビュー本体の公開
- 自動マージ本体の公開
- GitHub API write処理
- 導入先リポジトリのSecretsやlabels作成
- `pull_request_target` を使うworkflow追加
