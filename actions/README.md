# actions

GitHub automationの共通JavaScript Actionまたは処理本体を置く予定の領域です。

このIssueでは、自動レビュー・自動マージ本体はまだ移植しません。導入先リポジトリ固有のSecrets、Variables、labels、Queue Issueもここには置きません。

将来ここへ実装を追加する場合は、設定欠落や不正値を安全側に倒し、`pull_request_target` に依存しない設計を維持します。
