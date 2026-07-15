# Auto-merge regression replay

Issue #42では、Reviewed PR auto-merge planの安全性回帰を完全offlineで再現するリプレイ基盤を追加します。

この基盤は、実GitHub repository、GitHub API write、Secret、token、Ruleset変更、consumer repository変更を使いません。sanitized fixtureを既存の `createAutoMergePlan()` と GitHub write command境界へ通し、期待する `eligible`、reason code、command生成有無、adapter結果をsnapshotで固定します。

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

既定の `createLegacyPlanDecisionAdapter()` は次を行います。

1. consumer / protection audit snapshotが失敗ならfail closed。
2. 既存の `createAutoMergePlan()` を呼び、plan outputを取得。
3. eligibleな場合だけ `createWriteCommandCandidateFromAutoMergePlan()` でcommand候補を作る。
4. `DisabledGitHubWriteAdapter` またはfixture用 `FakeGitHubWriteAdapter` へ渡す。
5. `executed=false` を維持した結果をsnapshot用に正規化する。

このlayerはauto-merge判定ロジックを再実装しません。Issue #41でdry-run executorが導入された後は、`decisionAdapter` を差し替えて同じscenario群を再利用できます。

未知のadapter結果、scenario mutation、schema不備、snapshot差分はfail closedです。

## Scenario categories

最低限のカテゴリは次の通りです。

- `review`: review evidenceなし、stale approval、stale marker、same-run evidence、changes requested、未解決thread、requested reviewer、current-head valid review
- `pr-state`: closed、draft、fork、external repository、head/base SHA変化、mergeability unknown、dirty/conflict
- `ci`: pending、failure、required check missing、review evidence gate missing、check head SHA mismatch、duplicate check name
- `audit`: consumer audit failure、consumer audit SHA mismatch、protection audit failure、ruleset missing、unexpected bypass actor、force push allowed、branch deletion allowed
- `diff`: dangerous file、workflow permission increase、`pull_request_target`、secret-like addition、binary、submodule、dependency、generated dist
- `replay-prevention`: duplicate idempotency key、cooldown、attempt limit、command expired、future timestamp
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

## Issue #41との境界

Issue #41はauto-merge dry-run executorの実行計画を扱います。Issue #42は、そのexecutorがなくても既存plan / write command境界を使って回帰scenarioをリプレイできるところまでを責務にします。

Issue #41が先に入った場合は、`decisionAdapter` をexecutor adapterへ差し替えます。Issue #42が先の場合は、既定adapterのままDraft PRを作成し、#41統合は後続対応として残します。

どちらの場合も、このsuiteはGitHub API write、auto-merge有効化、merge、merge queue投入、PR branch update、comment投稿、label操作、Queue Issue更新を行いません。

## 手動確認との境界

このsuiteが成功しても、consumer repositoryのRuleset、Branch protection、required checks、review evidence gate、bypass actor、実GitHub UI上のmerge可否を確認したことにはなりません。

実consumer / Ruleset確認は、Repository protection audit、Live consumer audit、または導入先Issueで別途扱います。回帰scenarioで不具合が見つかった場合も、自動修正や外部repository変更は行わず、別Issueまたは該当PRで修正します。
