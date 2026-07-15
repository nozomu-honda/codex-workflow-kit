# Live consumer audit

`audit-live-consumer` は、実consumer repositoryを変更せずに、導入済みのChatGPT automation caller workflowとconfigをread-onlyで監査するCLIです。

offline consumer E2Eはテンプレートから一時consumer fixtureを作って検証します。live consumer auditはGitHub REST APIのGETだけで実consumerのdefault branch上のファイルを読み、同じ安全条件をsanitized reportとして確認します。

## 境界

このCLIが行うこと:

- repository metadataをGETする
- default branch refを監査開始時と終了時にGETする
- config fileとcaller workflow fileをdefault branch SHA固定でGETする
- `.github/workflows` 配下のworkflow pathをtreeから確認する
- Actions workflow metadataをGETする
- fixed SHA、trigger、permission、Secret-like構成、capability整合を判定する
- sanitized JSONまたはhuman-readable reportを出す

このCLIが行わないこと:

- consumerへのcommit、branch作成、push
- Issue、PR、comment、label、reviewer、reaction操作
- workflow dispatch
- Secrets、Variables、Environments APIの取得または変更
- auto-merge、branch update、Codex起動、Queue Issue更新
- release、tag、deploy、npm publish
- consumer PR head codeのcheckoutまたは実行

Issue #25のauto-merge write処理は未実装です。`oshi-management-app` 側のIssue #133 / PR #135が完了するまで、write系のconsumer展開は開始しません。

## CLI

```bash
node scripts/audit-live-consumer.mjs \
  --repository owner/example-repo \
  --expected-kit-sha 0123456789abcdef0123456789abcdef01234567 \
  --config .github/chatgpt-automation.yml \
  --workflow .github/workflows/validate-config.yml \
  --json
```

inventoryを使う場合:

```bash
node scripts/audit-live-consumer.mjs \
  --inventory release/live-consumers.example.yml \
  --repository owner/example-repo \
  --json
```

`--dry-run` が既定です。`--no-dry-run` は拒否します。

認証が必要なprivate repositoryを監査する場合は、環境変数 `GITHUB_TOKEN` または `GH_TOKEN` にread-only tokenを設定します。token値は引数に渡さず、ログやreportへ出しません。

## Inventory

live consumer audit inventoryは `schemas/live-consumer-audit-inventory.schema.json` を正とします。例は `release/live-consumers.example.yml` です。

主要項目:

- `repository`: `owner/repo` 形式。URLは禁止。
- `defaultBranch`: 期待するdefault branch。
- `configPath`: `.github/chatgpt-automation.yml` などのrepository相対path。
- `callerWorkflowPaths`: 監査対象caller workflowのrepository相対path。
- `expectedKitRef`: レビュー済み40桁小文字commit SHA。
- `desiredCapabilitySet`: 期待するread-only / plan-only capability。
- `expectedWorkflowNames`: Actions workflow metadataで許可するworkflow名。
- `allowedTriggers`: capabilityごとの許可trigger。未指定時は共通default specを使います。
- `allowedPermissions`: capabilityごとの許可read permission。未指定時は共通default specを使います。
- `manualReviewRequired`: 人間確認を強制したいconsumer用の印。この値が `true` の場合、blockerがなくても `ready: false` になります。

unknown key、path traversal、重複path、URL形式repository、mutable ref、short SHA、version tag、placeholderはfail closedです。

## 監査内容

### Fixed SHA

consumer内のkit参照は40桁小文字commit SHAだけを許可します。

BLOCKする例:

- `@main`
- `@master`
- `@develop`
- `@latest`
- `@v1`
- `@v1.2.3`
- 短縮SHA
- `REPLACE_WITH_40_CHAR_COMMIT_SHA`
- 同じconsumer内のmixed refs

external Actionも原則40桁SHA固定です。local `./` 参照は許可します。

### Caller workflow scope

厳格監査の対象は `callerWorkflowPaths` に列挙されたcaller workflowだけです。

導入先にはCI、Dependabot、Vercel、Release readinessなど通常workflowが共存できます。これらはChatGPT automation callerではないため、`callerWorkflowPaths` に含めない限り `unknown_workflow` blockerにはしません。

### Trigger

capabilityごとの許可triggerはinventoryの `allowedTriggers` を優先し、未指定時だけ共通default specを使います。`pull_request_target` は常にBLOCKです。

`workflow_dispatch` はread-only用途だけ許可します。`schedule` や想定外triggerは、実行頻度や意図を確認できないためBLOCKします。

### Permission

workflow-levelとjob-levelの両方を確認します。

BLOCKする例:

- permission省略
- `write-all`
- `contents: write`
- `pull-requests: write`
- `issues: write`
- `checks: write`
- `actions: write`
- `statuses: write`
- `deployments: write`
- `id-token: write`
- job-level overrideで権限が広がる構成

read-only plannerは、必要なread permissionだけを明示する必要があります。許可permissionはinventoryの `allowedPermissions` を優先し、未指定時だけ共通default specを使います。

### Actions workflow metadata

Actions workflow metadataを取得できる場合、caller workflow pathごとにmetadataが存在し、`state: active` であることを確認します。

inventoryの `expectedWorkflowNames` が指定されている場合、caller workflowのmetadata nameはその一覧に含まれている必要があります。metadata取得に失敗した場合はAPI read errorとしてfail closedです。

### Secret / dangerous structure

BLOCKする例:

- `secrets: inherit`
- `${{ secrets.* }}`
- workflow_call Secret input
- workflow_dispatch Secret-like input
- Authorization、token、Cookieをenvやshellへ展開する構成
- `pull_request_target` + Secret
- `persist-credentials: true`
- PR head codeやevent payloadをshellへ直接展開する構成
- `eval`

Secret名と値はreportへ出しません。検出結果はcode、path、fileだけに正規化します。

### Config / capability

configは既存の共通validatorで検証します。

BLOCKする例:

- config missing
- YAML parse error
- unknown key
- schema version mismatch
- enabled capabilityとcaller workflowの不一致
- caller workflowがあるのにdesired capabilityがない
- desired capabilityがあるのにcaller workflowがない
- read-only kitでwrite系capabilityが有効

## TOCTOU

audit開始時にdefault branch SHAを固定し、終了時に再取得します。

開始時と終了時でSHAが変わった場合は `default_branch_changed_during_audit` でfail closedです。各fileは固定SHAでcontentsを取得します。binary、submodule、symlink、サイズ上限超過は `binary_or_submodule_manual_review` または `response_size_limit_exceeded` としてmanual review対象にします。

## Report

JSON reportはdeterministicで、絶対path、token、Cookie、Authorization、Secret値、API response全文を含みません。

主要フィールド:

- `reportVersion`
- `repository`
- `defaultBranch`
- `auditedCommitSha`
- `apiReadOk`
- `paginationComplete`
- `checkedAt`
- `expectedKitRef`
- `detectedKitRefs`
- `capabilities`
- `workflowsAudited`
- `configStatus`
- `permissionSummary`
- `triggerSummary`
- `blockers`
- `warnings`
- `manualReviewRequired`
- `ready`

代表的なreason code:

- `mutable_kit_ref`
- `kit_short_ref`
- `kit_version_tag`
- `mixed_kit_refs`
- `unresolved_placeholder`
- `pull_request_target_present`
- `secrets_inherit_present`
- `unexpected_write_permission`
- `workflow_permission_missing`
- `config_missing`
- `config_schema_invalid`
- `capability_caller_mismatch`
- `unknown_workflow`
- `workflow_metadata_missing`
- `workflow_metadata_inactive`
- `workflow_name_mismatch`
- `manual_review_required`
- `untrusted_payload_in_shell`
- `api_read_failed`
- `pagination_incomplete`
- `default_branch_changed_during_audit`
- `binary_or_submodule_manual_review`

## dry-run executor連携

Issue #41のauto-merge dry-run executorは、live consumer audit reportを事前条件として要求します。

- `reportVersion: live-consumer-audit.v1`
- `ready=true`
- `apiReadOk=true` と `paginationComplete=true`
- `checkedAt` が有効で、executorのfreshness window内であること
- `repository` がcurrent PR repositoryと一致すること
- `defaultBranch` がPR base branchと一致すること
- `auditedCommitSha` が監査開始・終了で安定していたdefault branch SHAであり、current PR base SHAと一致すること
- API read failure、pagination未完了、blocker、manual review requiredがないこと
- Secret-like構成やwrite permission拡大がないこと

consumer audit reportはPR番号やPR headを監査しません。current PR head固有の検証はreview evidence、changed files、checks、PR snapshot側で行います。consumer audit reportが不足、不正、stale、またはreadyでない場合は `consumer_audit_not_ready` でblockします。executorはconsumer repositoryを変更せず、PR、Issue、comment、label、branch、Secret、Variable、workflow dispatchも行いません。

## Validation

offline fixture:

```bash
npm run test:consumer-audit
npm run lint:consumer-audit
npm run audit:consumer-fixture
```

live consumer確認例:

```bash
node scripts/audit-live-consumer.mjs \
  --repository nozomu-honda/oshi-management-app \
  --expected-kit-sha 0123456789abcdef0123456789abcdef01234567 \
  --json
```

実consumer確認で問題が見つかった場合、このCLIはconsumerを修正しません。reportをPR本文や後続Issue候補に記録し、consumer側の変更は別Issue / 別PRで扱います。
