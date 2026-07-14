# GitHub automation

この領域は、GitHub Actions自動レビュー・自動マージ基盤を共通化するための設計と導入ドキュメントを置きます。

このIssueでは、自動レビュー・自動マージ本体の移植は行いません。まず責務境界、権限、導入、移行、検証の正本を用意します。

## ドキュメント

- [Architecture](architecture.md)
- [Permissions](permissions.md)
- [Config schema](config-schema.md)
- [Installation](installation.md)
- [Installation audit CLI](installation-audit.md)
- [Repository protection audit](protection-audit.md)
- [Event normalization](event-normalization.md)
- [ChatGPT review routing](review-routing.md)
- [Reviewed PR auto-merge plan](auto-merge.md)
- [Main follow-up plan](main-follow-up.md)
- [Migration](migration.md)
- [Validation](validation.md)
- [Follow-up Issues](follow-up-issues.md)

## 基本方針

- 共通側は判定ロジック、設定スキーマ、テンプレート、reusable workflow / Action、テスト、導入ドキュメントを持つ
- 導入先側はイベントを受ける薄いcaller workflowと、repository固有設定、labels、Variables、Secrets、fine-grained PAT、Queue Issueを持つ
- 実イベントは薄いcaller workflowから共通reusable workflowへ渡し、共通形式へ正規化してから後続処理に渡す
- ChatGPT review routingはrouting plan生成までを共通化し、write処理は後続Issueへ分離する
- Reviewed PR auto-mergeはmerge候補plan生成までを共通化し、GitHub API writeや実mergeは後続Issueへ分離する
- Repository protection auditはconsumer repositoryのBranch protection / Ruleset / required checks / required reviews / bypassをread-onlyで監査し、設定変更は行わない
- Main follow-upはdefault branch追従のplan生成までを共通化し、PR branch update、Codex起動、Queue Issue更新は後続Issueへ分離する
- `pull_request_target` は使わない
- fork / external PRへSecretを渡さない
- 設定欠落や不正値は安全側に倒す
- Secret、token、OAuth情報、Cookie、実URL、実IDはこのリポジトリへ保存しない
