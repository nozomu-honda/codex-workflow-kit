# templates

導入先リポジトリへコピーまたは参照するテンプレートを置く領域です。

想定する内容:

- caller workflow examples
- config examples
- label setup examples
- repository variables / secrets setup notes

実値のSecret、token、OAuth情報、Cookie、実URL、実IDは置きません。

## Caller workflow templates

### `workflows/validate-config.yml`

導入先でChatGPT automation設定を初回検証するための、読み取り専用caller workflowテンプレートです。

コピー先:

```text
.github/workflows/validate-config.yml
```

このテンプレートの特徴:

- triggerは `workflow_dispatch` のみ
- jobはreusable workflowをjob-level `uses` で呼ぶだけ
- permissionsは `contents: read` のみ
- `config-file: .github/chatgpt-automation.yml`
- `dry-run: true`
- Secret、`secrets: inherit`、`runs-on`、`steps`、`run`、`pull_request_target` は使わない

導入手順:

1. `templates/workflows/validate-config.yml` を導入先の `.github/workflows/validate-config.yml` へコピーする。
2. `REPLACE_WITH_TAG_OR_40_CHAR_COMMIT_SHA` を、このリポジトリの `v1.2.3` 形式の完全なversion tagまたは40桁commit SHAへ置換する。
3. `v1` / `v1.2` のような未固定major/minor tagや、`master` / `main` などの可変branch参照は使わない。
4. 導入先に `.github/chatgpt-automation.yml` を置く。
5. GitHub Actionsの `workflow_dispatch` で手動実行し、valid configでは成功、invalid configではfail closedで失敗することを確認する。

実イベントtriggerは後続Issueで機能ごとに追加します。
