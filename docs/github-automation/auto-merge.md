# Reviewed PR auto-merge plan

Issue #25では、ChatGPTレビュー済みPRを自動マージ候補にできるかを判定する共通auto-merge plan layerを追加します。

このlayerはplanを作るだけです。GitHub API write、auto-merge有効化、merge queue投入、merge API呼び出し、label操作、comment投稿、branch削除、Codex起動は行いません。実write処理は導入先側の後続workflowで、別Issueとして権限とSecret境界をレビューしてから追加します。

## 責務分離

### caller workflow

導入先側の `templates/workflows/reviewed-pr-auto-merge-events.yml` は薄いcallerです。

- `workflow_run`
- `check_suite`
- `check_run`
- `pull_request_review`
- `pull_request_review_comment`
- `pull_request`
- `workflow_dispatch`

callerは実イベントを受け、`toJson(github.event)`、repository情報、actor、導入先Variables、固定refを `.github/workflows/auto-merge-plan.yml` へ渡します。複雑な判定、Secret処理、write処理は持ちません。

### reusable workflow

`.github/workflows/auto-merge-plan.yml` はread-only reusable workflowです。

1. `.github/workflows/normalize-event.yml` を呼び、Issue #23の正規化outputsを得る。
2. `scripts/plan-auto-merge.mjs` を実行し、必要なPR情報、changed files、reviews、review threads、workflow runs、check runs、commit statuses、repository settings、compare結果、actor権限をGitHub API readで補完する。
3. `packages/chatgpt-automation-core/src/auto-merge/` のpure logicでauto-merge planを作る。
4. 後続workflowが読めるoutputsを公開する。

GitHub APIはreadだけです。write API、Secret input、`secrets: inherit`、`pull_request_target` は使いません。

review threadsはGraphQL cursor paginationで全件取得します。`hasNextPage` が続く場合でも、cursorが空、循環、または上限ページ数を超えた場合はstable error codeで失敗し、auto-merge planは `github_api_read_failed:*` としてfail closedになります。

## auto-merge eligibility

最低限、次を満たさないPRは `eligible=false` になります。

- PR stateが `open`
- draftではない
- base branchが許可対象
- same-repository PR
- forkではない
- head SHAが正規化eventと一致する
- `auto-merge-after-ci` 相当のrequired labelがある
- `reviewed-by-chatgpt` 相当のrequired labelがある
- `do-not-merge`、`needs-codex-fix`、`codex-fix-in-progress` 相当の停止labelがない
- 信頼済みChatGPT actorが投稿したChatGPT review approved markerが最新headに対して有効
- 最新 `changes_requested` がない
- required approval数を満たす。human approvalは `autoMerge.trustedReviewers` に含まれるreviewerの最新current-head reviewだけを数える
- 未解決review threadがない
- requested reviewer / requested team reviewerが残っていない
- required CI / check / statusが最新headでsuccess
- `behind` / `diverged` していない
- merge conflictや `dirty` / `blocked` / `unknown` 状態ではない
- merge methodがrepository設定で許可されている
- workflow / dependency / generated dist / binary / submodule / sensitive path変更がない
- secret-like追加行がない
- changed files / additions / deletionsが上限以内
- duplicate key未処理
- cooldown中ではない
- write相当modeではactorが信頼できる

GitHub API read、config parse、PR取得、files取得、reviews取得、CI取得、actor権限取得に失敗した場合もfail closedです。

## review state

Auto-merge planはreview結果をmerge判断ではなく「merge候補判定」の入力として扱います。

- `<!-- chatgpt-review: approved -->` は `review.trustedActors` に含まれるactorが投稿し、現在headに紐づく場合だけChatGPT approvalとして扱う。
- 信頼済みでないactorのmarkerは、marker本文が正しくても採用しない。
- ChatGPT markerもactor loginごとの最新current-head状態へ正規化する。
- あるChatGPT actorの `changes_requested` は、別ChatGPT actorの `approved` では解除しない。同じactorが同じcurrent headへ後続 `approved` を出した場合だけ解除される。
- stale headのmarker、actorなしmarker、timestampが不正なmarkerはapprovalとして採用しない。不正timestampを含むcurrent-head markerは安全側に倒してblockする。
- human approvalは `autoMerge.trustedReviewers` に含まれるreviewerだけを対象にし、reviewer loginごとの最新current-head reviewを1件だけ数える。
- 同一reviewerの複数 `APPROVED` は重複カウントしない。
- あるreviewerの最新状態が `CHANGES_REQUESTED` の場合、別reviewerの `APPROVED` では解除しない。同じreviewerが現在headへ後続 `APPROVED` を出した場合だけ解除される。
- stale headへの `APPROVED` は現在のapprovalとして数えない。
- 同じGitHub review sourceにChatGPT markerと `APPROVED` review stateが同居する場合は、ChatGPT reviewとしてのみ扱い、human approvalへ二重計上しない。
- issue comment由来のChatGPT markerはhuman approvalにならない。markerなしのGitHub `APPROVED` reviewは、信頼済みhuman reviewerならhuman approvalとして扱う。
- `<!-- chatgpt-review: changes_requested -->` またはGitHub reviewの `CHANGES_REQUESTED` が残る場合は停止する。
- fenced code block内markerとreview request commentは判定対象から除外する。
- bot approvalは `allowBotApproval: true` を明示しない限りapproval数に含めない。
- `requiredApprovals` を満たさない場合はskipする。
- `requireResolvedThreads: true` のとき未解決threadがあればskipする。

## config

導入先固有値は `autoMerge` で設定します。

主な項目:

- `enabled`
- `dryRun`
- `mode`
- `mergeMethod`
- `allowedBaseBranches`
- `requireSameRepository`
- `allowFork`
- `requiredApprovals`
- `allowBotApproval`
- `trustedReviewers`
- `requiredWorkflows`
- `requireResolvedThreads`
- `allowDraft`
- `sensitivePathPatterns`
- `manualMergePathPatterns`
- `maxChangedFiles`
- `maxAdditions`
- `maxDeletions`
- `requireChatGPTReview`
- `requireHumanReview`
- `requireCurrentReview`
- `duplicatePolicy`
- `cooldownSeconds`
- `deleteBranchAfterMerge`
- `useMergeQueue`

`dryRun` は `true` のみ、`allowFork` は `false` のみ、`requireSameRepository` は `true` のみ、`deleteBranchAfterMerge` は `false` のみ許可します。これらを弱める設定はvalidatorとJSON Schemaの両方でinvalidです。

`mode` は次の値を受けます。

- `plan-only`: eligible判定だけを返す。
- `enable-auto-merge`: 後続workflowがauto-merge有効化へ進めることを示す。
- `merge-queue`: 後続workflowがmerge queue投入へ進めることを示す。`useMergeQueue: true` が必須。
- `immediate-merge`: 後続workflowが直接mergeへ進めることを示す。`requiredApprovals >= 1` が必須。

共有キット自身はどのmodeでもwriteしません。`should_merge` や `should_enable_auto_merge` はdry-run planのoutputです。

## outputs

`.github/workflows/auto-merge-plan.yml` は次のoutputsを返します。

- `should_merge`
- `should_enable_auto_merge`
- `merge_mode`
- `merge_method`
- `merge_reason`
- `skip_reason`
- `repository`
- `pull_request_number`
- `base_branch`
- `head_branch`
- `head_sha`
- `base_sha`
- `is_same_repository`
- `is_fork`
- `is_draft`
- `mergeable`
- `merge_state_status`
- `approval_count`
- `required_approval_count`
- `changes_requested`
- `unresolved_review_threads`
- `review_is_current`
- `ci_required`
- `ci_satisfied`
- `required_checks`
- `sensitive_change`
- `secret_like_change`
- `workflow_change`
- `dependency_change`
- `duplicate_suppressed`
- `dry_run`
- `eligible`
- `dedupe_key`

`skip_reason` は `draft_pr`、`fork_not_allowed`、`stale_head`、`changes_requested`、`required_ci_failed`、`merge_conflict`、`workflow_change_requires_manual_merge`、`secret_like_added_line`、`duplicate_suppressed` などのstable reason codeを含みます。

## dedupe / loop防止

永続writeはIssue #25では行いません。代わりに、auto-merge planは次の形式の `dedupe_key` を出します。

```text
{repository}#{pull_request_number}:{head_sha}:{merge_mode}:v{config_version}
```

導入先や後続workflowはこのkeyを保存または比較して、同一head SHA / modeへの重複処理を抑制できます。Issue #25では保存処理は実装しません。

## dry-run

defaultはdry-runです。dry-runでもauto-merge候補判定、skip reason、review state、CI state、change safety、dedupe keyは確認できます。

dry-runでは次を行いません。

- auto-merge有効化
- merge queue投入
- merge API呼び出し
- comment投稿
- reaction付与
- label操作
- reviewer追加
- branch削除
- ChatGPT起動
- Codex起動
- Queue Issue更新

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

1. `templates/workflows/reviewed-pr-auto-merge-events.yml` を導入先の `.github/workflows/` へコピーする。
2. `REPLACE_WITH_TAG_OR_40_CHAR_COMMIT_SHA` を `v1.2.3` 形式の完全なversion tag、またはレビュー済み40桁commit SHAへ置換する。
3. `CHATGPT_AUTOMATION_AUTO_MERGE_CONFIG_JSON` へSecret値を含まない設定JSONを置く。
4. 重複抑制やcooldownを外部で管理する場合は、Secretを含まないVariableでdedupe keyやlast planned timestampを渡す。
5. `workflow_dispatch` でdry-run確認する。

導入先固有のlabels、Variables、Secrets、Queue Issue番号、PATは導入先に残します。write tokenやmerge tokenはIssue #25では使いません。

## Issue #26以降との境界

Issue #25はauto-merge plan生成までです。main追従、Codex follow-up、release / fixed SHA更新運用、導入先での実write workflowは後続Issueで扱います。write処理を追加するPRでは、権限、Secret境界、fork fail-closed、dry-run、dedupe、audit logを別途レビューします。
