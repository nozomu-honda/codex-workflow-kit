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
git diff --check
```

`npm run validate:config` は `templates/chatgpt-automation.yml` を検証します。任意の設定ファイルを検証する場合は以下を使えます。

```bash
node scripts/validate-config.mjs path/to/chatgpt-automation.yml
```
