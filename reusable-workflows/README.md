# reusable-workflows

`workflow_call` に対応した共通workflowの設計説明を置く領域です。

導入先リポジトリでは、`issue_comment`、`pull_request_review`、`workflow_run`、`pull_request.closed`、`push` などのイベントを薄いcaller workflowで受け、必要に応じてここに置くreusable workflowを呼び出す想定です。

## 現在のworkflow

- `.github/workflows/validate-config.yml`: `workflow_call` で設定ファイルを検証する読み取り専用reusable workflow。
- `.github/workflows/normalize-event.yml`: `workflow_call` で実GitHubイベントpayloadを共通形式へ正規化する読み取り専用reusable workflow。

実行可能なworkflow実体は、GitHub Actionsが認識する `.github/workflows` 直下に置きます。`reusable-workflows/validate-config.yml` は存在せず、同じworkflowを二重管理しません。

`.github/workflows/validate-config.yml` は以下だけを行います。

1. caller repositoryを `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5` でcheckoutする
2. `nozomu-honda/codex-workflow-kit/actions/validate-config@03d54075f77034124b0b0982200b0d44059bed8a` を呼び出す
3. Action outputsをworkflow outputsとして公開する

公開するworkflow outputs:

- `ok`
- `error-count`
- `warning-count`
- `capabilities-json`
- `dry-run`

## 安全境界

- permissionsは `contents: read` のみ
- Secret inputは定義しない
- `secrets: inherit` は使わない
- `pull_request_target` は使わない
- GitHub API write、PR/Issueコメント、label変更、review、merge、自動マージ、Codex起動、Queue Issue操作は行わない

## 外部repositoryからの呼び出し方針

導入先の薄いcaller workflowでは、このreusable workflowをレビュー済み40桁commit SHAへ固定して呼び出します。

GitHub Actionsで直接呼び出せる公開パスへ接続した後のcaller例:

```yaml
jobs:
  validate-config:
    permissions:
      contents: read
    uses: nozomu-honda/codex-workflow-kit/.github/workflows/validate-config.yml@0123456789abcdef0123456789abcdef01234567
    with:
      config-file: .github/chatgpt-automation.yml
      dry-run: true
```

caller側のreusable workflow refと、reusable workflow内部のAction refはどちらも固定します。内部Action refは40桁commit SHAだけを許可し、`master` / `main`、branch名、短縮SHA、tag参照は使いません。内部Action refを更新する場合は、候補commitに `actions/validate-config/action.yml` と `actions/validate-config/dist/index.js` が存在することを確認します。

## Event normalization workflow

`.github/workflows/normalize-event.yml` は、導入先caller workflowから実イベントpayloadを受け取り、後続jobが使う安定outputsへ変換します。

対象イベント:

- `issue_comment`
- `pull_request_review`
- `pull_request_review_comment`
- `workflow_run`
- `pull_request.closed`
- `push`

公開するworkflow outputs:

- `event_name`
- `event_action`
- `repository`
- `repository_owner`
- `default_branch`
- `actor`
- `issue_number`
- `pull_request_number`
- `head_sha`
- `base_sha`
- `head_repository`
- `is_same_repository`
- `is_fork`
- `workflow_name`
- `workflow_conclusion`
- `dry_run`
- `eligible`
- `ineligible_reason`

`eligible=false` の場合、後続のwrite処理へ進めません。Issue #23ではwrite処理自体を実装せず、fork / external PR、失敗した `workflow_run`、未mergeの `pull_request.closed`、default branch以外への `push`、想定外action、入力不備を安全側に倒します。

呼び出し例:

```yaml
jobs:
  normalize-event:
    permissions:
      contents: read
    uses: nozomu-honda/codex-workflow-kit/.github/workflows/normalize-event.yml@0123456789abcdef0123456789abcdef01234567
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
      kit-ref: 0123456789abcdef0123456789abcdef01234567
```

`kit-ref` は、このreusable workflowを呼ぶrefと同じ固定refにします。Secret input、`secrets: inherit`、write permission、`pull_request_target` は使いません。
