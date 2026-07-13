# reusable-workflows

`workflow_call` に対応した共通workflowの設計説明を置く領域です。

導入先リポジトリでは、`issue_comment`、`pull_request_review`、`workflow_run`、`pull_request.closed`、`push` などのイベントを薄いcaller workflowで受け、必要に応じてここに置くreusable workflowを呼び出す想定です。

## 現在のworkflow

- `.github/workflows/validate-config.yml`: `workflow_call` で設定ファイルを検証する読み取り専用reusable workflow。

実行可能なworkflow実体は、GitHub Actionsが認識する `.github/workflows` 直下に置きます。`reusable-workflows/validate-config.yml` は存在せず、同じworkflowを二重管理しません。

`.github/workflows/validate-config.yml` は以下だけを行います。

1. caller repositoryを `actions/checkout@v4` でcheckoutする
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

導入先の薄いcaller workflowでは、このreusable workflowを `v1.2.3` 形式の完全なversion tagまたは40桁commit SHAへ固定して呼び出します。

GitHub Actionsで直接呼び出せる公開パスへ接続した後のcaller例:

```yaml
jobs:
  validate-config:
    permissions:
      contents: read
    uses: nozomu-honda/codex-workflow-kit/.github/workflows/validate-config.yml@<v1.2.3-or-40-character-commit-sha>
    with:
      config-file: .github/chatgpt-automation.yml
      dry-run: true
```

caller側のreusable workflow refと、reusable workflow内部のAction refはどちらも固定します。内部Action refは40桁commit SHAだけを許可し、`master` / `main`、branch名、短縮SHA、tag参照は使いません。内部Action refを更新する場合は、候補commitに `actions/validate-config/action.yml` と `actions/validate-config/dist/index.js` が存在することを確認します。
