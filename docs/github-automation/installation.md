# Installation

導入先リポジトリでは、薄いcaller workflowからこのリポジトリのreusable workflowまたはActionを呼ぶ想定です。

このIssueでは、まだreusable workflow / Action本体を提供しません。導入手順は後続Issueで実装に合わせて更新します。

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
