# GitHub automation

この領域は、GitHub Actions自動レビュー・自動マージ基盤を共通化するための設計と導入ドキュメントを置きます。

このIssueでは、自動レビュー・自動マージ本体の移植は行いません。まず責務境界、権限、導入、移行、検証の正本を用意します。

## ドキュメント

- [Architecture](architecture.md)
- [Permissions](permissions.md)
- [Installation](installation.md)
- [Migration](migration.md)
- [Validation](validation.md)
- [Follow-up Issues](follow-up-issues.md)

## 基本方針

- 共通側は判定ロジック、設定スキーマ、テンプレート、reusable workflow / Action、テスト、導入ドキュメントを持つ
- 導入先側はイベントを受ける薄いcaller workflowと、repository固有設定、labels、Variables、Secrets、fine-grained PAT、Queue Issueを持つ
- `pull_request_target` は使わない
- fork / external PRへSecretを渡さない
- 設定欠落や不正値は安全側に倒す
- Secret、token、OAuth情報、Cookie、実URL、実IDはこのリポジトリへ保存しない
