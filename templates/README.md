# templates

導入先リポジトリへコピーまたは参照するテンプレートを置く領域です。

想定する内容:

- caller workflow examples
- config examples
- label setup examples
- repository variables / secrets setup notes

実値のSecret、token、OAuth情報、Cookie、実URL、実IDは置きません。

## Caller workflow templates

### `workflows/validate-config.yml`

導入先でChatGPT automation設定を初回検証するための、読み取り専用caller workflowテンプレートです。

コピー先:

```text
.github/workflows/validate-config.yml
```

このテンプレートの特徴:

- triggerは `workflow_dispatch` のみ
- jobはreusable workflowをjob-level `uses` で呼ぶだけ
- permissionsは `contents: read` のみ
- `config-file: .github/chatgpt-automation.yml`
- `dry-run: true`
- Secret、`secrets: inherit`、`runs-on`、`steps`、`run`、`pull_request_target` は使わない

導入手順:

1. `templates/workflows/validate-config.yml` を導入先の `.github/workflows/validate-config.yml` へコピーする。
2. `REPLACE_WITH_TAG_OR_40_CHAR_COMMIT_SHA` を、このリポジトリの `v1.2.3` 形式の完全なversion tagまたは40桁commit SHAへ置換する。
3. `v1` / `v1.2` のような未固定major/minor tagや、`master` / `main` などの可変branch参照は使わない。
4. 導入先に `.github/chatgpt-automation.yml` を置く。
5. GitHub Actionsの `workflow_dispatch` で手動実行し、valid configでは成功、invalid configではfail closedで失敗することを確認する。

コピー後は `scripts/audit-consumer-installation.mjs` で、導入先のconfigとcaller workflowをread-only監査できます。詳細は `docs/github-automation/installation-audit.md` を参照してください。

### `workflows/chatgpt-automation-events.yml`

導入先で実GitHubイベントを受け、共通reusable workflowへ渡すための、読み取り専用caller workflowテンプレートです。

コピー先:

```text
.github/workflows/chatgpt-automation-events.yml
```

このテンプレートの特徴:

- triggerは `issue_comment`、`pull_request_review`、`pull_request_review_comment`、`workflow_run`、`pull_request.closed`、`push`
- jobは `.github/workflows/normalize-event.yml` をjob-level `uses` で呼ぶだけ
- permissionsは `contents: read` のみ
- `event-payload-json` に `toJson(github.event)` を渡す
- `dry-run: true`
- `permission-mode: read-only`
- `requested-capability: normalize-only`
- Secret、`secrets: inherit`、`runs-on`、`steps`、`run`、`pull_request_target` は使わない

導入手順:

1. `templates/workflows/chatgpt-automation-events.yml` を導入先の `.github/workflows/chatgpt-automation-events.yml` へコピーする。
2. 2か所の `REPLACE_WITH_TAG_OR_40_CHAR_COMMIT_SHA` を、このリポジトリの同じ `v1.2.3` 形式の完全なversion tagまたは40桁commit SHAへ置換する。
3. `REPLACE_WITH_DEFAULT_BRANCH` を導入先のdefault branch名へ置換する。
4. repository固有設定を渡す場合は、導入先Variable `CHATGPT_AUTOMATION_EVENT_CONFIG_JSON` にSecret値を含まないJSONを設定する。
5. 初回はdry-runのまま、正規化outputsと `eligible` / `ineligible_reason` を確認する。

このテンプレートはイベント受付と正規化だけを行います。ChatGPT review routing、自動マージ、main追従、Codex起動、Queue Issue更新は後続Issueで追加します。

### `workflows/chatgpt-review-routing-events.yml`

導入先で実GitHubイベントを受け、ChatGPT review routing planを共通reusable workflowで作るための、読み取り専用caller workflowテンプレートです。

コピー先:

```text
.github/workflows/chatgpt-review-routing-events.yml
```

このテンプレートの特徴:

- triggerは `issue_comment`、`pull_request_review`、`pull_request_review_comment`、`workflow_run`、`pull_request.closed`、`push`、`workflow_dispatch`
- jobは `.github/workflows/review-routing.yml` をjob-level `uses` で呼ぶだけ
- permissionsはread-onlyの `contents`、`pull-requests`、`issues`、`actions`、`checks`、`statuses`
- `event-payload-json` に `toJson(github.event)` を渡す
- `dry-run: true`
- Secret、`secrets: inherit`、`runs-on`、`steps`、`run`、`pull_request_target` は使わない

導入手順:

1. `templates/workflows/chatgpt-review-routing-events.yml` を導入先の `.github/workflows/chatgpt-review-routing-events.yml` へコピーする。
2. 2か所の `REPLACE_WITH_TAG_OR_40_CHAR_COMMIT_SHA` を、このリポジトリの同じ `v1.2.3` 形式の完全なversion tagまたは40桁commit SHAへ置換する。
3. `REPLACE_WITH_DEFAULT_BRANCH` を導入先のdefault branch名へ置換する。
4. repository固有設定を渡す場合は、導入先Variable `CHATGPT_AUTOMATION_REVIEW_ROUTING_CONFIG_JSON` にSecret値を含まないJSONを設定する。
5. 重複抑制やcooldownを外部で管理する場合は、Secretを含まないVariableでdedupe keyやlast routed timestampを渡す。
6. 初回はdry-runのまま、`should_route`、`skip_reason`、`actor_trust`、`dedupe_key` を確認する。

このテンプレートはrouting planの生成だけを行います。ChatGPT実行、コメント投稿、reaction、label操作、reviewer追加、自動マージ、Codex起動、Queue Issue更新は後続Issueで追加します。

### `workflows/reviewed-pr-auto-merge-events.yml`

導入先で実GitHubイベントを受け、Reviewed PR auto-merge planを共通reusable workflowで作るための、読み取り専用caller workflowテンプレートです。

コピー先:

```text
.github/workflows/reviewed-pr-auto-merge-events.yml
```

このテンプレートの特徴:

- triggerは `workflow_run`、`check_suite`、`check_run`、`pull_request_review`、`pull_request_review_comment`、`pull_request.ready_for_review`、`pull_request.synchronize`、`pull_request.closed`、`workflow_dispatch`
- jobは `.github/workflows/auto-merge-plan.yml` をjob-level `uses` で呼ぶだけ
- permissionsはread-onlyの `contents`、`pull-requests`、`issues`、`actions`、`checks`、`statuses`
- `event-payload-json` に `toJson(github.event)` を渡す
- `dry-run: true`
- Secret、`secrets: inherit`、`runs-on`、`steps`、`run`、`pull_request_target` は使わない

導入手順:

1. `templates/workflows/reviewed-pr-auto-merge-events.yml` を導入先の `.github/workflows/reviewed-pr-auto-merge-events.yml` へコピーする。
2. 2か所の `REPLACE_WITH_TAG_OR_40_CHAR_COMMIT_SHA` を、このリポジトリの同じ `v1.2.3` 形式の完全なversion tagまたは40桁commit SHAへ置換する。
3. repository固有設定を渡す場合は、導入先Variable `CHATGPT_AUTOMATION_AUTO_MERGE_CONFIG_JSON` にSecret値を含まないJSONを設定する。
4. 重複抑制やcooldownを外部で管理する場合は、Secretを含まないVariableでdedupe keyやlast planned timestampを渡す。
5. 初回はdry-runのまま、`eligible`、`should_enable_auto_merge`、`should_merge`、`skip_reason`、`dedupe_key` を確認する。

このテンプレートはauto-merge planの生成だけを行います。auto-merge有効化、merge queue投入、merge API呼び出し、コメント投稿、label操作、branch削除は後続Issueで追加します。
