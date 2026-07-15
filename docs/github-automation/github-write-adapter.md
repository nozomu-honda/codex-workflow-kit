# GitHub write adapter boundary

Issue #37では、plan layerと将来のGitHub write layerの境界だけを追加します。

このリポジトリは引き続きread-only / dry-runを既定にし、GitHub API write、auto-merge有効化、merge、PR branch update、コメント投稿、label操作、Queue Issue更新は行いません。

## 目的

既存のReviewed PR auto-merge planやMain follow-up planは、「後続workflowが実行してよいかもしれない候補」をoutputsとして返します。Issue #37では、その候補を直接writeしないまま、将来write adapterへ渡せるcommand modelへ変換します。

これにより、次を分離します。

| 層 | 責務 |
| --- | --- |
| plan layer | read-only GitHub API結果と設定から、eligible / skip reason / plan snapshotを作る |
| write command layer | plan snapshotから、実行してよいかもしれないwrite command候補を作る |
| write adapter layer | commandを検証し、実write可否を判定する |

Issue #37で実装するadapterは `DisabledGitHubWriteAdapter` と `FakeGitHubWriteAdapter` だけです。実GitHub API write adapterは追加しません。

## command model

write commandは少なくとも次のfieldを持ちます。

- `commandVersion`
- `operation`
- `repository`
- `pullRequestNumber`
- `expectedHeadSha`
- `expectedBaseSha`
- `requestedAt`
- `operationId`
- `idempotencyKey`
- `dryRun`
- `reasonCode`
- `actorContext`
- `planSnapshot`

対応するoperation type:

- `enable-auto-merge`
- `merge-pull-request`
- `update-pull-request-branch`
- `add-comment`
- `add-label`
- `remove-label`
- `update-queue-record`

ただし、このIssueではこれらを実行可能にはしません。実行可能なwrite operationは0件で、既定adapterはすべて `write_disabled` で拒否します。

## fail closed validation

validatorは次のような状態を拒否します。

- 不正なrepository名
- 不正なPR番号
- 不正または欠落したhead SHA / base SHA
- 未対応operation
- `dryRun=false`
- operation ID / idempotency key欠落
- 不正timestamp
- command生成時刻が未来すぎる、または古すぎる
- plan snapshotとcommandのrepository / PR番号 / head SHA / base SHA不一致
- actor guard欠落
- fork由来actor context
- command payloadとworkflow境界で確認したtrusted actor contextの不一致
- plan state不明

代表的なstable reason code:

- `write_disabled`
- `unsupported_operation`
- `expected_head_sha_missing`
- `expected_head_sha_mismatch`
- `expected_base_sha_missing`
- `invalid_repository`
- `invalid_pull_request_number`
- `invalid_idempotency_key`
- `duplicate_operation`
- `attempt_limit_exceeded`
- `cooldown_active`
- `plan_snapshot_mismatch`
- `missing_safety_guard`
- `command_from_future`
- `command_expired`

`actorContext` はcommand payload内の自己申告だけでは信頼しません。converterまたはworkflow境界で確認したtrusted actor contextをvalidatorへ別途渡し、actor、source、trusted判定、fork判定が一致した場合だけvalidにします。`createWriteCommand()` を単独で呼んでもtrusted actorは補完されず、validatorは `missing_safety_guard` でfail closedします。

`requestedAt` はISO形式だけでなく鮮度も検証します。既定ではvalidatorへ現在時刻を注入できない場合はfail closedになり、現在時刻から5分を超えて未来、または24時間を超えて過去のcommandを拒否します。これにより永続storeが失われた場合でも古いcommandを再受理しないようにします。

plan snapshotの `source` は `auto-merge` と `main-follow-up` だけを許可します。`generic` sourceは使用せず、operation対応も次に限定します。

| source | 許可operation |
| --- | --- |
| `auto-merge` | `enable-auto-merge`, `merge-pull-request` |
| `main-follow-up` | `update-pull-request-branch` |

`add-comment`、`remove-label`、`update-queue-record` など、converter未実装のoperationは現段階ではvalid commandになりません。

## adapters

### DisabledGitHubWriteAdapter

既定adapterです。

- valid commandも `accepted=false` / `executed=false` / `reasonCode=write_disabled` にする
- GitHub APIを呼ばない
- networkを使わない
- tokenやSecretを要求しない
- audit recordだけを最小fieldで返す

### FakeGitHubWriteAdapter

テスト専用adapterです。

- 明示されたfixture allowance内のoperationだけを受け付ける
- commandをdeterministicに記録する
- `executed=false` を維持する
- duplicate idempotency key、attempt limit、cooldownを検証する
- GitHub API writeもnetworkも使わない

本番workflowでfake adapterを使う想定はありません。

## idempotency

`idempotencyKey` は次を含む安定keyです。

```text
write-v{commandVersion}:{operation}:{repository}#{pullRequestNumber}:{expectedHeadSha}:{expectedBaseSha}
```

同じkeyは二重実行しません。head SHAが変わった場合は別keyになります。attempt limitやcooldownの永続化は導入先workflowの責務です。Issue #37では永続storeを追加しません。

## audit record

audit recordは最小限の許可fieldだけを出力します。

- `operation`
- `repository`
- `pullRequestNumber`
- `expectedHeadSha`
- `expectedBaseSha`
- `operationId`
- `reasonCode`
- `dryRun`
- `accepted`
- `executed`

次は出力しません。

- token
- Secret
- Cookie
- Authorization header
- GitHub API response全文
- request / response headers
- private URL
- 個人情報
- plan payload全文

## planからの変換

`packages/chatgpt-automation-core/src/github-write/` は、既存planからwrite command候補を作るpure functionを提供します。

- auto-merge plan
  - `eligible=true` かつ `should_enable_auto_merge=true` の場合だけ `enable-auto-merge` 候補
  - `eligible=true` かつ `should_merge=true` の場合だけ `merge-pull-request` 候補
  - manual review、skip、unknown stateでは候補なし
- main-follow-up plan
  - `behind-update-candidate` かつ `should_update_branch=true` の場合だけ `update-pull-request-branch` 候補
  - conflict follow-up、manual review、up-to-date、ineligibleでは候補なし

変換後も既定adapterはwriteしません。

converterはplanとworkflow境界で得たactor trust contextを受け取り、commandとvalidation contextを組で返します。validatorはこのvalidation contextがないcommandをvalid扱いしません。

## dry-run executorからの利用

Issue #41の [Auto-merge dry-run executor](auto-merge-dry-run-executor.md) は、独自command形式を作らず、このconverterとvalidatorをそのまま使います。

- auto-merge planがeligibleで、review evidence / CI / consumer audit / protection audit / changed files / idempotency条件がすべて通った場合だけcommand候補を作る
- command生成後も `validateWriteCommand()` へ通す
- trusted actor contextはexecutor inputの外部検証済みcontextを使い、command payloadの自己申告だけでは通さない
- 本番経路では `DisabledGitHubWriteAdapter` だけを使用する
- valid commandでも `accepted=false`、`executed=false`、`reasonCode=write_disabled`

このため、dry-run executorがeligibleでもIssue #25の実writeはまだ未実装です。

## CLI

`scripts/plan-write-command.mjs` はplan JSONを読み、command候補とdisabled adapter結果をdeterministic JSONで出力します。

例:

```bash
node scripts/plan-write-command.mjs \
  --plan auto-merge-plan.json \
  --plan-type auto-merge \
  --operation enable-auto-merge \
  --requested-at 2026-01-01T00:00:00.000Z \
  --now 2026-01-01T00:00:00.000Z \
  --allow-fixture-trust
```

このCLIはGitHub API、network、token、Secretを使いません。通常実行ではtrusted actor commandを生成できず、fixture検証でだけ `--allow-fixture-trust` を指定できます。実workflowではCLIのfixture trustではなく、converterまたはworkflow境界が確認したactor trust contextを使います。

## validation

主な確認コマンド:

```bash
npm run test:github-write
npm run lint:github-write
npm run ci
```

## このIssueで行わないこと

- GitHub API write adapter実装
- auto-merge有効化
- merge API呼び出し
- merge queue投入
- PR branch update API
- comment投稿
- label操作
- Queue Issue更新
- Codex / ChatGPT実起動
- release / tag / deploy
