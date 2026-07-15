# Auto-merge regression replay

Issue #42では、Reviewed PR auto-merge planの安全性回帰を完全offlineで再現するリプレイ基盤を追加します。

この基盤は、実GitHub repository、GitHub API write、Secret、token、Ruleset変更、consumer repository変更を使いません。sanitized fixtureを `executeAutoMergeDryRun()` の実入力契約へ変換し、期待する `eligible`、reason code、command生成有無、adapter結果をsnapshotで固定します。

## 目的

auto-merge関連の修正では、次のような事故を再発させないことを確認します。

- review evidenceなしのPRが候補になる
- stale approvalやstale markerがcurrent-head approvalとして扱われる
- `changes_requested`、未解決thread、requested reviewerが残るPRが候補になる
- CI、consumer audit、protection auditの不足を見落とす
- dangerous diffやsecret-like追加行を見落とす
- duplicate / cooldown / attempt limit / command freshnessをすり抜ける
- 成功候補であっても共有キット側が実writeを行う

## 構成

```text
fixtures/auto-merge-regressions/
  index.js
  schema.json
  snapshots/auto-merge-regressions.snapshot.json
  test/auto-merge-regressions.test.js
packages/chatgpt-automation-core/src/auto-merge-regressions/
  index.js
scripts/replay-auto-merge-scenarios.mjs
```

`fixtures/auto-merge-regressions/index.js` はscenario builderとfixture一覧を提供します。各scenarioは次のsnapshotを持ちます。

- `normalizedEvent`
- `pullRequestSnapshot`
- `reviewEvidenceSnapshot`
- `ciSnapshot`
- `changedFilesSnapshot`
- `consumerAuditSnapshot`
- `protectionAuditSnapshot`
- `executionContext`
- `expectedDecision`
- `expectedReasonCodes`

scenario IDはstableなkebab-caseです。fixture値は `owner/example-repo`、`example.invalid`、固定40桁dummy SHA、架空actorだけを使います。実repository、実URL、実メール、Secret、token、Cookie、OAuth情報、Authorization header、private endpoint、個人情報は入れません。

## Replay adapter

`replayScenario(scenario, decisionAdapter)` はscenarioを検証し、adapterへ渡し、実結果と期待値を比較します。

既定の `createExecutorDecisionAdapter()` は次を行います。

1. sanitized scenarioから `autoMergePlan`、`reviewEvidenceReport`、`consumerAuditReport`、`protectionAuditReport`、`pullRequestSnapshot`、`checkSnapshot`、`changedFilesSnapshot`、`executionContext` を作る。
2. `executeAutoMergeDryRun()` にそのまま渡す。
3. executorのreason code、command生成有無、`DisabledGitHubWriteAdapter` の `write_disabled` をsnapshot用に正規化する。
4. `executed=false` を維持する。

このlayerはexecutorの安全判定ロジックを再実装しません。scenario fixtureをexecutorの実report契約へ変換するだけに留め、report schema validation、current head/base/default branch照合、report freshness、changed-files head照合、block時のcommand生成抑止、sanitized reason code契約は `executeAutoMergeDryRun()` 側で検証します。

`createLegacyPlanDecisionAdapter()` は残していますが、既定経路では使いません。用途は次に限定します。

- executor adapterとの差分比較
- 移行時の互換性確認
- executor未提供環境を想定した明示的なfallback test

legacy adapterは、`createAutoMergePlan()`、`createWriteCommandCandidateFromAutoMergePlan()`、`DisabledGitHubWriteAdapter`、fixture用 `FakeGitHubWriteAdapter` を直接組み合わせます。このため、Issue #41で追加されたreport契約やexecutor境界を検証する目的では使いません。

未知のadapter結果、scenario mutation、schema不備、snapshot差分はfail closedです。

## Executor input contract

executor adapterは、各scenarioを次の入力へ変換します。

- `autoMergePlan`: `createAutoMergePlan()` の実plan output。executor側のdedupe / cooldownを確認するため、legacy plan専用のdedupe / cooldown入力はここでは渡しません。
- `reviewEvidenceReport`: current-head review evidenceの集約結果。`apiReadOk`、`paginationComplete`、`checkedAt`、`reviewedAt`、`currentRunEvidence`、`requestedReviewers`、`requestedTeams`、`unresolvedReviewThreads` を含みます。
- `consumerAuditReport`: live consumer audit producer相当のread-only report。`auditedCommitSha`、`defaultBranch`、`ready`、`manualReviewRequired`、`paginationComplete` を含みます。
- `protectionAuditReport`: repository protection audit producer相当のread-only report。`auditedSha`、`defaultBranch`、`ready`、`manualReviewRequired`、`paginationComplete` を含みます。
- `pullRequestSnapshot`: open / draft / fork / same-repo / mergeable state / requested reviewer情報をflatにしたPR snapshot。
- `checkSnapshot`: CI、Review evidence gate、required check、head SHA、paginationのsnapshot。
- `changedFilesSnapshot`: changed files、dangerous change、workflow permission increase、`pull_request_target`、secret-like addition、head SHAのsnapshot。
- `executionContext`: repository、PR番号、current head/base SHA、allowed base branch、runStartedAt、now、actor context、dedupe key、cooldown、attempt countを含みます。

fixture専用の架空fieldをsuccess reportへ足すのではなく、executorが本番で受け取るreport契約に近い形へ寄せます。Secret値、token値、実URL、実repository、実メール、Cookie、Authorization headerは含めません。

## Scenario categories

最低限のカテゴリは次の通りです。

- `review`: review evidenceなし、stale approval、stale marker、same-run evidence、changes requested、未解決thread、requested reviewer、current-head valid review
- `pr-state`: closed、draft、fork、external repository、head/base SHA変化、mergeability unknown、dirty/conflict
- `ci`: pending、failure、required check missing、review evidence gate missing、check head SHA mismatch、duplicate check name
- `audit`: consumer audit failure、consumer audit SHA mismatch、protection audit failure、ruleset missing、unexpected bypass actor、force push allowed、branch deletion allowed
- `diff`: dangerous file、workflow permission increase、`pull_request_target`、secret-like addition、binary、submodule、dependency、generated dist
- `replay-prevention`: duplicate idempotency key、cooldown、attempt limit、command expired、future timestamp、review report expired、review report from future
- `success`: current-head reviewed、same repository、CI success、audit success、dangerous changeなし、command candidate生成、Disabled adapterで `write_disabled`

PR #130相当の回帰は `no-review-evidence-regression` として固定しています。このscenarioはCI successやmergeable条件が揃っていても、review submissions、threads、approved marker、`reviewed-by-chatgpt` labelがなく、`commandCreated=false` / `adapterCalled=false` で停止することを確認します。

`same-run-review-evidence` は通常の `current-head-valid-review` と同じbase scenarioを使い回さず、`pull_request_review` trigger payload、run開始時刻、trigger側review ID、API取得側review ID、actor、current head SHAをfixtureへ明示します。採用可能なsame-run evidenceは、trigger payloadとAPI取得結果のreview ID / actor / head SHAが一致し、review timestampがrun開始秒より前に確定できる場合だけです。run開始後に作成されたevidence、run開始と同一秒で前後関係が確定できないevidence、trigger/API ID不一致、actor不一致、stale head SHAは個別scenarioで `commandCreated=false` として固定します。加えて `scripts/plan-auto-merge.test.mjs` はproduction CLI境界で `RUN_STARTED_AT` を同じ `runStartedAt` 引数契約へ渡し、欠落・空文字・不正timestampとevent payload値による代用をfail closedに固定します。

## Commands

全scenarioをreplayします。

```bash
npm run replay:auto-merge-regressions
```

JSON出力:

```bash
npm run replay:auto-merge-regressions -- --json
```

カテゴリまたはIDで絞り込み:

```bash
node scripts/replay-auto-merge-scenarios.mjs --category review --json
node scripts/replay-auto-merge-scenarios.mjs --id no-review-evidence-regression --json
```

snapshot更新は明示flagがある場合だけ行います。

```bash
node scripts/replay-auto-merge-scenarios.mjs --update-snapshots --json
```

通常の確認:

```bash
npm run test:auto-merge-regressions
npm run lint:auto-merge-regressions
npm run replay:auto-merge-regressions
```

`npm run ci` でもこのoffline suiteを確認します。

## Snapshot policy

snapshotに固定する値は次だけです。

- scenario ID
- category
- `eligible`
- `commandCreated`
- `adapterCalled`
- `executed`
- `dryRun`
- sorted `reasonCodes`

実行時間、絶対path、乱数、環境変数、API response、Secret-like値はsnapshotに含めません。reason codeを変更した場合は、該当scenarioの期待値とdocsを更新し、`--update-snapshots` を明示して差分を確認します。

## Safety assertions

テストでは次を確認します。

- scenario schemaがunknown key、重複ID、欠落必須項目、不正SHA、不正timestamp、不正repositoryを拒否する
- unsafe URL、実メール、実token風値、private key風値を拒否する
- success scenarioでも `executed=true` を拒否する
- replay中に `fetch` が呼ばれない
- `GITHUB_TOKEN` などの環境変数値が出力へ混ざらない
- adapter結果が不正ならfail closed
- scenario inputがmutationされない
- CLIのsnapshot差分はnon-zeroになる

## Snapshot differences

Issue #41のexecutor統合後、snapshotはexecutorのreason codeを正とします。legacy adapterとexecutor adapterのdecision差分はテストで固定します。

意図したdecision差分は次です。

- `attempt-limit-exceeded`: legacyはfixture Fake adapterまで進みますが、executorはcommand生成前に `attempt_limit_exceeded` で止めます。
- `changed-files-api-read-failure`: legacy adapterにはchanged-files API read完了reportがないため進みますが、executorは `unknown_state` で止めます。
- `changed-files-head-mismatch`: legacy adapterにはchanged-files current-head照合reportがないため進みますが、executorは `report_head_sha_mismatch` で止めます。
- `command-expired`: legacyはadapter validationの結果として扱いますが、executorはwrite command validation失敗として `write_command_invalid` で止めます。
- `consumer-audit-api-read-failure`: legacy adapterはsimpleなready flagだけを見るため進みますが、executorは `consumer_audit_not_ready` で止めます。
- `consumer-audit-pagination-incomplete`: legacy adapterはpagination完了reportを持たないため進みますが、executorは `consumer_audit_not_ready` で止めます。
- `future-timestamp`: legacyはadapter validationの結果として扱いますが、executorはwrite command validation失敗として `write_command_invalid` で止めます。
- `protection-audit-api-read-failure`: legacy adapterはsimpleなready flagだけを見るため進みますが、executorは `protection_audit_not_ready` で止めます。
- `protection-audit-pagination-incomplete`: legacy adapterはpagination完了reportを持たないため進みますが、executorは `protection_audit_not_ready` で止めます。
- `review-report-expired`: legacy adapterにはreport freshnessがないため進みますが、executorは `report_expired` で止めます。
- `review-report-from-future`: legacy adapterにはreport freshnessがないため進みますが、executorは `report_from_future` で止めます。

その他のscenarioでは、executorとlegacyでreason codeの粒度や名前が異なる場合があります。ただし、既定snapshotはexecutor reason codeを固定します。

## Issue #41との統合状態

Issue #41のauto-merge dry-run executorはmasterへ統合済みです。Issue #42の既定replay pathは `createExecutorDecisionAdapter()` を使い、同じscenario群を `executeAutoMergeDryRun()` へ通します。

このsuiteはGitHub API write、auto-merge有効化、merge、merge queue投入、PR branch update、comment投稿、label操作、Queue Issue更新を行いません。

## 手動確認との境界

このsuiteが成功しても、consumer repositoryのRuleset、Branch protection、required checks、review evidence gate、bypass actor、実GitHub UI上のmerge可否を確認したことにはなりません。

実consumer / Ruleset確認は、Repository protection audit、Live consumer audit、または導入先Issueで別途扱います。回帰scenarioで不具合が見つかった場合も、自動修正や外部repository変更は行わず、別Issueまたは該当PRで修正します。
