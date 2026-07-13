# Installation

導入先リポジトリでは、薄いcaller workflowからこのリポジトリのreusable workflowまたはActionを呼ぶ想定です。

現在は、設定schema、fail-closed validator、設定検証Action、設定検証reusable workflow、初回確認用caller workflowテンプレートを提供しています。自動レビュー、自動マージ、Codex起動、Queue Issue操作のcaller workflowは後続Issueで追加します。

## Config

導入先設定ファイル名の想定:

```text
.github/chatgpt-automation.yml
```

このリポジトリにはsampleとして以下を置きます。

```text
templates/chatgpt-automation.yml
```

導入先で使うSecret / Variableは、値ではなく名前だけを設定します。設定値の検証は `packages/chatgpt-automation-core` のfail-closed validatorで行います。

ローカル確認:

```bash
npm ci
npm run validate:config
```

## Validate config caller workflow

初回は設定検証専用caller workflowを手動実行します。

1. 導入先リポジトリへ設定ファイルを追加する。

```text
.github/chatgpt-automation.yml
```

2. このリポジトリのテンプレートを導入先へコピーする。

```text
templates/workflows/validate-config.yml
```

コピー先:

```text
.github/workflows/validate-config.yml
```

3. コピーしたworkflow内のref placeholderを固定refへ置換する。

```text
REPLACE_WITH_TAG_OR_40_CHAR_COMMIT_SHA
```

置換先は、このリポジトリのrelease tagまたは40桁commit SHAにします。`master` / `main` などの可変branch参照は、後から内容が変わるため禁止します。

4. GitHub Actionsの `workflow_dispatch` で手動実行する。

valid configでは成功し、invalid configではfail closedで失敗します。この確認にSecretは不要で、permissionsは `contents: read` のみです。

実イベントtriggerは後続Issueで機能ごとに追加します。

## 将来の導入ステップ

1. 導入先リポジトリでlabelsを作成する
2. 必要なrepository variablesを設定する
3. 必要なrepository secretsまたはfine-grained PATを設定する
4. `.github/chatgpt-automation.yml` を追加する
5. `npm run validate:config` 相当で設定を検証する
6. caller workflow templateを導入先へ追加する
7. dry-runで判定だけを確認する
8. 小さいdocs-only PRでend-to-end確認する

## 互換性

AutoHotkey / `install.ps1` の既存利用者は、このGitHub automation導入手順を使う必要はありません。ローカル入力補助は引き続きREADMEと `docs/install.md` の手順で利用できます。
