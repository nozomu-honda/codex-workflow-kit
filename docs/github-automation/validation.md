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

## Shared Action validation

`actions/validate-config` は同じvalidatorを使い、設定読み込みと検証だけを行います。

確認対象:

- sample configで成功する
- config欠落、不正YAML、未対応version、安全boolean弱体化でfail closedになる
- invalid時はすべてのcapabilityが `false` になる
- Secret-like文字列、config全文、正規化済みconfig全文をログへ出さない
- unknown keyはwarningとして数える
- `dry-run` defaultは `true`
- `dry-run=false` でも副作用処理は存在しない
- `action.yml` のinput/output名と実装が一致する

Action専用確認:

```bash
npm run build:action
npm run check:action-dist
npm run test:action
npm run lint:action
```

`npm run check:action-dist` はsourceから再buildした配布物とコミット済み `actions/validate-config/dist/` を比較し、差分がある場合に失敗します。sourceを変更した場合は `npm run build:action` で `dist/index.js` と `dist/package.json` を更新してからコミットします。

配布物単体テストでは、`action.yml` が指す `dist/index.js` を一時ディレクトリへコピーし、外部 `node_modules` なしでvalid / invalid configを処理できることも確認します。

## Reusable workflow validation

`.github/workflows/validate-config.yml` は静的検証で安全境界を確認します。

確認対象:

- workflow YAMLがparse可能
- 実体ファイルが `.github/workflows/validate-config.yml` にあり、旧 `reusable-workflows/validate-config.yml` が存在しない
- `on.workflow_call` だけを入口にする
- `config-file` / `dry-run` inputsのtype、required、defaultが要件どおり
- Secret inputがない
- workflow / job permissionsが `contents: read` のみ
- write permission、`pull_request_target`、`secrets: inherit` がない
- stepsが `actions/checkout@v4` と `actions/validate-config` 呼び出しだけで、`run` を持たない
- workflow outputs、job outputs、Action outputsが一致する
- 外部呼び出し例のpathと実体ファイルpathが一致する

Workflow専用確認:

```bash
npm run test:workflow
npm run lint:workflow
```

GitHub Actions上の外部repository E2Eは、caller workflow templateを追加する後続Issueで確認します。

## Caller workflow template validation

`templates/workflows/validate-config.yml` は静的検証で安全境界を確認します。

確認対象:

- YAMLがparse可能
- triggerは `workflow_dispatch` のみ
- jobは1つだけ
- reusable workflowをjob-level `uses` で呼ぶ
- `runs-on`、`steps`、`run` がない
- permissionsは `contents: read` のみ
- write permissionがない
- Secret、`secrets: inherit`、`pull_request_target` がない
- `config-file` が `.github/chatgpt-automation.yml`
- `dry-run` がbooleanの `true`
- reusable workflow pathが `.github/workflows/validate-config.yml` と一致する
- `v1` / `v1.2` のような未固定major/minor tagや、`master` / `main` などの可変branch参照を使わない
- refは `v1.2.3` 形式の完全なversion tag、40桁commit SHA、または明確な置換プレースホルダーにする
- docsのコピー先とテンプレート実体pathが一致する

Template専用確認:

```bash
npm run test:template
npm run lint:template
```

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
