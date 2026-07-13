# Event normalization

Issue #23 では、導入先リポジトリが受け取る実GitHubイベントを、薄いcaller workflowから共通reusable workflowへ渡し、後続Issue #24以降が使える共通形式へ正規化します。

この段階では、PRコメント、label変更、自動レビュー、自動マージ、main追従、Codex起動、Queue Issue更新などのwrite処理は実装しません。

## 責務分離

導入先caller workflowの責務:

- `on:` で実イベントを受ける
- `permissions: contents: read` を宣言する
- reusable workflowを固定refで呼ぶ
- `github.event_name`、`github.event.action`、`toJson(github.event)`、repository情報、actor、ref、shaを渡す
- 導入先固有のVariablesをJSON文字列として渡す

共通reusable workflowの責務:

- event name / action を判定する
- repository、owner、default branch、actorを正規化する
- issue / PR番号を抽出する
- head / base SHA、head repositoryを正規化する
- fork / same-repository境界を判定する
- `workflow_run` のworkflow名、conclusion、head SHAを正規化する
- `push` の対象branchを正規化し、default branch以外をeligibleにしない
- dry-run、permission mode、requested capabilityをfail closedで判定する
- 後続job向けoutputsを生成する

導入先固有のlabels、Variables、Secrets、fine-grained PAT、Queue Issue番号は導入先リポジトリに残します。

## 対象イベント

`templates/workflows/chatgpt-automation-events.yml` は次のイベントを受けます。

- `issue_comment`
- `pull_request_review`
- `pull_request_review_comment`
- `workflow_run`
- `pull_request` の `closed`
- `push`

`pull_request_target` は使いません。`push` は導入先のdefault branchへ限定するため、テンプレート内の `REPLACE_WITH_DEFAULT_BRANCH` を導入先のdefault branch名へ置換します。

## reusable workflow

共通reusable workflow:

```text
.github/workflows/normalize-event.yml
```

導入先callerからの呼び出し例:

```yaml
jobs:
  normalize-event:
    permissions:
      contents: read
    uses: nozomu-honda/codex-workflow-kit/.github/workflows/normalize-event.yml@<v1.2.3-or-40-character-commit-sha>
    with:
      event-name: ${{ github.event_name }}
      event-action: ${{ github.event.action || '' }}
      event-payload-json: ${{ toJson(github.event) }}
      repository: ${{ github.repository }}
      repository-owner: ${{ github.repository_owner }}
      default-branch: ${{ github.event.repository.default_branch }}
      actor: ${{ github.actor }}
      ref-name: ${{ github.ref_name }}
      sha: ${{ github.sha }}
      dry-run: true
      permission-mode: read-only
      requested-capability: normalize-only
      repository-config-json: ${{ vars.CHATGPT_AUTOMATION_EVENT_CONFIG_JSON || '{}' }}
      kit-ref: <same-v1.2.3-or-40-character-commit-sha>
```

`kit-ref` は、reusable workflow本体と同じ固定refへ置換します。`master` / `main`、feature branch、短縮SHA、`v1` / `v1.2` は使いません。

## workflow_call inputs

必須input:

- `event-name`
- `event-payload-json`
- `repository`
- `repository-owner`
- `default-branch`
- `actor`
- `kit-ref`

任意input:

- `event-action`
- `ref-name`
- `sha`
- `dry-run`。defaultは `true`
- `permission-mode`。Issue #23では `read-only` のみ
- `requested-capability`。Issue #23では `normalize-only` のみ
- `repository-config-json`。Secret値は渡さない

Secret inputは定義しません。`secrets: inherit` も使いません。

## outputs

後続workflowは次のoutputsを参照します。存在しない値は空文字列にします。boolean相当の値はGitHub Actions outputとして扱いやすいように文字列 `true` / `false` で返します。

| Output | 意味 |
| --- | --- |
| `event_name` | 正規化済みevent name |
| `event_action` | 正規化済みevent action |
| `repository` | 導入先repository full name |
| `repository_owner` | 導入先repository owner |
| `default_branch` | 導入先default branch |
| `actor` | event actor |
| `issue_number` | issue number。なければ空文字列 |
| `pull_request_number` | PR number。なければ空文字列 |
| `head_sha` | head SHA。なければ空文字列 |
| `base_sha` | base SHA。なければ空文字列 |
| `head_repository` | head repository full name。なければ空文字列 |
| `is_same_repository` | same-repositoryなら `true` |
| `is_fork` | fork / externalなら `true` |
| `workflow_name` | `workflow_run` のworkflow名。なければ空文字列 |
| `workflow_conclusion` | `workflow_run` のconclusion。なければ空文字列 |
| `dry_run` | 実効dry-run |
| `eligible` | 後続のread-only処理へ進める場合だけ `true` |
| `ineligible_reason` | `eligible=false` の理由 |

## fail closed

次の場合は `eligible=false` になります。

- event payload JSONが壊れている
- repositoryが一致しない
- fork / external PR
- 必須のissue / PR番号がない
- 想定外action
- `workflow_run` が `success` 以外
- `pull_request.closed` がmergedではない
- `push` がdefault branch以外
- `dry-run` がbooleanとして解釈できない
- `permission-mode` が `read-only` 以外
- `requested-capability` が `normalize-only` 以外
- repository config JSONがobjectではない

不明payloadや欠落inputはfail openせず、空値と `eligible=false` に倒します。

## permissions / Secret境界

- defaultは `permissions: contents: read`
- Secret inputなし
- `secrets: inherit` なし
- fork / external PRへSecretを渡さない
- `pull_request_target` なし
- write処理なし
- token値、Secret値、Cookie、OAuth情報、実URL、実IDをログ出力しない

Issue #24以降でwrite処理を追加する場合も、Issue #23の `eligible`、fork/same-repository判定、dry-run、Secret境界を前提にします。

## 導入手順

1. `templates/workflows/chatgpt-automation-events.yml` を導入先の `.github/workflows/chatgpt-automation-events.yml` へコピーする。
2. `REPLACE_WITH_TAG_OR_40_CHAR_COMMIT_SHA` を、このリポジトリの `v1.2.3` 形式の完全なversion tagまたは40桁commit SHAへ置換する。
3. `kit-ref` も同じ固定refへ置換する。
4. `REPLACE_WITH_DEFAULT_BRANCH` を導入先のdefault branch名へ置換する。
5. 必要なら導入先repository variable `CHATGPT_AUTOMATION_EVENT_CONFIG_JSON` に、Secret値を含まないrepository固有設定をJSONで置く。
6. 初回はdry-runのまま、小さいdocs-only PRや安全なpushでoutputsを確認する。

## Issue #24以降との境界

Issue #23はイベント受付、payload正規化、安全判定、outputs生成までを扱います。

次は別Issueで扱います。

- ChatGPT review routing本体
- Reviewed PR auto-merge本体
- main追従 / Codex follow-up本体
- release / 固定SHA更新運用本体
