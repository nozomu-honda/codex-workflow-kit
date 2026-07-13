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
- `permission-mode` は `read-only` だけを許可する
- `requested-capability` は `normalize-only` だけを許可する
- write相当capabilityが要求された場合はfail closedにする

導入先固有のlabels、Variables、Secrets、fine-grained PAT、Queue Issue番号は導入先側に残します。Issue #24以降でwrite処理を追加する場合も、Secretをfork / external PRへ渡さず、Issue #23の `eligible` outputとfork/same-repository判定を前提に分岐します。
