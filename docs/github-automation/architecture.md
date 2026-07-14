# Architecture

GitHub automation共通化では、共通側と導入先側を明確に分けます。

## 共通側

このリポジトリが提供するもの:

- 判定ロジック
- 設定スキーマ
- fail-closed validator
- caller workflow templates
- reusable workflow / Action
- tests
- 導入・移行・検証ドキュメント

## 設定schema

GitHub automationの導入先ごとの差分は、バージョン付き設定で表現します。

機械判定の正本:

- `packages/chatgpt-automation-core/src/config/index.js`

関連する構造schemaとsample:

- `schemas/chatgpt-automation.schema.json`
- `templates/chatgpt-automation.yml`

validatorは副作用を持ちません。設定欠落、型不一致、危険な上書き、未対応versionがある場合はfail closedになり、write capabilityを有効化しません。
JSON Schemaは導入先設定の構造契約として提供し、代表的なvalid / invalid fixtureでvalidatorとのparityをテストします。normalized config、warnings、capabilitiesはvalidatorの結果を正とします。

## Shared Action

`actions/validate-config` は、導入先の設定ファイルを読み込み、上記validatorを実行する最小Shared Actionです。

- default config pathは `.github/chatgpt-automation.yml`
- `dry-run` のdefaultは `true`
- GitHub Actions runtimeは `node24`
- `dist/index.js` はコミット済み配布物で、共通validatorと `yaml` 依存をbundleする
- 利用先リポジトリで `npm ci` や `npm install` を要求しない
- validation失敗時はfail closedになり、すべてのcapabilityを `false` として出力する
- `capabilities-json` はboolean capabilityだけを含む
- Secret-like values、config全文、正規化済みconfig全文をログへ出さない

このActionはGitHub API write、label変更、Issue/PRコメント、自動レビュー、自動マージ、Codex起動、Queue Issue操作を行いません。caller workflowは後続Issueで追加します。

## Installation audit CLI

`scripts/audit-consumer-installation.mjs` と `packages/chatgpt-automation-core/src/installation-audit/` は、導入先リポジトリのconfigとcaller workflowをローカルで監査するread-only CLI / core moduleです。

- config検証は共通validatorを再利用する
- caller workflowはYAMLを構造的にparseして、`workflow_dispatch` only、`contents: read` only、job-level reusable workflow `uses`、40桁SHA固定、`dry-run: true`、Secretなしを確認する
- JSON resultは `ok`、`errors`、`warnings`、`checks`、`capabilities`、`files` を安定schemaとして返す
- Secret値、token値、Cookie値、OAuth値、環境変数値、絶対path、stack traceは出力しない
- ネットワークアクセス、GitHub API read/write、自動修正、workflow実行、deploy、mergeは行わない

CLI wrapperとcore moduleを分け、将来JavaScript Actionやnpm packageへ再利用しやすい境界にします。

## Reusable workflow

`.github/workflows/validate-config.yml` は、`workflow_call` で設定検証Actionを呼び出す読み取り専用reusable workflowです。

- inputsは `config-file` と `dry-run` のみ
- workflow outputsは `ok`、`error-count`、`warning-count`、`capabilities-json`、`dry-run`
- permissionsはworkflow / jobとも `contents: read`
- Secret input、`secrets: inherit`、write permissionは使わない
- `actions/checkout@v4` でcaller repositoryをcheckoutする
- `actions/validate-config` は `nozomu-honda/codex-workflow-kit/actions/validate-config@03d54075f77034124b0b0982200b0d44059bed8a` として明示参照し、caller repositoryの相対pathとは誤認させない

このreusable workflowはGitHub API write、label変更、Issue/PRコメント、自動レビュー、自動マージ、Codex起動、Queue Issue操作を行いません。caller側のreusable workflow refだけでなく、内部Action refもレビュー済み40桁commit SHAへ固定し、`master` / `main`、branch名、短縮SHA、tag参照で内容が変わる状態を避けます。

`.github/workflows/normalize-event.yml` は、実イベント用caller workflowから呼ぶ読み取り専用reusable workflowです。

- inputsはGitHub event name / action、`toJson(github.event)`、repository情報、actor、ref、sha、dry-run、permission mode、requested capability、repository config JSON、`kit-ref`
- outputsは `event_name`、`event_action`、`repository`、`repository_owner`、`default_branch`、`actor`、`issue_number`、`pull_request_number`、`head_sha`、`base_sha`、`head_repository`、`is_same_repository`、`is_fork`、`workflow_name`、`workflow_conclusion`、`dry_run`、`eligible`、`ineligible_reason`
- permissionsはworkflow / jobとも `contents: read`
- Secret input、`secrets: inherit`、write permissionは使わない
- `pull_request_target` は使わない
- `scripts/normalize-event.mjs` と `packages/chatgpt-automation-core/src/events/` の純粋ロジックでpayloadを正規化する
- `issue_comment`、`pull_request_review`、`pull_request_review_comment`、`workflow_run`、`pull_request.closed`、`push` を対象にする
- fork / external PR、失敗workflow_run、未mergeのPR close、default branch以外へのpush、想定外action、入力不備は `eligible=false` にする
- PR上の `issue_comment` はpayloadだけではfork / same-repository境界を検証できないため、PR情報取得契約が追加されるまでは `eligible=false` にする

Issue #23ではイベント受付・正規化・安全判定までを共通化し、ChatGPT review routing、自動マージ、main追従、Codex起動、Queue Issue更新などのwrite処理は後続Issueに分けます。

`.github/workflows/review-routing.yml` は、Issue #23の正規化outputsを使ってChatGPTレビュー依頼のrouting planを作る読み取り専用reusable workflowです。

- inputsはevent payload、repository情報、導入先config JSON、dedupe/cooldown情報、`kit-ref`
- `.github/workflows/normalize-event.yml` を先に呼び、正規化eventが不適格ならfail closedにする
- GitHub API readでPR state、draft、head/base repository、changed files、actor権限を補完する
- outputsは `should_route`、`route_reason`、`skip_reason`、`actor_trust`、`trigger_type`、`ci_satisfied`、`dedupe_key` など
- workflow / job permissionsは `contents: read`、`pull-requests: read`、`issues: read`、`actions: read`、`checks: read`、`statuses: read`
- Secret input、`secrets: inherit`、write permissionは使わない
- `pull_request_target` は使わない
- `scripts/route-review.mjs` と `packages/chatgpt-automation-core/src/review-routing/` の純粋ロジックで判定する
- ChatGPT実行、コメント投稿、ラベル操作、reviewer追加、自動マージ、Codex起動、Queue Issue更新は行わない

Issue #24ではreview routingの条件判定とplan生成までを共通化し、実際のwrite処理はIssue #25以降に分けます。

`.github/workflows/auto-merge-plan.yml` は、正規化outputsとread-only GitHub API結果を使ってChatGPTレビュー済みPRをauto-merge候補にできるかを判定するreusable workflowです。

- inputsはevent payload、repository情報、導入先config JSON、dedupe/cooldown情報、`kit-ref`
- `.github/workflows/normalize-event.yml` を先に呼び、正規化eventが不適格ならfail closedにする
- GitHub API readでPR state、draft、head/base repository、changed files、reviews、review threads、workflow runs、check runs、commit statuses、repository settings、compare結果、actor権限を補完する
- outputsは `eligible`、`should_enable_auto_merge`、`should_merge`、`merge_reason`、`skip_reason`、`ci_satisfied`、`review_is_current`、`secret_like_change`、`dedupe_key` など
- workflow / job permissionsは `contents: read`、`pull-requests: read`、`issues: read`、`actions: read`、`checks: read`、`statuses: read`
- Secret input、`secrets: inherit`、write permissionは使わない
- `pull_request_target` は使わない
- `scripts/plan-auto-merge.mjs` と `packages/chatgpt-automation-core/src/auto-merge/` の純粋ロジックで判定する
- auto-merge有効化、merge queue投入、merge API呼び出し、コメント投稿、ラベル操作、branch削除は行わない

Issue #25ではauto-merge plan生成までを共通化し、実際のwrite処理は後続Issueに分けます。

`.github/workflows/main-follow-up-plan.yml` は、default branchが進んだあとにopen PRの追従状態を分類するreusable workflowです。

- inputsはevent payload、repository情報、導入先config JSON、dedupe key、attempt count、last attempted timestamp、`kit-ref`
- `.github/workflows/normalize-event.yml` を `main-follow-up-plan` capabilityで先に呼び、正規化eventが不適格ならfail closedにする
- GitHub API readでopen PR、changed files、compare結果、head branch存在確認を補完する
- outputsは `plans_json`、`update_candidate_count`、`codex_follow_up_candidate_count`、`manual_review_count`、`skip_reason` など
- workflow / job permissionsは `contents: read`、`pull-requests: read`、`issues: read`、`actions: read`、`checks: read`、`statuses: read`
- Secret input、`secrets: inherit`、write permissionは使わない
- `pull_request_target` は使わない
- `scripts/plan-main-follow-up.mjs` と `packages/chatgpt-automation-core/src/main-follow-up/` の純粋ロジックで判定する
- PR branch update API、Codex起動、Queue Issue更新、コメント投稿、label操作は行わない

Issue #26ではmain follow-up plan生成までを共通化し、実際のwrite処理は後続Issueに分けます。

## Caller workflow template

`templates/workflows/validate-config.yml` は、導入先が `.github/workflows/validate-config.yml` へコピーして使う設定検証用caller workflowテンプレートです。

- triggerは `workflow_dispatch` のみ
- jobはreusable workflowをjob-level `uses` で呼ぶだけ
- permissionsは `contents: read`
- `config-file` は `.github/chatgpt-automation.yml`
- `dry-run` は `true`
- Secret、`secrets: inherit`、`runs-on`、`steps`、`run`、`pull_request_target` は使わない
- reusable workflow refは `REPLACE_WITH_TAG_OR_40_CHAR_COMMIT_SHA` を導入時に `v1.2.3` 形式の完全なversion tagまたは40桁commit SHAへ置換する

`v1` / `v1.2` のような未固定major/minor tagや、`master` / `main` などの可変branch参照は禁止します。初回は `workflow_dispatch` で手動検証し、実イベントのwrite処理は後続Issueで機能ごとに追加します。

`templates/workflows/chatgpt-automation-events.yml` は、導入先が `.github/workflows/chatgpt-automation-events.yml` へコピーして使う実イベント用caller workflowテンプレートです。

- triggerは `issue_comment`、`pull_request_review`、`pull_request_review_comment`、`workflow_run`、`pull_request.closed`、`push`
- jobは `.github/workflows/normalize-event.yml` をjob-level `uses` で呼ぶだけ
- permissionsは `contents: read`
- `event-payload-json` は `toJson(github.event)` を渡す
- `repository-config-json` は導入先Variableから渡せるが、Secret値は渡さない
- reusable workflow refと `kit-ref` は同じ `v1.2.3` 形式の完全なversion tagまたは40桁commit SHAへ置換する
- `push.branches` の `REPLACE_WITH_DEFAULT_BRANCH` は導入先default branch名へ置換する
- Secret、`secrets: inherit`、`runs-on`、`steps`、`run`、`pull_request_target` は使わない

`templates/workflows/chatgpt-review-routing-events.yml` は、導入先が `.github/workflows/chatgpt-review-routing-events.yml` へコピーして使うChatGPT review routing用caller workflowテンプレートです。

- triggerは `issue_comment`、`pull_request_review`、`pull_request_review_comment`、`workflow_run`、`pull_request.closed`、`push`、`workflow_dispatch`
- jobは `.github/workflows/review-routing.yml` をjob-level `uses` で呼ぶだけ
- permissionsはread-onlyの `contents`、`pull-requests`、`issues`、`actions`、`checks`、`statuses`
- `event-payload-json` は `toJson(github.event)` を渡す
- `repository-config-json` とdedupe/cooldown情報は導入先Variableから渡せるが、Secret値は渡さない
- reusable workflow refと `kit-ref` は同じ `v1.2.3` 形式の完全なversion tagまたは40桁commit SHAへ置換する
- Secret、`secrets: inherit`、`runs-on`、`steps`、`run`、`pull_request_target` は使わない

`templates/workflows/reviewed-pr-auto-merge-events.yml` は、導入先が `.github/workflows/reviewed-pr-auto-merge-events.yml` へコピーして使うReviewed PR auto-merge plan用caller workflowテンプレートです。

- triggerは `workflow_run`、`check_suite`、`check_run`、`pull_request_review`、`pull_request_review_comment`、`pull_request.ready_for_review`、`pull_request.synchronize`、`pull_request.closed`、`workflow_dispatch`
- jobは `.github/workflows/auto-merge-plan.yml` をjob-level `uses` で呼ぶだけ
- permissionsはread-onlyの `contents`、`pull-requests`、`issues`、`actions`、`checks`、`statuses`
- `event-payload-json` は `toJson(github.event)` を渡す
- `repository-config-json` とdedupe/cooldown情報は導入先Variableから渡せるが、Secret値は渡さない
- reusable workflow refと `kit-ref` は同じ `v1.2.3` 形式の完全なversion tagまたは40桁commit SHAへ置換する
- Secret、`secrets: inherit`、`runs-on`、`steps`、`run`、`pull_request_target` は使わない

`templates/workflows/main-follow-up-events.yml` は、導入先が `.github/workflows/main-follow-up-events.yml` へコピーして使うMain follow-up plan用caller workflowテンプレートです。

- triggerは `push`、`pull_request.closed`、`workflow_dispatch`
- `push.branches` はhardcodeせず、planner側でdefault branchだけを処理する
- jobは `.github/workflows/main-follow-up-plan.yml` をjob-level `uses` で呼ぶだけ
- permissionsはread-onlyの `contents`、`pull-requests`、`issues`、`actions`、`checks`、`statuses`
- `event-payload-json` は `toJson(github.event)` を渡す
- `repository-config-json`、dedupe key、attempt count、last attempted timestampは導入先Variableから渡せるが、Secret値は渡さない
- reusable workflow refと `kit-ref` は同じ40桁commit SHAへ置換する
- Secret、`secrets: inherit`、`runs-on`、`steps`、`run`、`pull_request_target` は使わない

導入先設定で弱体化できない安全条件:

- 共通hard-block defaults
- fenced code block内markerの無視
- review request commentの判定除外
- 最新 `changes_requested` で停止
- secret-like hard block
- fork / same-repository安全境界

## CI / E2E

`.github/workflows/ci.yml` は、この共通キット自身のPR CIです。

- triggerは `pull_request`、`master` push、`workflow_dispatch`
- workflow / job permissionsは `contents: read` のみ
- 外部Actionはレビュー済み40桁commit SHAで固定する
- Secret、`secrets: inherit`、GitHub API write、release、deploy、tag作成、mergeは使わない
- fork PRでもSecretを渡さず、read-only検証だけを行う
- concurrencyで同一refの重複実行を抑制する

Node 20.19.0以上のjobは、`npm ci` 後に `npm run ci` を実行します。`npm run ci` は `npm test`、`npm run lint`、`npm run validate:config`、`npm run check:action-dist`、`npm run audit:template`、offline consumer E2E、`git diff --check` をまとめて実行するread-only検証です。

Node 24のjobは、GitHub Actions runtimeが `node24` のShared Actionに対して `npm run test:action` と `npm run check:action-dist` を実行します。validatorの入出力仕様やdry-run時のwrite禁止は変えません。

offline consumer E2Eは、`templates/` から一時的な導入先リポジトリを作り、以下を確認します。

- config validator success
- installation audit success
- human-readable / JSON output schema
- `dryRunDefault: true`
- `features`、`queues`、`codex`、`schedules` のcapabilityがすべてdisabled
- caller workflowの `workflow_dispatch` only、`contents: read` only、40桁SHA固定、Secretなし
- invalid fixtureがnon-zero exit codeとstable error codeでfail closedになる
- Secret-like fixture値、絶対path、stack trace、config全文を出力しない

Shared Action source / dist E2Eでは、同じconsumer configを `actions/validate-config/src/index.js` と `actions/validate-config/dist/index.js` の両方へ通し、outputs、fail-closed、capability false、配布物の外部 `node_modules` 非依存を確認します。

GitHub-hosted reusable workflow smokeは、CI内で `uses: ./.github/workflows/validate-config.yml` をjob-levelに呼び出し、専用fixture `reusable-workflows/fixtures/valid-chatgpt-automation.yml` で `ok`、`error-count`、`warning-count`、`capabilities-json`、`dry-run` outputsを後続jobで検証します。offline E2Eは現在headのAction source / distを検証し、smokeはreusable workflowの配線とoutputsを検証する役割です。

実GitHub repositoryを使うcross-repo E2E、導入先Secret / Variables / labels / Queue Issueの作成、GitHub API writeは後続Issueで扱います。

## 導入先側

各リポジトリが保持するもの:

- `issue_comment`
- `pull_request_review`
- `pull_request_review_comment`
- `workflow_run`
- `pull_request.closed`
- `push`

などのイベントを受ける薄いcaller workflow。

さらに、導入先リポジトリ固有の以下を保持します。

- labels
- repository variables
- repository secrets
- fine-grained PAT
- Queue Issue
- project-specific config

## このIssueで行わないこと

- 既存導入先のworkflow/script移植
- 自動レビュー本体の公開
- 自動マージ本体の公開
- GitHub API write処理
- 導入先リポジトリのSecretsやlabels作成
- `pull_request_target` を使うworkflow追加
