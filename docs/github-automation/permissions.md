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
