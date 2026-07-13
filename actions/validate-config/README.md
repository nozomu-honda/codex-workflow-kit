# Validate Config Action

`actions/validate-config` は、導入先リポジトリの ChatGPT automation 設定ファイルを読み込み、共通のfail-closed validatorで検証するための最小Shared Actionです。

このActionは設定検証専用です。GitHub API write、label更新、PR/Issueコメント、自動レビュー、自動マージ、Codex起動、Queue Issue操作は行いません。

## Inputs

| input | default | 説明 |
|---|---:|---|
| `config-file` | `.github/chatgpt-automation.yml` | 検証する設定ファイルのパス |
| `dry-run` | `true` | dry-run指定。`false`でもこのActionは副作用を実行しません |

## Outputs

| output | 説明 |
|---|---|
| `ok` | 設定検証が成功したか |
| `error-count` | validation error数 |
| `warning-count` | validation warning数 |
| `capabilities-json` | boolean capabilityだけを含むJSON |
| `dry-run` | 実効dry-run値 |

validation失敗、config欠落、読み取り失敗時はfail closedになり、`capabilities-json` の全capabilityは `false` になります。

## ログ方針

- Secret値、token値、Cookie、OAuth情報、実URL、実ID、config全文はログへ出しません。
- 正規化済みconfig全文もログへ出しません。
- error / warningは `path`、固定 `code`、固定messageだけを出します。

## 例

```yaml
- uses: nozomu-honda/codex-workflow-kit/actions/validate-config@v1
  with:
    config-file: .github/chatgpt-automation.yml
    dry-run: 'true'
```

caller workflow / reusable workflowは後続Issueで追加します。
