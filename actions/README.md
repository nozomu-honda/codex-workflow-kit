# actions

GitHub automationの共通JavaScript Actionまたは処理本体を置く予定の領域です。

## 現在のAction

- `validate-config/`: 導入先の設定ファイルを読み込み、fail-closed validatorを実行する副作用なしのShared Action。

`validate-config` はGitHub API write、label更新、PR/Issueコメント、自動レビュー、自動マージ、Codex起動、Queue Issue操作を行いません。`dry-run` のdefaultは `true` で、`false` が指定されてもこのIssueの範囲ではwrite capabilityを実行しません。

`validate-config/dist/index.js` はコミット済み配布物です。導入先リポジトリで `npm ci` せずにActionを実行できるよう、source変更時は `npm run build:action` と `npm run check:action-dist` でdist整合性を確認します。

自動レビュー・自動マージ本体はまだ移植しません。導入先リポジトリ固有のSecrets、Variables、labels、Queue Issueもここには置きません。

将来ここへ実装を追加する場合は、設定欠落や不正値を安全側に倒し、`pull_request_target` に依存しない設計を維持します。
