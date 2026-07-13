# Validation

GitHub automation共通化では、実装前後で安全条件が緩んでいないことを確認します。

## 共通側で確認すること

- 設定欠落時に安全側へ倒れる
- 不正値を安全側へ倒す
- Secret-likeな値をログへ出さない
- fork / external PRへSecretを渡さない
- `pull_request_target` を使わない
- dry-runで副作用を起こさない

## ローカルvalidation

このリポジトリでは、設定schemaとfail-closed validatorをローカルで確認できます。

```bash
npm ci
npm test
npm run lint
npm run validate:config
git diff --check
```

`npm run validate:config` は `templates/chatgpt-automation.yml` を検証します。

個別ファイルを検証する場合:

```bash
node scripts/validate-config.mjs path/to/chatgpt-automation.yml
```

validatorは設定全文やSecret値をログ出力しません。error / warningは `path`、`code`、固定messageだけを返します。

JSON Schemaは代表fixtureでvalidatorとparity確認します。ただし、normalized config、warnings、capabilitiesを含む機械判定の正本はfail-closed validatorです。

## Fail closed cases

少なくとも次の場合は `ok: false` になり、すべてのcapabilityが `false` になります。

- 未対応version
- rootがobjectではない
- `baseBranch` / `ciWorkflowName` の欠落または不正
- `mergeMethod` の許可値外
- critical booleanの型不一致
- label名の空文字
- marker重複
- fenced code block内marker無視の無効化
- review request comment除外の無効化
- 最新 `changes_requested` 停止条件の無効化
- hard-block defaultsの無効化または編集
- secret-like hard blockのwarning-only降格
- 不正なSecret / Variable名
- queue有効時のIssue番号/title欠落
- schedule有効時のcron欠落または不正

## 導入先で確認すること

- caller workflowが期待イベントだけで起動する
- labels / variables / secretsが導入先に閉じている
- Queue Issueが導入先に作られる
- 小さいdocs-only PRでend-to-end確認できる
- deployや本番操作へ進まない

## 初回確認

初回は必ずdry-runで行います。dry-runで期待するPR、labels、comments、Queue Issueの予定だけを確認してから、小さいdocs-only PRで実動作を確認します。
