# Architecture

GitHub automation共通化では、共通側と導入先側を明確に分けます。

## 共通側

このリポジトリが提供するもの:

- 判定ロジック
- 設定スキーマ
- caller workflow templates
- reusable workflow / Action
- tests
- 導入・移行・検証ドキュメント

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
- 導入先リポジトリのSecretsやlabels作成
- `pull_request_target` を使うworkflow追加
