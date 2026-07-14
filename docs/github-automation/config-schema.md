# Config schema

ChatGPT automation configは、導入先リポジトリごとの差分を安全に表現するための設定です。

このIssueで追加する正本:

- Machine contract: `packages/chatgpt-automation-core/src/config/index.js`
- JSON Schema: `schemas/chatgpt-automation.schema.json`
- Sample config: `templates/chatgpt-automation.yml`
- Local command: `npm run validate:config`

機械判定の正本はfail-closed validatorです。JSON Schemaは構造契約としてvalidatorと代表fixtureのparity testで整合させます。normalized config、warnings、capabilitiesはvalidatorだけが返します。

## File name

導入先では、原則として次の設定ファイル名を使います。

```text
.github/chatgpt-automation.yml
```

このリポジトリではsampleとして `templates/chatgpt-automation.yml` を置きます。導入先のcaller workflowやreusable workflowは、このIssueでは追加しません。

## Version

`version` は必須です。

現在サポートするversion:

```yaml
version: 1
```

未対応versionやversion欠落はfail closedになり、全capabilityは `false` になります。

## Safety defaults

validatorは次の安全defaultを常に保持します。

- 共通hard-block file patterns
- secret-like hard-block patterns
- fenced code block内markerの無視
- review request commentの判定除外
- 最新 `changes_requested` を停止条件にすること
- fork / cross-repository PRをCodex自動修正対象にしないsame-repository境界
- ChatGPT review routingのdry-run default、fork禁止、same-repository必須
- Reviewed PR auto-merge planのdry-run default、fork禁止、same-repository必須、branch削除禁止
- Main follow-up planのdry-run default、fork禁止、same-repository必須、危険変更のmanual review化

導入先設定は、これらを削除または弱体化できません。弱体化を試みる設定はvalidation errorになります。

## Capabilities

validatorは副作用を持たず、構造化結果だけを返します。

```js
{
  ok: boolean,
  config: normalizedConfig | null,
  errors: [{ path, code, message }],
  warnings: [{ path, code, message }],
  capabilities: {
    autoRequest: boolean,
    routeReview: boolean,
    autoMerge: boolean,
    mainFollowup: boolean,
    actionsApproval: boolean
  }
}
```

`ok: false` の場合、`config` は `null` になり、すべてのcapabilityは `false` になります。呼び出し側は文字列解析ではなく、この構造化結果で安全判断します。

## Secret and variable names

設定には実値ではなく、repository secret / variableの名前だけを書きます。

許可される形式:

```text
^[A-Z_][A-Z0-9_]*$
```

例:

```yaml
secrets:
  autoMergeToken: AUTO_MERGE_TOKEN

variables:
  codexTrigger: CODEX_TRIGGER_COMMENT
```

Secret値、token値、Cookie、OAuth情報、実URL、実IDはsample、tests、docsへ入れません。

## Unknown keys

unknown keyはwarningになります。ただし、安全に関係する既知keyの型不一致や無効化要求はerrorです。

## Cron

scheduleのcronはGitHub Actionsで使う5フィールドcronの安全な数値subsetとして検証します。

対応する構文:

- `*`
- 数値
- 範囲: `1-5`
- list: `1,3,5`
- step: `*/15`, `20/15`, `1-10/2`

値域:

| Field | Range |
|---|---|
| minute | `0-59` |
| hour | `0-23` |
| day of month | `1-31` |
| month | `1-12` |
| day of week | `0-6` |

`SUN-SAT` のような曜日名はこの初期schemaでは扱いません。値域外、step 0、逆順range、不正構文はfail closedになります。

## Auto-merge mode

`autoMerge.mode` はauto-merge候補planの種類だけを表します。

- `plan-only`: 判定結果だけを返す。
- `enable-auto-merge`: 後続workflowがauto-merge有効化へ進める候補であることを返す。
- `merge-queue`: 後続workflowがmerge queue投入へ進める候補であることを返す。`useMergeQueue: true` が必要です。
- `immediate-merge`: 後続workflowが直接mergeへ進める候補であることを返す。`requiredApprovals >= 1` が必要です。

共有キット自身はどのmodeでもGitHub API writeやmergeを行いません。`dryRun` は `true` のみ許可し、`allowFork: true`、`requireSameRepository: false`、`deleteBranchAfterMerge: true` はschemaとvalidatorの両方でinvalidです。

Reviewed PR auto-merge planでは、`labels.autoMergeAfterCi` と `labels.reviewedByChatGpt` の両方がPRに付いていることを必須にします。片方だけではeligibleになりません。`labels.reviewedByChatGpt` の設定名が欠落・空文字・不正型の場合もvalidatorまたはplan判定でfail closedになります。

ChatGPT review markerは `review.trustedActors` に含まれるactorからのものだけを採用します。human approvalは `autoMerge.trustedReviewers` に含まれるreviewer loginの最新current-head reviewだけを数えます。外部actor、unknown actor、未設定reviewer、stale headへのapprovalはapproval数へ入りません。

## Main follow-up

`mainFollowUp` はdefault branch追従planの設定です。共通キットはplan生成だけを行い、PR branch update API、Codex起動、Queue Issue更新、コメント投稿、label操作は行いません。

- `enabled` はdefault `false`
- `dryRun` は `true` のみ許可
- `allowFork` は `false` のみ許可
- `requireSameRepository` は `true` のみ許可
- `duplicatePolicy` は `dedupe-key` または `allow-rerun`
- `codexFollowUpEnabled` はCodex follow-up候補を出すかどうかだけを表し、実起動はしない

workflow、dependency、generated dist、protected path、sensitive path、binary/submodule、secret-like added lineはmanual review requiredへ倒します。

## Logical fields and defaults

後続Issueで既存導入先設定からmappingできるよう、主要な論理フィールドとdefaultを記録します。このIssueでは既存 `.chatgpt-review.json` 互換layerは実装しません。

| Logical field | Default |
|---|---|
| `version` | `1` |
| `mergeMethod` | `squash` |
| `dryRunDefault` | `true` |
| `features.autoRequest` | `false` |
| `features.routeReview` | `false` |
| `features.autoMerge` | `false` |
| `features.mainFollowup` | `false` |
| `features.actionsApproval` | `false` |
| `labels.needsChatGptReview` | `needs-chatgpt-review` |
| `labels.reviewedByChatGpt` | `reviewed-by-chatgpt` |
| `labels.needsCodexFix` | `needs-codex-fix` |
| `labels.codexFixInProgress` | `codex-fix-in-progress` |
| `labels.autoMergeAfterCi` | `auto-merge-after-ci` |
| `labels.doNotMerge` | `do-not-merge` |
| `labels.doNotAutoReviewRequest` | `do-not-auto-review-request` |
| `labels.doNotAutoCodexFix` | `do-not-auto-codex-fix` |
| `labels.doNotAutoCodexMainFollowup` | `do-not-auto-codex-main-followup` |
| `labels.codexMainFollowupInProgress` | `codex-main-followup-in-progress` |
| `labels.doNotAutoApproveActions` | `do-not-auto-approve-actions` |
| `review.decisionMode` | `marker-only` |
| `review.markers.approved` | `<!-- chatgpt-review: approved -->` |
| `review.markers.changesRequested` | `<!-- chatgpt-review: changes_requested -->` |
| `review.markers.reviewRequest` | `<!-- chatgpt-review-request -->` |
| `review.markers.ignoreInFencedCodeBlocks` | `true` |
| `review.markers.excludeReviewRequestComments` | `true` |
| `review.decisions.stopOnLatestChangesRequested` | `true` |
| `reviewRouting.enabled` | `false` |
| `reviewRouting.dryRun` | `true` |
| `reviewRouting.acceptedTriggerTypes` | `ci-success`, `trusted-review-command`, `manual-review-request` |
| `reviewRouting.commands` | `/chatgpt-review` |
| `reviewRouting.requestLabels` | `needs-chatgpt-review` |
| `reviewRouting.allowDraft` | `false` |
| `reviewRouting.allowFork` | `false` |
| `reviewRouting.requireSameRepository` | `true` |
| `reviewRouting.maxChangedFiles` | `100` |
| `reviewRouting.maxAdditions` | `2000` |
| `reviewRouting.maxDeletions` | `2000` |
| `reviewRouting.cooldownSeconds` | `0` |
| `reviewRouting.duplicatePolicy` | `dedupe-key` |
| `autoMerge.enabled` | `false` |
| `autoMerge.dryRun` | `true` |
| `autoMerge.mode` | `plan-only` |
| `autoMerge.mergeMethod` | `squash` |
| `autoMerge.requireSameRepository` | `true` |
| `autoMerge.allowFork` | `false` |
| `autoMerge.requiredApprovals` | `1` |
| `autoMerge.allowBotApproval` | `false` |
| `autoMerge.requiredWorkflows` | `ciWorkflowName` |
| `autoMerge.requireResolvedThreads` | `true` |
| `autoMerge.allowDraft` | `false` |
| `autoMerge.maxChangedFiles` | `100` |
| `autoMerge.maxAdditions` | `2000` |
| `autoMerge.maxDeletions` | `2000` |
| `autoMerge.requireChatGPTReview` | `true` |
| `autoMerge.requireHumanReview` | `false` |
| `autoMerge.requireCurrentReview` | `true` |
| `autoMerge.duplicatePolicy` | `dedupe-key` |
| `autoMerge.cooldownSeconds` | `0` |
| `autoMerge.deleteBranchAfterMerge` | `false` |
| `autoMerge.useMergeQueue` | `false` |
| `mainFollowUp.enabled` | `false` |
| `mainFollowUp.dryRun` | `true` |
| `mainFollowUp.requiredLabels` | `auto-merge-after-ci` |
| `mainFollowUp.allowDraft` | `false` |
| `mainFollowUp.requireSameRepository` | `true` |
| `mainFollowUp.allowFork` | `false` |
| `mainFollowUp.maxAttempts` | `2` |
| `mainFollowUp.cooldownSeconds` | `0` |
| `mainFollowUp.maxOpenPullRequests` | `100` |
| `mainFollowUp.maxChangedFiles` | `100` |
| `mainFollowUp.maxAdditions` | `2000` |
| `mainFollowUp.maxDeletions` | `2000` |
| `mainFollowUp.duplicatePolicy` | `dedupe-key` |
| `mainFollowUp.codexFollowUpEnabled` | `false` |
| `codex.reviewFix.maxAttempts` | `2` |
| `codex.reviewFix.sameRepoOnly` | `true` |
| `codex.reviewFix.allowDraft` | `false` |
| `codex.mainFollowup.maxAttempts` | `2` |
| `codex.mainFollowup.sameRepoOnly` | `true` |
| `codex.mainFollowup.allowDraft` | `false` |
| `secrets.reviewRequestCommentToken` | `REVIEW_REQUEST_COMMENT_TOKEN` |
| `secrets.prBranchUpdateToken` | `PR_BRANCH_UPDATE_TOKEN` |
| `secrets.autoMergeToken` | `AUTO_MERGE_TOKEN` |
| `secrets.actionsApproverToken` | `ACTIONS_APPROVER_TOKEN` |
| `variables.codexTrigger` | `CODEX_TRIGGER_COMMENT` |
| `variables.mainFollowupEnabled` | `MAIN_FOLLOWUP_CODEX_AUTO_FIX` |
| `variables.reviewFixMaxAttempts` | `CODEX_AUTO_FIX_MAX_ATTEMPTS` |
| `variables.mainFollowupMaxAttempts` | `MAIN_FOLLOWUP_CODEX_AUTO_FIX_MAX_ATTEMPTS` |

## Local validation

```bash
npm ci
npm test
npm run lint
npm run validate:config
npm run test:review-routing
npm run test:auto-merge
npm run test:main-follow-up
git diff --check
```

`npm run validate:config` は `templates/chatgpt-automation.yml` を検証します。任意の設定ファイルを検証する場合は以下を使えます。

```bash
node scripts/validate-config.mjs path/to/chatgpt-automation.yml
```
