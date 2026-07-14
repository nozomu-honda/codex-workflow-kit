# ChatGPT review routing

Issue #24では、Issue #23で正規化したGitHub eventを入力にして、ChatGPTレビュー依頼へ進めるべきかを判定する共通routing layerを追加します。

このlayerはrouting planを作るだけです。ChatGPT API呼び出し、ChatGPT App起動、PRコメント投稿、reaction、label操作、reviewer追加、auto-merge、main追従、Codex起動、Queue Issue更新は行いません。これらのwrite処理はIssue #25以降で扱います。

導入元で使っていたChatGPTレビュー結果markerの副作用なし判定もpure coreへ切り出します。`approved` / `changes_requested` の最新判定、fenced code block内marker除外、review request comment除外、trusted actor modeは共通関数で扱いますが、Issue #24ではラベル変更やQueue更新へは接続しません。

## 責務分離

### caller workflow

導入先側の `templates/workflows/chatgpt-review-routing-events.yml` は薄いcallerです。

- `issue_comment`
- `pull_request_review`
- `pull_request_review_comment`
- `workflow_run`
- `pull_request.closed`
- `push`
- `workflow_dispatch`

callerは実イベントを受け、`toJson(github.event)`、repository情報、actor、導入先Variables、固定refを `.github/workflows/review-routing.yml` へ渡します。複雑な判定、Secret処理、write処理は持ちません。

### reusable workflow

`.github/workflows/review-routing.yml` はread-only reusable workflowです。

1. `.github/workflows/normalize-event.yml` を呼び、Issue #23の正規化outputsを得る。
2. `scripts/route-review.mjs` を実行し、必要なPR情報、changed files、actor権限をGitHub API readで補完する。
3. `packages/chatgpt-automation-core/src/review-routing/` のpure logicでrouting planを作る。
4. 後続workflowが読めるoutputsを公開する。

GitHub APIはreadだけです。write API、Secret input、`secrets: inherit`、`pull_request_target` は使いません。

## 対象イベント

routing対象として扱うイベント:

- `workflow_run` success: required workflowが成功したPRをレビュー依頼候補にする。
- `pull_request_review` / `pull_request_review_comment`: 信頼済みactorの明示commandをレビュー依頼として扱う。
- `workflow_dispatch`: `pull_request_number` を指定した手動dry-run確認。

Issue #23時点と同じく、PR上の `issue_comment` はpayloadだけではprovenanceを安全に確認できないため、共通routingでは `eligible=false` のままです。将来この経路を有効化する場合は、GitHub API readでPR番号、base repository、head repository、head SHA、fork境界、actorを検証し、失敗時はfail closedにします。

`pull_request.closed` と `push` はIssue #23の正規化対象ですが、Issue #24ではChatGPTレビュー起動triggerとしては扱いません。

## review decision detection

`packages/chatgpt-automation-core/src/review-routing/` は、ChatGPTレビュー結果の検出helperも提供します。

- `<!-- chatgpt-review: approved -->`
- `<!-- chatgpt-review: changes_requested -->`

初期値はmarker-onlyです。fenced code block内のmarkerはサンプルとして無視します。`<!-- chatgpt-review-request -->` を含むレビュー依頼コメントも判定対象から除外します。

`review.decisionMode: trusted-actors` と `review.trustedActors` を明示した場合だけ、GitHub review state の `APPROVED` / `CHANGES_REQUESTED` と `## ChatGPT Review` の `status:` headingを判定対象にできます。unknown actorやGitHub Actions botを無条件に信頼しません。

複数の判定ソースがある場合は、timestampが最新の判定を返します。最新が `changes_requested` であれば、後続write workflowは停止側へ倒す想定です。

## actor trust

actorは無条件に信用しません。routing planでは次の分類を返します。

- `repository-owner`
- `collaborator`
- `organization-member`
- `allowlisted-human`
- `allowlisted-bot`
- `github-actions-bot`
- `fork-author`
- `external-actor`
- `unknown`

route可能なのは、repository owner、collaborator、organization member、allowlisted human、allowlisted botだけです。`github-actions[bot]` や未知actorはloop防止のためskipします。

## PR安全判定

最低限、次を満たさないPRは `should_route=false` になります。

- PR番号が取得できる
- PR stateが `open`
- Draft禁止時にdraftではない
- base branchが許可対象
- same-repository PR
- forkではない
- head SHAが正規化eventと一致する
- actorが信頼済み
- required CIが必要なtriggerではCIがsuccess
- sensitive file変更なし
- secret-like追加行なし
- changed files / additions / deletionsが上限以内
- duplicate key未処理
- cooldown中ではない

GitHub API read、config parse、PR取得、files取得、actor権限取得に失敗した場合もfail closedです。

## config

導入先固有値は `reviewRouting` で設定します。

主な項目:

- `enabled`
- `dryRun`
- `allowedBaseBranches`
- `acceptedTriggerTypes`
- `commands`
- `requestLabels`
- `reviewerNames`
- `trustedHumanActors`
- `trustedBotActors`
- `allowDraft`
- `allowFork`
- `requireSameRepository`
- `requiredWorkflows`
- `ignoredPathPatterns`
- `sensitivePathPatterns`
- `maxChangedFiles`
- `maxAdditions`
- `maxDeletions`
- `cooldownSeconds`
- `duplicatePolicy`

`dryRun` は `true` のみ、`allowFork` は `false` のみ、`requireSameRepository` は `true` のみ許可します。これらを弱める設定はvalidatorとJSON Schemaの両方でinvalidです。

## outputs

`.github/workflows/review-routing.yml` は次のoutputsを返します。

- `should_route`
- `route_reason`
- `skip_reason`
- `repository`
- `pull_request_number`
- `head_sha`
- `base_sha`
- `head_repository`
- `base_repository`
- `is_same_repository`
- `is_fork`
- `actor`
- `actor_trust`
- `trigger_type`
- `trigger_source`
- `review_mode`
- `requested_reviewer`
- `requested_label`
- `requested_command`
- `is_draft`
- `ci_required`
- `ci_satisfied`
- `duplicate_suppressed`
- `cooldown_active`
- `dry_run`
- `eligible`
- `dedupe_key`

`skip_reason` は `normalized_event_ineligible`、`actor_not_trusted`、`fork_not_allowed`、`required_ci_not_satisfied`、`sensitive_changed_file`、`secret_like_added_line`、`duplicate_suppressed` などのstable reason codeを含みます。

## dedupe / loop防止

永続writeはIssue #24では行いません。代わりに、routing planは次の形式の `dedupe_key` を出します。

```text
{repository}#{pull_request_number}:{head_sha}:{trigger_type}:v{config_version}
```

導入先や後続workflowはこのkeyを保存または比較して、同一head SHAへの重複レビュー依頼を抑制できます。Issue #24では保存処理は実装しません。

## dry-run

defaultはdry-runです。dry-runでもrouting判定、skip reason、actor trust、PR安全判定、dedupe keyは確認できます。

dry-runでは次を行いません。

- review request作成
- comment投稿
- reaction付与
- label操作
- reviewer追加
- ChatGPT起動
- Codex起動
- Queue Issue更新
- branch更新

## permissions

reusable workflowはread-onlyです。

- `contents: read`
- `pull-requests: read`
- `issues: read`
- `actions: read`
- `checks: read`
- `statuses: read`

`pull_request_target` は使いません。Secret inputも定義しません。`github.token` はGitHub API readにだけ使い、値をログへ出しません。

## 導入

1. `templates/workflows/chatgpt-review-routing-events.yml` を導入先の `.github/workflows/` へコピーする。
2. `REPLACE_WITH_TAG_OR_40_CHAR_COMMIT_SHA` を `v1.2.3` 形式の完全なversion tag、またはレビュー済み40桁commit SHAへ置換する。
3. `REPLACE_WITH_DEFAULT_BRANCH` を導入先default branch名へ置換する。
4. `CHATGPT_AUTOMATION_REVIEW_ROUTING_CONFIG_JSON` へSecret値を含まない設定JSONを置く。
5. `workflow_dispatch` でdry-run確認する。

導入先固有のlabels、Variables、Secrets、Queue Issue番号、PATは導入先に残します。

## Issue #25との境界

Issue #24はrouting planの生成までです。レビュー済みPRのauto-merge判定やmerge API呼び出しはIssue #25で扱います。Issue #24のoutputsを使う場合も、write処理を追加するPRでは別途権限、Secret境界、fork fail-closed、dry-runをレビューします。
