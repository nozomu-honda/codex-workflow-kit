# Validation

GitHub automation共通化では、実装前後で安全条件が緩んでいないことを確認します。

## 共通側で確認すること

- 設定欠落時に安全側へ倒れる
- 不正値を安全側へ倒す
- Secret-likeな値をログへ出さない
- fork / external PRへSecretを渡さない
- `pull_request_target` を使わない
- dry-runで副作用を起こさない

## 導入先で確認すること

- caller workflowが期待イベントだけで起動する
- labels / variables / secretsが導入先に閉じている
- Queue Issueが導入先に作られる
- 小さいdocs-only PRでend-to-end確認できる
- deployや本番操作へ進まない

## 初回確認

初回は必ずdry-runで行います。dry-runで期待するPR、labels、comments、Queue Issueの予定だけを確認してから、小さいdocs-only PRで実動作を確認します。
