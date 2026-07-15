# Permissions

GitHub automation共通化では、権限を最小化し、強い権限を導入先リポジトリで明示管理します。

## 禁止

- `pull_request_target` を使わない
- fork / external PRへSecretを渡さない
- Secret、token、OAuth情報、Cookie、実URL、実IDをログやdocsへ出さない
- 共通化を理由に導入先の安全条件を緩めない

## 導入先で管理するもの

- repository secrets
- repository variables
- fine-grained PAT
- labels
- Queue Issue

## 共通側に置くもの

- permission modelの説明
- caller workflow template
- reusable workflow / Actionの入力仕様
- 設定schema
- validation tests

実際の権限値は導入先リポジトリの運用に依存するため、このリポジトリには実値や実IDを置きません。

## 実イベント正規化の権限境界

Issue #23の実イベント受付では、導入先caller workflowと共通reusable workflowのどちらもdefaultをread-onlyにします。

- workflow / job permissionsは `contents: read`
- `pull_request_target` は使わない
- Secret inputは定義しない
- `secrets: inherit` は使わない
- fork / external PRは `eligible=false` にする
- PR上の `issue_comment` は、payloadだけではfork / same-repository境界を検証できないため `eligible=false` にする
- `permission-mode` は `read-only` だけを許可する
- `requested-capability` は `normalize-only` だけを許可する
- write相当capabilityが要求された場合はfail closedにする

導入先固有のlabels、Variables、Secrets、fine-grained PAT、Queue Issue番号は導入先側に残します。Issue #24以降でwrite処理を追加する場合も、Secretをfork / external PRへ渡さず、Issue #23の `eligible` outputとfork/same-repository判定を前提に分岐します。

## ChatGPT review routingの権限境界

Issue #24のreview routingは、正規化eventとread-only GitHub API結果からrouting planを作るだけです。

- workflow / job permissionsはread-onlyに限定する
  - `contents: read`
  - `pull-requests: read`
  - `issues: read`
  - `actions: read`
  - `checks: read`
  - `statuses: read`
- `github.token` はPR情報、changed files、actor権限などのreadにだけ使う
- token値、Secret値、Cookie、OAuth情報、private URL、payload全文はログへ出さない
- Secret inputは定義しない
- `secrets: inherit` は使わない
- `pull_request_target` は使わない
- fork / external PR、未知actor、GitHub Actions bot、API read失敗は `should_route=false` にする
- dry-run defaultで、review request作成、コメント投稿、reaction、label操作、reviewer追加、ChatGPT/Codex起動、Queue Issue更新は行わない

PR上の `issue_comment` はpayloadだけではprovenanceを安全に検証できないため、Issue #24ではrouting対象外です。将来この経路を有効化する場合も、read-only APIでPR番号、base repository、head repository、head SHA、fork境界、actorを確認し、失敗時はfail closedにします。

## Reviewed PR auto-merge planの権限境界

Issue #25のauto-merge planは、正規化eventとread-only GitHub API結果からmerge候補planを作るだけです。

- workflow / job permissionsはread-onlyに限定する
  - `contents: read`
  - `pull-requests: read`
  - `issues: read`
  - `actions: read`
  - `checks: read`
  - `statuses: read`
- `github.token` はPR情報、changed files、reviews、review threads、CI/check/status、repository settings、compare、actor権限のreadにだけ使う
- token値、Secret値、Cookie、OAuth情報、private URL、payload全文はログへ出さない
- Secret inputは定義しない
- `secrets: inherit` は使わない
- `pull_request_target` は使わない
- fork / external PR、古いhead SHA、最新 `changes_requested`、required CI失敗、dangerous file、secret-like追加行、API read失敗は `eligible=false` にする
- dry-run defaultで、auto-merge有効化、merge queue投入、merge API呼び出し、コメント投稿、ラベル操作、branch削除は行わない

導入先で実write処理を追加する場合も、Issue #25のplan outputsを入力にし、write tokenやmerge tokenをfork / external PRへ渡さない設計を別途レビューします。

## Auto-merge dry-run executorの権限境界

Issue #41のauto-merge dry-run executorは、複数のread-only reportを集約して最終dry-run decisionを作るだけです。

- workflow / job permissionsはread-onlyに限定する
  - `contents: read`
  - `pull-requests: read`
  - `actions: read`
  - `checks: read`
  - `statuses: read`
- Secret inputは定義しない
- `secrets: inherit` は使わない
- `pull_request_target` は使わない
- PR head codeをwrite権限付きで実行しない
- GitHub API write、merge、auto-merge enable、comment、label、Queue Issue更新、deploy、release、tag作成は行わない
- eligibleでもDisabled adapterで `write_disabled` になり、`executed=false`

実write adapterを追加する場合は、このexecutorのdecisionを入力にしたうえで、write権限、Secret境界、fork除外、expected head SHA guardを別Issueでレビューします。

## Main follow-up planの権限境界

Issue #26のmain follow-up planは、default branchが進んだあとにopen PRを分類するだけです。

- workflow / job permissionsはread-onlyに限定する
  - `contents: read`
  - `pull-requests: read`
  - `issues: read`
  - `actions: read`
  - `checks: read`
  - `statuses: read`
- `github.token` はopen PR、changed files、compare、head branch存在確認のreadにだけ使う
- token値、Secret値、Cookie、OAuth情報、private URL、payload全文はログへ出さない
- Secret inputは定義しない
- `secrets: inherit` は使わない
- `pull_request_target` は使わない
- fork / external PR、dangerous file変更、secret-like追加行、API read失敗は自動更新候補にもCodex follow-up候補にも進めない
- dry-run defaultで、PR branch update API、Codex起動、Queue Issue更新、コメント投稿、label操作は行わない

導入先でPR branch updateやCodex起動を追加する場合も、Issue #26のplan outputsを入力にし、write tokenをfork / external PRへ渡さない設計を別途レビューします。

## GitHub write adapter境界

Issue #37のwrite adapter境界は、plan outputsからwrite command候補を作るだけです。

- 既定adapterは `DisabledGitHubWriteAdapter`
- valid commandも `write_disabled` で拒否する
- GitHub API writeを呼ばない
- networkを使わない
- Secret inputを定義しない
- `secrets: inherit` を使わない
- `pull_request_target` を使わない
- write token、merge token、branch update token、comment tokenを要求しない

`FakeGitHubWriteAdapter` はテスト専用で、fixture allowance内のcommandを記録するだけです。実write adapterを追加する場合は、operationごとに必要権限、Secret境界、fork除外、idempotency store、audit logを別Issueでレビューします。

## Release readiness

Release readiness workflowは `contents: read` のみを使います。

許可しないもの:

- GitHub API write
- tag作成
- GitHub Release作成
- npm publish
- consumer repository変更
- Secret input
- `secrets: inherit`
- `pull_request_target`

consumer更新計画に強いtokenやSecretは不要です。実consumer更新PRを作る処理はIssue #27の対象外です。

## Repository protection audit

Repository protection auditはconsumer repository settingsをread-onlyで確認します。

- workflow triggerは `workflow_dispatch` のみ
- workflow / job permissionsは `contents: read`
- workflowは標準 `github.token` を `--token-source github-token` としてCLIへ渡す
- CLIはGitHub APIのGETだけを使う
- `pull_request_target` は使わない
- Secret inputは定義しない
- `secrets: inherit` は使わない
- Branch protection / Ruleset / required check / Check Runを変更しない
- PR / Issue / comment / label操作を行わない
- token値、Authorization header、Cookie、OAuth情報、API response全文をログやreportへ出さない

標準 `github.token` ではAdministration readを確認できないため、workflowは監査完了として `ready=true` にはしません。`administration_read_token_required` でmanual setupを要求します。live auditを進める場合は、利用者が手動で用意したAdministration read権限のGitHub App installation tokenまたはfine-grained PAT等をローカルCLIへ渡し、`--token-source external-read-token` を明示します。ただしGitHub Ruleset APIでは `bypass_actors` が権限により省略されることがあり、external read tokenだけではbypass actorの完全性を保証しません。`bypass_actors` が省略されたRulesetは `ruleset_bypass_visibility_unknown` でfail closedにし、manual reviewへ回します。

追加のread権限やfine-grained tokenが必要な場合も、この共通キットはtoken作成・Secret登録を行いません。Secret input、`secrets: inherit`、Administration write、GitHub settings変更は別途手動レビューなしに追加しません。

## Live consumer audit

Live consumer auditは、実consumer repositoryの導入状態をread-onlyで確認します。

CLIが使うGitHub REST APIはGETだけです。必要なread対象:

- repository metadata
- default branch ref
- config file
- caller workflow files
- `.github/workflows` tree
- Actions workflow metadata

禁止するもの:

- GitHub API write
- workflow dispatch
- consumer branch / PR / Issue / comment / label作成
- Secrets / Variables / Environments API
- consumer PR head codeのcheckoutまたは実行
- `pull_request_target`
- `secrets: inherit`
- write permission

private repositoryを監査する場合は、consumer repositoryを読めるread-only tokenを環境変数 `GITHUB_TOKEN` または `GH_TOKEN` へ設定します。token値は引数、ログ、report、docsへ出しません。API read失敗、pagination不完了、権限不足、監査中のdefault branch変更はfail closedです。

GitHub Enterprise Serverを監査する場合も、tokenを任意hostへ自動送信しません。`api.github.com` 以外へtokenを送るには、CLIで `--allow-token-host <host>` を明示します。paginationのnext URLも同じoriginとAPI base path内に限定し、redirect、HTTP、username/password付きURL、query/hash付きbase URLはfail closedです。
