# Auto-merge dry-run executor

Issue #41では、Reviewed PR auto-mergeの実writeへ進む前段として、既存のread-only判定結果を1か所で集約するdry-run executorを追加します。

このexecutorは最終decisionを作りますが、GitHub API write、auto-merge有効化、merge queue投入、merge API呼び出し、comment、label、Queue Issue更新、deploy、release、tag作成は行いません。すべての事前条件が成功しても、最後は `DisabledGitHubWriteAdapter` が `write_disabled` で拒否し、`executed=false` を維持します。

## 入力report

`packages/chatgpt-automation-core/src/auto-merge-executor/` はpure functionです。CLIは `scripts/execute-auto-merge-dry-run.mjs` です。

主な入力:

- `autoMergePlan`: `.github/workflows/auto-merge-plan.yml` / `createAutoMergePlan()` のoutputs
- `reviewEvidenceReport`: current headに対するreview evidence report
- `consumerAuditReport`: `live-consumer-audit.v1`
- `protectionAuditReport`: Repository protection audit report v1
- `pullRequestSnapshot`: current PR state / head SHA / base SHA / mergeability
- `checkSnapshot`: CI、required checks、Review evidence gateのcurrent head結果
- `changedFilesSnapshot`: dangerous file、Secret-like追加、workflow権限増加、`pull_request_target`
- `executionContext`: repository、PR番号、current head/base SHA、許可base branch、attempt/cooldown/idempotency、trusted actor context、時刻

各reportは使用前にschema検証します。unknown key、required field不足、型不正、version不一致、repository/PR番号/SHA不一致、timestamp欠落・不正、期限切れ、pagination未完了、API read failure、不明状態はfail closedです。`apiReadOk` とpagination対象reportの `paginationComplete` は、明示的なboolean `true` だけを成功扱いにします。手動Ruleset確認の自己申告booleanだけでは通しません。schema検証済みのprotection audit reportを要求します。

安全判定に使う主なrequired field:

- `reviewEvidenceReport`: `apiReadOk`、`paginationComplete`、`checkedAt`、`reviewedAt`、`headSha`、`baseSha`、`approved`、`changesRequested`、`currentRunEvidence`、`blockers`、review thread / requested reviewer件数
- `consumerAuditReport`: `apiReadOk`、`paginationComplete`、`checkedAt`、`auditedCommitSha`、`defaultBranch`、`ready`、`manualReviewRequired`、`blockers`
- `protectionAuditReport`: `apiReadOk`、`paginationComplete`、`checkedAt`、`auditedSha`、`ready`、`manualReviewRequired`、`blockers`
- `changedFilesSnapshot`: `apiReadOk`、`headSha`、`files`、`dangerousChange`、`secretLikeChange`、`workflowPermissionIncrease`、`pullRequestTarget`
- `checkSnapshot`: `apiReadOk`、`paginationComplete`、`headSha`、CI / required check / Review evidence gateの判定結果

`changedFilesSnapshot.headSha` は `executionContext.currentHeadSha` と完全一致する必要があります。reportの取得後にPR headが変わった場合は `report_head_sha_mismatch` で停止します。review evidenceの `blockers` が1件でもあれば承認済みとして扱いません。consumer / protection auditも、read failure、pagination未完了、manual review、blocker、timestamp欠落のいずれかがあれば停止します。

`consumerAuditReport` と `protectionAuditReport` はPR番号やPR headを監査するreportではありません。どちらも導入先repositoryのdefault branchを監査するproducer出力を正本とします。executorでは、consumer auditの `auditedCommitSha` と protection auditの `auditedSha` を `executionContext.currentBaseSha` / PR `baseSha` と比較し、各reportの `defaultBranch` をPR base branchと比較します。current PR head固有の安全性は `reviewEvidenceReport`、`changedFilesSnapshot`、`checkSnapshot`、`pullRequestSnapshot` で検証します。

## freshness

report freshnessの基準時刻は `executionContext.now` です。`now` はexecutor decisionを作る時刻、`checkedAt` は各producerがreportを取得・確定した時刻、`reviewedAt` はreview evidence自体が作られた時刻を表します。

各reportの `checkedAt` は `executionContext.now` 以前である必要があります。ただしGitHub Actions job間やAPI producer間の微小な時計差を吸収するため、executorは `60_000ms` の固定clock skewだけを許容します。この値は無制限に広げず、設定入力から変更しません。`executionContext.now + 60_000ms` を1msでも超える `checkedAt` / `reviewedAt` は `report_from_future` でfail closedします。review evidenceの `reviewedAt` は同じreportの `checkedAt` より後でもあってはならず、この場合も `report_from_future` で停止します。

古すぎるreportは `report_expired`、未来時刻のreportは `report_from_future` として区別します。`now`、`checkedAt`、`reviewedAt` の形式が不正な場合は、既存どおり `report_schema_invalid` で停止します。`reviewedAt` が未来すぎない場合でも、dry-runの `runStartedAt` 以後に生成されたreview evidenceは同一run内証跡として `review_evidence_from_current_run` で停止します。

## 事前条件

write command候補を作るのは、最低限すべて満たした場合だけです。

- PRがopen、non-draft、same repository、non-fork
- current head SHA / base SHAがplan、review evidence、audit、snapshotと一致
- consumer auditの `auditedCommitSha` と protection auditの `auditedSha` がcurrent base/default branch SHAと一致
- consumer / protection auditの `defaultBranch` がPR base branchと一致
- base branchが許可対象
- mergeableが安全にtrueで、merge stateが安全
- current-head review evidenceがあり、staleでも同一run内生成でもない
- changes requested、未解決review thread、requested reviewer / teamが残っていない
- CI、required checks、Review evidence gateがcurrent headで成功
- protection audit ready
- live consumer audit ready
- dangerous file、Secret-like追加、workflow権限増加、`pull_request_target` がない
- duplicate operationではない
- attempt上限内、cooldown外
- trusted actor contextがある

1件でも不明ならblockします。PR #130相当の「CI成功・mergeable・review evidenceなし」は `review_evidence_missing` でblockし、write commandを生成しません。

## write command

executorは独自command形式を持ちません。既存の `packages/chatgpt-automation-core/src/github-write/` のconverterでauto-merge planからcommand候補を作り、同じvalidatorへ通します。

禁止:

- executor独自のcommand schema
- actor trustの自動補完
- expected head/base SHAなしcommand
- `dryRun=false`
- generic plan source
- 実GitHub write adapter

本番経路で使うadapterは `DisabledGitHubWriteAdapter` のみです。valid commandでも結果は次になります。

```json
{
  "adapterAccepted": false,
  "executed": false,
  "reasonCodes": ["write_disabled"]
}
```

`FakeGitHubWriteAdapter` はunit / offline E2E限定です。

## reason code

代表的なstable reason code:

- `review_evidence_missing`
- `stale_review_head`
- `review_evidence_from_current_run`
- `report_schema_invalid`
- `report_repository_mismatch`
- `report_pull_request_mismatch`
- `report_head_sha_mismatch`
- `report_base_sha_mismatch`
- `report_expired`
- `report_from_future`
- `ci_not_successful`
- `required_check_missing`
- `protection_audit_not_ready`
- `consumer_audit_not_ready`
- `dangerous_change_detected`
- `secret_like_change_detected`
- `unresolved_review_thread`
- `requested_reviewer_remaining`
- `duplicate_operation`
- `attempt_limit_exceeded`
- `cooldown_active`
- `write_command_invalid`
- `write_disabled`
- `unknown_state`

## sanitized audit record

出力してよいもの:

- repository
- PR番号
- expected head/base SHA
- report version
- blocker reason code
- command operation
- dryRun
- accepted / executed

出力しないもの:

- token、Cookie、Authorization、Secret
- GitHub API response全文
- private URL
- plan/report全文
- actorの不要な内部ID
- 個人情報

## CLI

```bash
node scripts/execute-auto-merge-dry-run.mjs \
  --auto-merge-plan auto-merge-plan.json \
  --review-evidence review-evidence.json \
  --consumer-audit consumer-audit.json \
  --protection-audit protection-audit.json \
  --pull-request pull-request.json \
  --checks checks.json \
  --changed-files changed-files.json \
  --execution-context execution-context.json \
  --json
```

このCLIはoffline / dry-run onlyです。token入力は不要で、network writeもGitHub API writeも行いません。`--no-dry-run` は拒否します。

CLI exit codeは、判定として有効なdecisionとsystem errorを分離します。eligible / blockedのどちらも、有効なsanitized decisionを出力できた場合はexit code `0`です。引数不正は`2`、JSON parse failureや実行時例外は`1`です。これによりreusable workflowはblock decisionでも `eligible=false`、`command-created=false`、`adapter-accepted=false`、`executed=false`、`reason-codes-json`、`result-json` を公開できます。

## reusable workflow

`.github/workflows/auto-merge-dry-run-executor.yml` は `workflow_call` / `workflow_dispatch` 対応のread-only workflowです。

permissions:

```yaml
contents: read
pull-requests: read
actions: read
checks: read
statuses: read
```

Secret input、`secrets: inherit`、`pull_request_target`、write permissionは使いません。PR head codeをwrite権限付きで実行せず、review済み40桁commit SHAのkit codeだけをcheckoutしてCLIを実行します。

workflowはresult fileをJSON parseし、report version、dry-run、boolean outputs、reason code、Disabled adapterの非実行状態を検証してからoutputsへ公開します。result file欠落、不正JSON、CLI crash、decision schema不正はworkflow failureとして停止し、偽のsafe resultは生成しません。

## Issue #25との境界

このexecutorはIssue #25の実write完了ではありません。dry-run decisionがeligibleでもmergeは行われず、自動マージ監視も再開しません。

実write adapter、merge API、auto-merge enable、merge queue、comment、label、Queue Issue更新、consumer repository変更、Ruleset変更、Secret登録は別Issue / 別PRで扱います。

## Validation

主な確認:

```bash
npm run test:auto-merge-executor
npm run lint:auto-merge-executor
npm run test:github-write
npm run test:consumer-audit
npm run test:protection-audit
npm run ci
```
