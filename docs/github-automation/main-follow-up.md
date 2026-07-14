# Main follow-up plan

Main follow-up planは、default branchが進んだあとにopen PRをどう扱うべきかをread-onlyで分類する共通基盤です。

このIssueでは、PR branch update、Codex起動、Queue Issue更新、コメント投稿、label操作、GitHub API writeは実装しません。共通側はplan outputsを返すだけで、導入先が後続Issueでwrite workflowを追加する前提です。

## 対象trigger

導入先caller templateは次だけを受けます。

- `push`
- `pull_request.closed`
- `workflow_dispatch`

`push` はcaller側でbranch名を固定せず、plannerが導入先repositoryのdefault branchだけを処理します。`main` / `master` などを共通側にhardcodeしません。

`pull_request.closed` はmerged PRだけを対象にします。未merge closeは `pull_request_not_merged` でskipします。

`workflow_dispatch` はPR番号なしでも全open PR scanとして使えます。

## 責務境界

| 領域 | 責務 |
| --- | --- |
| 導入先caller workflow | 実イベントを受け、payloadとSecretを含まないVariablesをreusable workflowへ渡す |
| 共通reusable workflow | event正規化、read-only GitHub API read、planner script実行、outputs生成 |
| core | 設定検証、PR分類、危険変更判定、dedupe key生成 |
| 後続write workflow | PR branch update、Codex follow-up起動、Queue Issue更新などを別Issueで実装 |

## Classification

PRごとの `action` は次のいずれかです。

| action | 意味 | write候補 |
| --- | --- | --- |
| `up-to-date` | default branchに追従済み | なし |
| `behind-update-candidate` | safeな差分でbranch update候補 | 将来のPR branch update候補 |
| `conflict-follow-up-candidate` | conflictがありCodex follow-up候補 | 将来のCodex follow-up候補 |
| `update-failed-follow-up-candidate` | branch update失敗相当でCodex follow-up候補 | 将来のCodex follow-up候補 |
| `manual-review-required` | 人間確認が必要 | なし |
| `ineligible` | label、fork、draft、attemptなど条件不足 | なし |

`conflict-follow-up-candidate` と `update-failed-follow-up-candidate` は `mainFollowUp.codexFollowUpEnabled: true` の場合だけ出ます。falseの場合はmanual review requiredに倒します。

## Safety rules

次は必ずmanual reviewまたはineligibleにします。

- fork / external PR
- same-repositoryではないPR
- draft PR
- head SHA欠落
- head branch欠落
- blocked labelあり
- required label不足
- attempt上限超過
- cooldown中
- duplicate dedupe key
- workflow変更
- dependency変更
- generated dist変更
- protected path変更
- sensitive path変更
- binary / submodule変更
- secret-like added line
- compare不明
- mergeability不明
- diff件数や追加削除行数の上限超過
- GitHub API read失敗

これらはCodex follow-up候補にもPR branch update候補にも進めません。

## Outputs

Reusable workflow `.github/workflows/main-follow-up-plan.yml` は次のoutputsを返します。

- `eligible`
- `repository`
- `default_branch`
- `base_sha`
- `trigger_type`
- `scanned_pull_request_count`
- `up_to_date_count`
- `update_candidate_count`
- `codex_follow_up_candidate_count`
- `manual_review_count`
- `skipped_count`
- `plans_json`
- `skip_reason`
- `dry_run`

`plans_json` はPRごとの分類配列です。Secret、token、Cookie、OAuth情報、payload本文、実URLは含めません。

## Dedupe key

PRごとのdedupe keyは次の形式です。

```text
{repository}#{pull_request_number}:{head_sha}:{base_sha}:main-follow-up:v{config_version}
```

同じhead/baseの重複実行を抑制するために使います。dedupe keyの保存やQueue Issue更新はこのIssueでは行いません。

## Config

`mainFollowUp` はdefault disabledです。

```yaml
mainFollowUp:
  enabled: false
  dryRun: true
  allowedBaseBranches: []
  requiredLabels: [auto-merge-after-ci]
  blockedLabels:
    - do-not-merge
    - needs-codex-fix
    - codex-fix-in-progress
    - do-not-auto-codex-main-followup
    - codex-main-followup-in-progress
  allowDraft: false
  requireSameRepository: true
  allowFork: false
  maxAttempts: 2
  cooldownSeconds: 0
  maxOpenPullRequests: 100
  maxChangedFiles: 100
  maxAdditions: 2000
  maxDeletions: 2000
  duplicatePolicy: dedupe-key
  codexFollowUpEnabled: false
```

`dryRun: false`、`allowFork: true`、`requireSameRepository: false` はfail closedです。

## Caller template

導入先には次をコピーします。

```text
templates/workflows/main-follow-up-events.yml
```

コピー先:

```text
.github/workflows/main-follow-up-events.yml
```

置換するもの:

- `REPLACE_WITH_TAG_OR_40_CHAR_COMMIT_SHA`

reusable workflow refと `kit-ref` は同じ40桁commit SHAへ置換します。branch、tag、短縮SHA、placeholderのままの本番利用は禁止します。

## Installation audit

main-follow-up callerもread-only CLIで監査できます。

```bash
node scripts/audit-consumer-installation.mjs \
  --root ../consumer-repo \
  --workflow-kind main-follow-up \
  --expected-ref 0123456789abcdef0123456789abcdef01234567
```

監査では次を確認します。

- `push` / `pull_request.closed` / `workflow_dispatch` だけ
- `pull_request_target` なし
- read-only permissionsだけ
- job-level reusable workflow呼び出しだけ
- fixed 40-character SHA
- `dry-run: true`
- Secretなし
- `secrets: inherit` なし
- `runs-on` / `steps` / inline `run` なし

## Validation

主な確認コマンド:

```bash
npm run test:main-follow-up
npm run lint:main-follow-up
npm run test:audit
npm run lint:audit
npm run test:e2e:consumer
npm run ci
```

## このIssueで行わないこと

- PR branch update API
- Codex実起動
- Queue Issue更新
- コメント投稿
- label操作
- GitHub API write
- auto-merge
- deploy
- release
