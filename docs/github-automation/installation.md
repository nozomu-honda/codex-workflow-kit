# Installation

導入先リポジトリでは、薄いcaller workflowからこのリポジトリのreusable workflowまたはActionを呼ぶ想定です。

このIssueでは、まだreusable workflow / Action本体を提供しません。導入手順は後続Issueで実装に合わせて更新します。

## 将来の導入ステップ

1. 導入先リポジトリでlabelsを作成する
2. 必要なrepository variablesを設定する
3. 必要なrepository secretsまたはfine-grained PATを設定する
4. caller workflow templateを導入先へ追加する
5. dry-runで判定だけを確認する
6. 小さいdocs-only PRでend-to-end確認する

## 互換性

AutoHotkey / `install.ps1` の既存利用者は、このGitHub automation導入手順を使う必要はありません。ローカル入力補助は引き続きREADMEと `docs/install.md` の手順で利用できます。
