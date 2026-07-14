# Installation

導入先リポジトリでは、薄いcaller workflowからこのリポジトリのreusable workflowまたはActionを呼ぶ想定です。

現在は、設定schema、fail-closed validator、設定検証Action、設定検証reusable workflow、実イベント正規化、ChatGPT review routing plan生成、Reviewed PR auto-merge plan生成、初回確認用caller workflowテンプレートを提供しています。ChatGPT実行、GitHub API writeを伴う自動マージ、Codex起動、Queue Issue操作のwrite workflowは後続Issueで追加します。

## Config

導入先設定ファイル名の想定:

```text
.github/chatgpt-automation.yml
```

このリポジトリにはsampleとして以下を置きます。

```text
templates/chatgpt-automation.yml
```

導入先で使うSecret / Variableは、値ではなく名前だけを設定します。設定値の検証は `packages/chatgpt-automation-core` のfail-closed validatorで行います。

ローカル確認:

```bash
npm ci
npm run validate:config
```

導入先リポジトリ全体の設定とcaller workflowをread-onlyで監査する場合は、[Installation audit CLI](installation-audit.md) を使います。

```bash
node scripts/audit-consumer-installation.mjs --root ../consumer-repo
```

## Validate config caller workflow

初回は設定検証専用caller workflowを手動実行します。

1. 導入先リポジトリへ設定ファイルを追加する。

```text
.github/chatgpt-automation.yml
```

2. このリポジトリのテンプレートを導入先へコピーする。

```text
templates/workflows/validate-config.yml
```

コピー先:

```text
.github/workflows/validate-config.yml
```

3. コピーしたworkflow内のref placeholderを固定refへ置換する。

```text
REPLACE_WITH_40_CHAR_COMMIT_SHA
```

置換先は、このリポジトリのレビュー済み40桁commit SHAにします。`v1` / `v1.2` のような未固定major/minor tagや、`master` / `main` などの可変branch参照は、後から内容が変わるため禁止します。

4. reusable workflow内部のAction参照も40桁commit SHAへ固定されていることを確認する。

現在の `.github/workflows/validate-config.yml` は、レビュー済みcommit `03d54075f77034124b0b0982200b0d44059bed8a` の `actions/validate-config` を参照します。このcommitには `actions/validate-config/action.yml` と `actions/validate-config/dist/index.js` が存在し、Action metadataの `runs.using` が `node24` であることを確認済みです。内部Action refを更新する場合も、40桁commit SHAだけを使い、対象commitにAction metadataと配布物があることを確認します。

5. GitHub Actionsの `workflow_dispatch` で手動実行する。

valid configでは成功し、invalid configではfail closedで失敗します。この確認にSecretは不要で、permissionsは `contents: read` のみです。

手動実行前後にCLIでcaller workflowを監査する場合:

```bash
node scripts/audit-consumer-installation.mjs \
  --root ../consumer-repo \
  --expected-ref 0123456789abcdef0123456789abcdef01234567
```

実イベントのwrite処理は後続Issueで機能ごとに追加します。

## Event caller workflow

実イベントを共通reusable workflowへ接続する場合は、実イベント用caller templateを導入先へコピーします。

```text
templates/workflows/chatgpt-automation-events.yml
```

コピー先:

```text
.github/workflows/chatgpt-automation-events.yml
```

このcaller workflowは次のイベントを受けます。

- `issue_comment`
- `pull_request_review`
- `pull_request_review_comment`
- `workflow_run`
- `pull_request.closed`
- `push`

導入時に置換するもの:

- `REPLACE_WITH_40_CHAR_COMMIT_SHA`: reusable workflow refと `kit-ref` の両方を同じ固定refへ置換する
- `REPLACE_WITH_DEFAULT_BRANCH`: 導入先default branch名へ置換する

固定refは、このリポジトリのレビュー済み40桁commit SHAにします。`master` / `main`、feature branch、短縮SHA、`v1` / `v1.2` は使いません。

caller workflowは `permissions: contents: read` だけを持ち、Secret、`secrets: inherit`、`runs-on`、`steps`、`run`、`pull_request_target` を使いません。導入先固有のlabels、Variables、Secrets、Queue Issue番号は導入先に残します。repository固有設定を渡す場合は、Secret値を含まないJSONを `CHATGPT_AUTOMATION_EVENT_CONFIG_JSON` variableへ置きます。

共通reusable workflow `.github/workflows/normalize-event.yml` は、payloadを正規化し、`eligible` と `ineligible_reason` を含むoutputsを返します。fork / external PR、失敗した `workflow_run`、未mergeの `pull_request.closed`、default branch以外への `push`、想定外action、入力不備は `eligible=false` になります。

Issue #23ではwrite処理を行いません。ChatGPT review routing、自動マージ、main追従、Codex起動、Queue Issue更新は後続Issueで追加します。

## Review routing caller workflow

ChatGPTレビュー依頼へ進めるかをdry-runで判定する場合は、review routing用caller templateを導入先へコピーします。

```text
templates/workflows/chatgpt-review-routing-events.yml
```

コピー先:

```text
.github/workflows/chatgpt-review-routing-events.yml
```

このcaller workflowは次のイベントを受けます。

- `issue_comment`
- `pull_request_review`
- `pull_request_review_comment`
- `workflow_run`
- `pull_request.closed`
- `push`
- `workflow_dispatch`

導入時に置換するもの:

- `REPLACE_WITH_40_CHAR_COMMIT_SHA`: reusable workflow refと `kit-ref` の両方を同じ固定refへ置換する
- `REPLACE_WITH_DEFAULT_BRANCH`: 導入先default branch名へ置換する

caller workflowはread-only permissionsだけを持ち、Secret、`secrets: inherit`、`runs-on`、`steps`、`run`、`pull_request_target` を使いません。導入先固有のreview command、labels、trusted actors、dedupe/cooldown情報はSecret値を含まないVariablesとして渡します。

共通reusable workflow `.github/workflows/review-routing.yml` は、Issue #23の正規化outputsを読み、PR情報、changed files、actor権限をGitHub API readで補完して、`should_route` / `skip_reason` / `actor_trust` / `dedupe_key` を返します。write処理は行いません。

詳細は [ChatGPT review routing](review-routing.md) を参照してください。

## Auto-merge plan caller workflow

ChatGPTレビュー済みPRをauto-merge候補にできるかをdry-runで判定する場合は、auto-merge plan用caller templateを導入先へコピーします。

```text
templates/workflows/reviewed-pr-auto-merge-events.yml
```

コピー先:

```text
.github/workflows/reviewed-pr-auto-merge-events.yml
```

このcaller workflowは次のイベントを受けます。

- `workflow_run`
- `check_suite`
- `check_run`
- `pull_request_review`
- `pull_request_review_comment`
- `pull_request.ready_for_review`
- `pull_request.synchronize`
- `pull_request.closed`
- `workflow_dispatch`

導入時に置換するもの:

- `REPLACE_WITH_40_CHAR_COMMIT_SHA`: reusable workflow refと `kit-ref` の両方を同じ固定refへ置換する

caller workflowはread-only permissionsだけを持ち、Secret、`secrets: inherit`、`runs-on`、`steps`、`run`、`pull_request_target` を使いません。導入先固有のauto-merge設定、dedupe/cooldown情報はSecret値を含まないVariablesとして渡します。

共通reusable workflow `.github/workflows/auto-merge-plan.yml` は、Issue #23の正規化outputsを読み、PR情報、reviews、changed files、CI/check/status、repository settings、actor権限をGitHub API readで補完して、`eligible` / `should_enable_auto_merge` / `should_merge` / `skip_reason` / `dedupe_key` を返します。write処理は行いません。

詳細は [Reviewed PR auto-merge plan](auto-merge.md) を参照してください。

## Main follow-up plan caller workflow

default branchが進んだあとにopen PRの追従状態をdry-runで分類する場合は、main follow-up plan用caller templateを導入先へコピーします。

```text
templates/workflows/main-follow-up-events.yml
```

コピー先:

```text
.github/workflows/main-follow-up-events.yml
```

このcaller workflowは次のイベントを受けます。

- `push`
- `pull_request.closed`
- `workflow_dispatch`

導入時に置換するもの:

- `REPLACE_WITH_40_CHAR_COMMIT_SHA`: reusable workflow refと `kit-ref` の両方を同じ固定refへ置換する

caller workflowはread-only permissionsだけを持ち、Secret、`secrets: inherit`、`runs-on`、`steps`、`run`、`pull_request_target` を使いません。導入先固有のmain follow-up設定、dedupe key、attempt count、last attempted timestampはSecret値を含まないVariablesとして渡します。

共通reusable workflow `.github/workflows/main-follow-up-plan.yml` は、Issue #23の正規化outputsを読み、open PR一覧、個別PR詳細、changed files、固定target base SHAでのcompare、head branch存在確認をGitHub API readで補完して、`plans_json` / `update_candidate_count` / `codex_follow_up_candidate_count` / `manual_review_count` を返します。write処理は行いません。

PR一覧レスポンスのmergeabilityは正本にせず、各PRの `GET /pulls/{pull_number}` を正本にします。scan開始時と終了直前でdefault branch SHAが変わった場合や、PR詳細取得中にhead/base snapshotが変わった場合はfail closedです。

導入後はmain-follow-up用の監査も実行できます。

```bash
node scripts/audit-consumer-installation.mjs \
  --root ../consumer-repo \
  --workflow-kind main-follow-up \
  --expected-ref 0123456789abcdef0123456789abcdef01234567
```

詳細は [Main follow-up plan](main-follow-up.md) を参照してください。

## 将来の導入ステップ

1. 導入先リポジトリでlabelsを作成する
2. 必要なrepository variablesを設定する
3. 必要なrepository secretsまたはfine-grained PATを設定する
4. `.github/chatgpt-automation.yml` を追加する
5. `npm run validate:config` 相当で設定を検証する
6. caller workflow templateを導入先へ追加する
7. dry-runで判定だけを確認する
8. 小さいdocs-only PRでend-to-end確認する

## 互換性

AutoHotkey / `install.ps1` の既存利用者は、このGitHub automation導入手順を使う必要はありません。ローカル入力補助は引き続きREADMEと `docs/install.md` の手順で利用できます。

## Release ref update

導入済みconsumerを新しいkitへ追従する場合も、更新先はversion tagではなくレビュー済み40桁commit SHAです。

`release/consumers.example.yml` のようなSecretを含まないinventoryから、`npm run plan:consumer-updates` で更新計画を作ります。計画はread-onlyで、consumer PR作成やpushは行いません。

rollback時もtagを動かさず、直前のレビュー済み40桁commit SHAへ戻す計画を作り、consumer CIを通してから人間がmerge判断します。詳細は [release-readiness.md](release-readiness.md) を参照してください。
