# Repository protection audit

Issue #38では、consumer repositoryのdefault branchに設定されたBranch protection、Ruleset、required checks、required reviews、bypass条件、merge settingsをread-onlyで監査する層を追加します。

この監査はGitHub repository settingsを読むだけです。Ruleset変更、Branch protection変更、required check設定、Check Run作成、PR / Issue / comment / label操作、Secret操作、release、deployは行いません。

## 責務分離

- #35: consumer repository内のconfig、caller workflow、固定SHA、workflow権限、導入ファイルを監査する。
- #38: GitHub repository settings、Branch protection、Ruleset、required checks、required reviews、bypass、merge settingsを監査する。

どちらもread-onlyですが、読む対象が違います。#38の結果で不足設定が見つかっても、このCLIやworkflowは修正しません。

## Core

pure logicは `packages/chatgpt-automation-core/src/protection-audit/` にあります。

入力:

- repository metadata
- default branchとdefault branch SHA
- branch protection response
- repository rulesetsとruleset detail
- required status checks
- required pull request reviews
- bypass actors
- merge settings
- expected policy
- pagination / API / TOCTOU状態

出力:

- `ready`
- `manualReviewRequired`
- `defaultBranch`
- `auditedSha`
- `effectiveProtections`
- `requiredChecks`
- `requiredReviews`
- `bypassSummary`
- `mergeSettings`
- `blockers`
- `warnings`
- `reasonCodes`
- `reportVersion`

reportはdeterministicな順序にし、token、Authorization、Cookie、Secret、API response全文、不要なactor内部IDを含めません。

## Expected policy

policy schemaは `schemas/protection-policy.schema.json`、例は `release/protection-policy.example.yml` です。

初期推奨:

- `CI` と `Review evidence gate` をrequired checkにする
- Pull Request reviewを必須にする
- minimum approval countは1以上にする
- stale approval dismissalを有効にする
- conversation resolutionを必須にする
- force pushとbranch deletionを禁止する
- bypass actorは原則なし
- 自動化ではadmin bypassに依存しない
- merge methodはpolicyで許可したものだけにする

GitHubのrequired approvalとChatGPT markerは別物です。ChatGPT markerはreview evidence gateやauto-merge planの入力ですが、GitHub UIのrequired approval countを満たすGitHub reviewそのものではありません。

## GitHub API read CLI

CLIは `scripts/audit-repository-protection.mjs` です。

```bash
node scripts/audit-repository-protection.mjs \
  --repository owner/example-repo \
  --policy release/protection-policy.example.yml \
  --json
```

`GITHUB_TOKEN` または `GH_TOKEN` をread-only API tokenとして使います。token値は出力しません。

読む候補:

- `GET /repos/{owner}/{repo}`
- `GET /repos/{owner}/{repo}/branches/{default_branch}`
- `GET /repos/{owner}/{repo}/branches/{default_branch}/protection`
- `GET /repos/{owner}/{repo}/rulesets`
- `GET /repos/{owner}/{repo}/rulesets/{ruleset_id}`

CLIはGETだけを使います。redirectは追跡せず、API hostは `https://api.github.com` に限定します。403、404、pagination未完了、API取得失敗はfail closedです。Branch protectionが404の場合は設定なしとして扱い、`branch_protection_missing` でblockします。Branch protectionは監査開始時と監査終了時の両方で読み、途中変更をfingerprintで比較します。

## Workflow

`.github/workflows/audit-repository-protection.yml` は `workflow_dispatch` のみです。

permissions:

```yaml
permissions:
  contents: read
```

標準 `github.token` で読めないrepository settingsはfail closedになります。追加のPATやSecret inputはこのIssueでは追加しません。GitHub UIやtoken権限の手動調整が必要な場合は、監査結果とPR本文に後続作業として記載します。

## Effective policy

Branch protectionとRulesetの両方がある場合、監査は単純な一覧化ではなくeffectiveな保護として合成します。

見るもの:

- どちらかで満たされているrequired check
- どちらかで満たされているPull Request review条件
- どちらかで満たされているconversation resolution
- どちらかで満たされているforce push / deletion block
- default branchに実際にmatchするactive ruleset
- inactive / evaluate ruleset
- branch pattern mismatch
- bypass actor

状態不明、pagination未完了、API failure、監査中のdefault branch SHA変更はmanual reviewまたはblockです。

## Required checks

policyに指定されたcheckを確認します。

代表的なreason code:

- `required_check_missing`
- `review_evidence_gate_not_required`
- `ci_check_not_required`
- `required_check_strict_mode_disabled`
- `duplicate_check_name`
- `ruleset_target_mismatch`

check名だけでなく、取得できる場合はintegration / app IDの重複もmanual reviewにします。

## Required reviews

見るもの:

- Pull Request review必須
- minimum approval count
- stale approval dismissal
- last push approval
- conversation resolution
- code owner review
- admin enforcement

代表的なreason code:

- `pull_request_review_not_required`
- `minimum_approvals_too_low`
- `stale_approvals_not_dismissed`
- `conversation_resolution_not_required`
- `last_push_approval_not_required`
- `admin_bypass_allowed`

## Bypass

Ruleset bypass actorはsanitized summaryにします。actor IDや不要な内部IDは出しません。

検出対象:

- repository admin / organization admin相当
- team bypass
- integration bypass
- deploy key bypass
- unknown actor type
- always bypass
- pull request bypass

許可されていないbypass actorは `unexpected_bypass_actor` または `admin_bypass_allowed` でblockします。

## Branch safety and merge settings

見るもの:

- force push禁止
- deletion禁止
- linear history
- signed commits
- merge queue
- merge method
- branch auto-delete

merge queueが有効な場合、将来のwrite workflowは直接merge APIではなくqueue対応が必要になる可能性があるため `merge_queue_enabled` warningにします。

## TOCTOU

監査開始時と終了時に、可能な範囲で次を比較します。

- repository default branch
- default branch SHA
- Branch protectionのsanitized fingerprint
- ruleset一覧のfingerprint

Branch protection fingerprintには次を含めます。

- required status checksとstrict mode
- required pull request reviewsの有無
- minimum approvals
- stale approval dismissal
- last push approval
- code owner review
- conversation resolution
- admin enforcement
- force push許可
- branch deletion許可
- linear history
- signed commits

fingerprintは比較専用で、reportへAPI response全文やactor ID、token、Authorization、Cookieを出しません。途中変更、設定ありから404、404から設定ありを検知した場合は `protection_changed_during_audit` でfail closedにします。

## Live consumer確認手順

候補consumer:

- `nozomu-honda/oshi-management-app`

手順:

```bash
GITHUB_TOKEN=<read-only-token> node scripts/audit-repository-protection.mjs \
  --repository nozomu-honda/oshi-management-app \
  --policy release/protection-policy.example.yml \
  --json
```

確認時のルール:

- API readのみ
- 設定変更なし
- Ruleset / Branch protectionの修正なし
- Secretやtoken値をログやPR本文に貼らない
- 不足設定を見つけてもCodexがconsumer IssueやPRを作らない
- sanitized resultだけを共有する

## #25開始前の完了条件

実writeのauto-mergeを進める前に、少なくとも次を確認します。

- `Review evidence gate` がrequired checkとして有効
- `CI` がrequired checkとして有効
- Pull Request reviewが必須
- stale approval dismissalが有効
- conversation resolutionが必須
- force pushとbranch deletionが禁止
- bypass actorに自動化actorや広いteamがいない
- admin bypassに自動化が依存していない
- merge queueが有効な場合はwrite側設計がqueue対応している

## Validation

```bash
npm run test:protection-audit
npm run lint:protection-audit
npm run audit:repository-protection -- --repository owner/example-repo --json
```

full validation:

```bash
npm run ci
```

## この監査が行わないこと

- Ruleset変更
- Branch protection変更
- required check設定
- Check Run writer追加
- `checks: write` 追加
- auto-merge write
- consumer修正
- Secret / Variable変更
- deploy
- release
