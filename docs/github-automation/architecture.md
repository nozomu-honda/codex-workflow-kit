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

正本:

- `schemas/chatgpt-automation.schema.json`
- `packages/chatgpt-automation-core/src/config/index.js`
- `templates/chatgpt-automation.yml`

validatorは副作用を持ちません。設定欠落、型不一致、危険な上書き、未対応versionがある場合はfail closedになり、write capabilityを有効化しません。

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
