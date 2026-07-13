# reusable-workflows

`workflow_call` に対応した共通workflowを置く予定の領域です。

導入先リポジトリでは、`issue_comment`、`pull_request_review`、`workflow_run`、`pull_request.closed`、`push` などのイベントを薄いcaller workflowで受け、必要に応じてここに置くreusable workflowを呼び出す想定です。

## 現在のworkflow

- `validate-config.yml`: `workflow_call` で設定ファイルを検証する読み取り専用reusable workflow。

`validate-config.yml` は以下だけを行います。

1. caller repositoryを `actions/checkout@v4` でcheckoutする
2. `nozomu-honda/codex-workflow-kit/actions/validate-config@master` を呼び出す
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

このPRではcaller workflow templateは追加しません。後続Issueで導入先の薄いcaller workflowを追加するときは、このreusable workflowをtagまたはcommit SHAへ固定して呼び出します。

GitHub Actionsで直接呼び出せる公開パスへ接続した後のcaller例:

```yaml
jobs:
  validate-config:
    permissions:
      contents: read
    uses: nozomu-honda/codex-workflow-kit/.github/workflows/validate-config.yml@<tag-or-commit-sha>
    with:
      config-file: .github/chatgpt-automation.yml
      dry-run: true
```

refは将来的にtagまたはcommit SHAへ固定します。`master` 参照は初期検証中の暫定参照として扱います。
