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
npm run check:action-dist
npm run audit:template
npm run test:events
npm run test:review-routing
npm run test:auto-merge
npm run test:main-follow-up
npm run test:e2e:consumer
npm run lint:e2e
npm run ci
git diff --check
```

`npm run validate:config` は `templates/chatgpt-automation.yml` を検証します。

個別ファイルを検証する場合:

```bash
node scripts/validate-config.mjs path/to/chatgpt-automation.yml
```

validatorは設定全文やSecret値をログ出力しません。error / warningは `path`、`code`、固定messageだけを返します。

JSON Schemaは代表fixtureでvalidatorとparity確認します。ただし、normalized config、warnings、capabilitiesを含む機械判定の正本はfail-closed validatorです。

## Installation audit CLI validation

`scripts/audit-consumer-installation.mjs` は、導入先リポジトリのconfigとcaller workflowをread-onlyで監査します。詳細は [Installation audit CLI](installation-audit.md) を参照します。

確認対象:

- valid consumer fixtureで成功する
- `--config` / `--workflow` / `--expected-ref` を処理できる
- human-readable出力とJSON出力が安定している
- config欠落、読み取り不可、不正YAML、未知キー、型不正、`dryRunDefault: false` を検出する
- workflow欠落、不正YAML、branch/tag/短縮SHA/placeholder ref、wrong repository/path、禁止trigger、write permission、secrets、`secrets: inherit`、`runs-on`、`steps`、`run`、`shell`、複数job、想定外input/outputを検出する
- Secret-like fixture値、絶対path、stack traceを出力しない
- invalid時はnon-zero exit codeになる
- template dogfood監査ではplaceholderを一時fixture内で40桁SHAへ置換し、本番監査ではplaceholderを拒否する

Audit専用確認:

```bash
npm run test:audit
npm run lint:audit
npm run audit:template
```

導入先を直接監査する場合:

```bash
npm run audit:consumer -- --root ../consumer-repo --expected-ref 0123456789abcdef0123456789abcdef01234567
```

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
- `action.yml` の `runs.using` が `node24`
- `dist/index.js` がNode 24でvalid / invalid configを処理できる

Action専用確認:

```bash
npm run build:action
npm run check:action-dist
npm run test:action
npm run lint:action
```

`npm run check:action-dist` はsourceから再buildした配布物とコミット済み `actions/validate-config/dist/` を比較し、差分がある場合に失敗します。sourceを変更した場合は `npm run build:action` で `dist/index.js` と `dist/package.json` を更新してからコミットします。

配布物単体テストでは、`action.yml` が指す `dist/index.js` を一時ディレクトリへコピーし、外部 `node_modules` なしでvalid / invalid configを処理できることも確認します。

## Offline consumer E2E

`npm run test:e2e:consumer` は、実GitHub repositoryを使わずに導入先を模した一時ディレクトリを作り、`templates/` からconfigとcaller workflowを配置して検証します。テスト終了時に一時ディレクトリは削除します。

確認対象:

- valid consumer fixtureでconfig validatorとinstallation auditが成功する
- human-readable出力が成功を示す
- JSON出力が `ok`、`errors`、`warnings`、`checks`、`capabilities`、`files` の安定schemaを返す
- `dryRunDefault` が `true`
- `features`、`queues`、`codex`、`schedules` のcapabilityがすべてdisabled
- caller workflowが `workflow_dispatch` only、`contents: read` only、40桁SHA固定、Secretなしである
- placeholder、branch、tag、短縮SHA、未知config key、capability有効化、`dryRunDefault: false`、write permission、`pull_request_target`、`secrets: inherit`、inline `run`、`steps`、`runs-on`、path escape、config / workflow欠落、不正YAMLをfail closedで検出する
- invalid caseはnon-zero exit codeとstable error codeを返す
- Secret-like fixture値、絶対path、stack trace、config全文を出力しない

Action source / dist E2Eでは、同じconsumer configを `actions/validate-config/src/index.js` と `actions/validate-config/dist/index.js` へ通し、valid時のoutputs一致、invalid時のfail-closed、capability false、配布物が外部 `node_modules` なしで動くことを確認します。コマンド注入風の値をfixtureへ入れてもログへ出さないことも確認します。

実イベントcaller E2Eでは、`templates/workflows/chatgpt-automation-events.yml` から一時consumer workflowを作り、次を確認します。

- reusable workflow refと `kit-ref` が同じ固定SHAへ置換される
- caller側は `contents: read` のjob-level `uses` だけを持つ
- repository固有設定はVariable由来のJSONとしてcaller側に残せる
- valid payloadで安定したoutputsが得られる
- fork相当payloadは `eligible=false`
- dry-runではwrite処理が発生しない
- Secret、`pull_request_target`、inline write処理を含まない

Review routing consumer E2Eでは、`templates/workflows/chatgpt-review-routing-events.yml` から一時consumer workflowを作り、次を確認します。

- reusable workflow refと `kit-ref` が同じ固定SHAへ置換される
- caller側はread-only permissionsのjob-level `uses` だけを持つ
- repository固有command / label / reviewer / trusted actor設定はVariable由来JSONとしてcaller側に残せる
- same-repo、trusted actor、CI successで `should_route=true` になる
- fork相当payloadとunknown actorは `should_route=false`
- dry-runではwrite処理が発生しない
- Secret、`pull_request_target`、inline write処理を含まない

Auto-merge consumer E2Eでは、`templates/workflows/reviewed-pr-auto-merge-events.yml` から一時consumer workflowを作り、次を確認します。

- reusable workflow refと `kit-ref` が同じ固定SHAへ置換される
- caller側はread-only permissionsのjob-level `uses` だけを持つ
- repository固有auto-merge config、dedupe key、cooldown情報はVariable由来JSONとしてcaller側に残せる
- same-repo、current ChatGPT approval、required CI successで `eligible=true` になる
- fork相当payload、unknown actor、dangerous file変更は `eligible=false`
- dry-runではwrite処理が発生しない
- Secret、`pull_request_target`、inline write処理を含まない

Main follow-up consumer E2Eでは、`templates/workflows/main-follow-up-events.yml` から一時consumer workflowを作り、次を確認します。

- reusable workflow refと `kit-ref` が同じ固定SHAへ置換される
- caller側はread-only permissionsのjob-level `uses` だけを持つ
- repository固有main follow-up config、dedupe key、attempt count、last attempted timestampはVariable由来JSONとしてcaller側に残せる
- safeなbehind PRは `behind-update-candidate` になる
- conflict / update failedは設定上許可された場合だけCodex follow-up候補になる
- fork相当payloadとsecret-like変更は自動更新候補にもCodex候補にもならない
- dry-runではwrite処理が発生しない
- Secret、`pull_request_target`、inline write処理を含まない

E2E専用確認:

```bash
npm run test:e2e:consumer
npm run lint:e2e
```

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
- `actions/validate-config` 呼び出しのrepository名とAction pathが `nozomu-honda/codex-workflow-kit/actions/validate-config` と一致する
- `actions/validate-config` 呼び出しのrefはレビュー済み40桁commit SHAのみ許可し、`master`、`main`、branch名、短縮SHA、tag参照を拒否する
- workflow outputs、job outputs、Action outputsが一致する
- 外部呼び出し例のpathと実体ファイルpathが一致する

Workflow専用確認:

```bash
npm run test:workflow
npm run lint:workflow
```

`.github/workflows/normalize-event.yml` は、実イベント正規化reusable workflowとして静的検証します。

確認対象:

- `workflow_call` だけを入口にする
- Secret inputがない
- workflow / job permissionsが `contents: read` のみ
- outputsが `packages/chatgpt-automation-core/src/events/` の正規化output名と一致する
- `kit-ref` は40桁commit SHAまたは `v1.2.3` 形式の完全なversion tagだけを許可する
- `actions/checkout` はレビュー済み40桁commit SHAで固定し、`persist-credentials: false` にする
- 共通script `scripts/normalize-event.mjs` だけを実行する
- `pull_request_target`、Secret、`secrets: inherit`、write permissionを持たない

イベント正規化専用確認:

```bash
npm run test:events
npm run lint:events
```

`.github/workflows/review-routing.yml` は、ChatGPT review routing reusable workflowとして静的検証します。

確認対象:

- `workflow_call` だけを入口にする
- Secret inputがない
- workflow / job permissionsがread-onlyだけ
- Issue #23の `.github/workflows/normalize-event.yml` を先に呼ぶ
- outputsが `packages/chatgpt-automation-core/src/review-routing/` のrouting output名と一致する
- `kit-ref` は40桁commit SHAまたは `v1.2.3` 形式の完全なversion tagだけを許可する
- `actions/checkout` はレビュー済み40桁commit SHAで固定し、`persist-credentials: false` にする
- `scripts/route-review.mjs` だけを実行する
- `pull_request_target`、Secret、`secrets: inherit`、write permissionを持たない

Review routing専用確認:

```bash
npm run test:review-routing
npm run lint:review-routing
```

`.github/workflows/auto-merge-plan.yml` は、Reviewed PR auto-merge plan reusable workflowとして静的検証します。

確認対象:

- `workflow_call` だけを入口にする
- Secret inputがない
- workflow / job permissionsがread-onlyだけ
- Issue #23の `.github/workflows/normalize-event.yml` を先に呼ぶ
- outputsが `packages/chatgpt-automation-core/src/auto-merge/` のauto-merge output名と一致する
- `kit-ref` は40桁commit SHAまたは `v1.2.3` 形式の完全なversion tagだけを許可する
- `actions/checkout` はレビュー済み40桁commit SHAで固定し、`persist-credentials: false` にする
- `scripts/plan-auto-merge.mjs` だけを実行する
- `pull_request_target`、Secret、`secrets: inherit`、write permissionを持たない

Auto-merge専用確認:

```bash
npm run test:auto-merge
npm run lint:auto-merge
```

`.github/workflows/main-follow-up-plan.yml` は、Main follow-up plan reusable workflowとして静的検証します。

確認対象:

- `workflow_call` だけを入口にする
- Secret inputがない
- workflow / job permissionsがread-onlyだけ
- Issue #23の `.github/workflows/normalize-event.yml` を `main-follow-up-plan` capabilityで先に呼ぶ
- outputsが `packages/chatgpt-automation-core/src/main-follow-up/` のmain follow-up output名と一致する
- `kit-ref` は40桁commit SHAまたは `v1.2.3` 形式の完全なversion tagだけを許可する
- `actions/checkout` はレビュー済み40桁commit SHAで固定し、`persist-credentials: false` にする
- `scripts/plan-main-follow-up.mjs` だけを実行する
- `pull_request_target`、Secret、`secrets: inherit`、write permissionを持たない

Main follow-up専用確認:

```bash
npm run test:main-follow-up
npm run lint:main-follow-up
```

GitHub Actions上の外部repository E2Eは、導入先caller workflow側の後続Issueで確認します。内部Action refを更新する場合は、候補commitに `actions/validate-config/action.yml` と `actions/validate-config/dist/index.js` が存在することを確認してから40桁commit SHAへ差し替えます。

## Repository CI validation

`.github/workflows/ci.yml` は、この共通キット自身のCIです。

確認対象:

- triggerは `pull_request`、`master` push、`workflow_dispatch`
- workflow / job permissionsは `contents: read` のみ
- `pull_request_target`、Secret、`secrets: inherit`、write permission、deploy、release、tag作成、mergeを持たない
- 外部Actionはレビュー済み40桁commit SHAで固定し、branch / tag参照を使わない
- Node 20.19.0以上で `npm run ci` を実行する
- Node 24で `npm run test:action` と `npm run check:action-dist` を実行する
- reusable workflow smokeをjob-level `uses: ./.github/workflows/validate-config.yml` で実行し、専用fixture `reusable-workflows/fixtures/valid-chatgpt-automation.yml` を読む
- smoke後続jobで `ok=true`、`error-count=0`、`warning-count=0`、`dry-run=true`、すべてのcapabilityが `false` であることを検証する

`npm run ci` はread-onlyのローカル集約コマンドです。失敗時は次の順で切り分けます。

1. `npm test` でvalidator / Action / workflow / template / audit / consumer E2Eのどこが落ちたか確認する。
2. `npm run check:action-dist` でsourceとdistの差分を確認する。
3. `npm run audit:template` と `npm run test:e2e:consumer` で導入先テンプレートとoffline consumer E2Eの境界を確認する。
4. workflow smokeだけ落ちる場合は、reusable workflowのoutputs配線とGitHub Actions上の `node24` runtimeを確認する。

CIやE2Eが失敗した場合、自動修正や外部repository変更は行いません。原因調査し、必要なら別Issueとして分離します。

正常時の期待値:

- `ok=true`
- `errors=0`
- `warnings=0`
- `dry-run=true`
- write operations disabled
- Node 20廃止警告なし

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

`templates/workflows/chatgpt-automation-events.yml` は実イベント用caller workflow templateとして静的検証します。

確認対象:

- 対象イベントが `issue_comment`、`pull_request_review`、`pull_request_review_comment`、`workflow_run`、`pull_request.closed`、`push`
- jobは1つだけで `.github/workflows/normalize-event.yml` をjob-level `uses` で呼ぶ
- `event-payload-json` に `toJson(github.event)` を渡す
- `dry-run: true`
- `permission-mode: read-only`
- `requested-capability: normalize-only`
- reusable workflow refと `kit-ref` は同じ固定refへ置換する
- `push.branches` は導入先default branchへ置換する
- Secret、`secrets: inherit`、`runs-on`、`steps`、`run`、`pull_request_target` を含まない

`templates/workflows/chatgpt-review-routing-events.yml` はChatGPT review routing用caller workflow templateとして静的検証します。

確認対象:

- 対象イベントが `issue_comment`、`pull_request_review`、`pull_request_review_comment`、`workflow_run`、`pull_request.closed`、`push`、`workflow_dispatch`
- jobは1つだけで `.github/workflows/review-routing.yml` をjob-level `uses` で呼ぶ
- `event-payload-json` に `toJson(github.event)` を渡す
- `dry-run: true`
- repository固有config、dedupe key、cooldown情報はSecretを含まないVariablesとして渡す
- reusable workflow refと `kit-ref` は同じ固定refへ置換する
- `push.branches` は導入先default branchへ置換する
- Secret、`secrets: inherit`、`runs-on`、`steps`、`run`、`pull_request_target` を含まない

`templates/workflows/reviewed-pr-auto-merge-events.yml` はReviewed PR auto-merge plan用caller workflow templateとして静的検証します。

確認対象:

- 対象イベントが `workflow_run`、`check_suite`、`check_run`、`pull_request_review`、`pull_request_review_comment`、`pull_request.ready_for_review`、`pull_request.synchronize`、`pull_request.closed`、`workflow_dispatch`
- jobは1つだけで `.github/workflows/auto-merge-plan.yml` をjob-level `uses` で呼ぶ
- `event-payload-json` に `toJson(github.event)` を渡す
- `dry-run: true`
- repository固有config、dedupe key、cooldown情報はSecretを含まないVariablesとして渡す
- reusable workflow refと `kit-ref` は同じ固定refへ置換する
- Secret、`secrets: inherit`、`runs-on`、`steps`、`run`、`pull_request_target` を含まない

`templates/workflows/main-follow-up-events.yml` はMain follow-up plan用caller workflow templateとして静的検証します。

確認対象:

- 対象イベントが `push`、`pull_request.closed`、`workflow_dispatch`
- `push.branches` をhardcodeせず、planner側でdefault branchだけを処理する
- jobは1つだけで `.github/workflows/main-follow-up-plan.yml` をjob-level `uses` で呼ぶ
- `event-payload-json` に `toJson(github.event)` を渡す
- `dry-run: true`
- repository固有config、dedupe key、attempt count、last attempted timestampはSecretを含まないVariablesとして渡す
- reusable workflow refと `kit-ref` は同じ固定refへ置換する
- Secret、`secrets: inherit`、`runs-on`、`steps`、`run`、`pull_request_target` を含まない

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
