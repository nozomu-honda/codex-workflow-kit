# AGENTS.md

このリポジトリは、プロジェクト横断で使うCodex向けショートカット/プロンプト運用キットです。

## 基本方針

- AutoHotkey / PowerShell / README など、開発補助ファイルのみを扱う。
- Secret、トークン、OAuth情報、Cookie、実URL、実IDをコミットしない。
- プロジェクト固有の仕様はこのリポジトリに入れず、各プロジェクト側の `AGENTS.md` / `docs/current-status.md` / `docs/TODO.md` に置く。
- 共通ショートカットは、各プロジェクト側の前提ファイルを読ませる入口に徹する。

## 変更時の確認

- `codex-cross-project-autohotkey-v2.ahk` を変更したら、Windows + AutoHotkey v2で `;ahtest` / `;cxgo` の展開確認を行う。
- `install.ps1` を変更したら、PowerShellでコピー先パスとスタートアップ設定手順に矛盾がないか確認する。
- READMEの手順と実ファイル名を一致させる。

## 禁止事項

- 実プロジェクトのID、URL、Secret、トークンをサンプルに含めない。
- 特定プロジェクト専用の長い業務仕様を共通テンプレートへ入れない。
- 本番環境への直接操作手順を自動化しない。
