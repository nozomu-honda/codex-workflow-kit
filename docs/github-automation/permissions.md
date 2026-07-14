# Permissions

GitHub automation共通化では、権限を最小化し、強い権限を導入先リポジトリで明示管理します。

## 禁止

- `pull_request_target` を使わない
- fork / external PRへSecretを渡さない
- Secret、token、OAuth情報、Cookie、実URL、実IDをログやdocsへ出さない
- 共通化を理由に導入先の安全条件を緩めない

## 導入先で管理するもの

- repository secrets
- repository variables
- fine-grained PAT
- labels
- Queue Issue

## 共通側に置くもの

- permission modelの説明
- caller workflow template
- reusable workflow / Actionの入力仕様
- 設定schema
- validation tests

実際の権限値は導入先リポジトリの運用に依存するため、このリポジトリには実値や実IDを置きません。

## 実イベント正規化の権限境界

Issue #23の実イベント受付では、導入先caller workflowと共通reusable workflowのどちらもdefaultをread-onlyにします。

- workflow / job permissionsは `contents: read`
- `pull_request_target` は使わない
- Secret inputは定義しない
- `secrets: inherit` は使わない
- fork / external PRは `eligible=false` にする
- PR上の `issue_comment` は、payloadだけではfork / same-repository境界を検証できないため `eligible=false` にする
- `permission-mode` は `read-only` だけを許可する
- `requested-capability` は `normalize-only` だけを許可する
- write相当capabilityが要求された場合はfail closedにする

導入先固有のlabels、Variables、Secrets、fine-grained PAT、Queue Issue番号は導入先側に残します。Issue #24以降でwrite処理を追加する場合も、Secretをfork / external PRへ渡さず、Issue #23の `eligible` outputとfork/same-repository判定を前提に分岐します。

## ChatGPT review routingの権限境界

Issue #24のreview routingは、正規化eventとread-only GitHub API結果からrouting planを作るだけです。

- workflow / job permissionsはread-onlyに限定する
  - `contents: read`
  - `pull-requests: read`
  - `issues: read`
  - `actions: read`
  - `checks: read`
  - `statuses: read`
- `github.token` はPR情報、changed files、actor権限などのreadにだけ使う
- token値、Secret値、Cookie、OAuth情報、private URL、payload全文はログへ出さない
- Secret inputは定義しない
- `secrets: inherit` は使わない
- `pull_request_target` は使わない
- fork / external PR、未知actor、GitHub Actions bot、API read失敗は `should_route=false` にする
- dry-run defaultで、review request作成、コメント投稿、reaction、label操作、reviewer追加、ChatGPT/Codex起動、Queue Issue更新は行わない

PR上の `issue_comment` はpayloadだけではprovenanceを安全に検証できないため、Issue #24ではrouting対象外です。将来この経路を有効化する場合も、read-only APIでPR番号、base repository、head repository、head SHA、fork境界、actorを確認し、失敗時はfail closedにします。

## Reviewed PR auto-merge planの権限境界

Issue #25のauto-merge planは、正規化eventとread-only GitHub API結果からmerge候補planを作るだけです。

- workflow / job permissionsはread-onlyに限定する
  - `contents: read`
  - `pull-requests: read`
  - `issues: read`
  - `actions: read`
  - `checks: read`
  - `statuses: read`
- `github.token` はPR情報、changed files、reviews、review threads、CI/check/status、repository settings、compare、actor権限のreadにだけ使う
- token値、Secret値、Cookie、OAuth情報、private URL、payload全文はログへ出さない
- Secret inputは定義しない
- `secrets: inherit` は使わない
- `pull_request_target` は使わない
- fork / external PR、古いhead SHA、最新 `changes_requested`、required CI失敗、dangerous file、secret-like追加行、API read失敗は `eligible=false` にする
- dry-run defaultで、auto-merge有効化、merge queue投入、merge API呼び出し、コメント投稿、ラベル操作、branch削除は行わない

導入先で実write処理を追加する場合も、Issue #25のplan outputsを入力にし、write tokenやmerge tokenをfork / external PRへ渡さない設計を別途レビューします。
