# AGENTS.md

このリポジトリは、Codexを中心にした開発・PR運用の共通基盤です。

現在の主な利用者向け機能は、プロジェクト横断で使うCodex向けショートカット/プロンプト運用キットです。今後は、GitHub Actions自動レビュー・自動マージ基盤の共通実装も受け入れます。

## 基本方針

- AutoHotkey / PowerShell はWindowsローカル補助として扱い、既存の `install.ps1` 利用手順を壊さない。
- プロジェクト横断のプロンプト、運用テンプレート、GitHub automation共通実装を扱う。
- Secret、トークン、OAuth情報、Cookie、実URL、実IDをコミットしない。
- プロジェクト固有の仕様はこのリポジトリに入れず、各プロジェクト側の `AGENTS.md` / `docs/current-status.md` / `docs/TODO.md` に置く。
- 共通ショートカットは、各プロジェクト側の前提ファイルを読ませる入口に徹する。
- 導入先リポジトリ固有のlabels、Variables、Secrets、fine-grained PAT、Queue Issueは導入先側に置く。
- 実際のGitHubイベントは導入先側の薄いcaller workflowで受ける。

## GitHub上の文章言語

GitHub上で人が読む文章は、特別な理由がない限り日本語で作成する。

原則として日本語にするもの:

- Issueのタイトル・本文・コメント
- PRのタイトル・本文と人向け見出し
- PRレビュー本文・レビューコメント
- Codexへの依頼文・修正指示・作業報告
- Validation / Not run / Safetyなどの説明文
- GitHub Actionsが生成する人向けコメントやsummary

英語のままでよいもの:

- コード、識別子、変数名、関数名
- ファイルパス、ブランチ名、コマンド
- API名、HTTP status、ライブラリ名、製品名
- エラーコード、外部仕様で固定された文言
- GitHub markerや機械判定用metadata

技術用語を英語で残す場合も、周囲の説明文は日本語にする。機械連携を壊さないため、marker、metadata、API契約は言語統一だけを理由に変更しない。詳細は `docs/github-writing-language.md` を正とする。

## ディレクトリ責務

- `desktop/`: AutoHotkey / PowerShell などWindowsローカル補助の整理先。
- `actions/`: 共通JavaScript Actionまたは処理本体の配置先。
- `reusable-workflows/`: `workflow_call` 対応の共通workflow配置先。
- `templates/`: 導入先caller workflow、config、labels、setup examples。
- `docs/github-automation/`: architecture、permissions、installation、migration、validation。
- 既存互換のため、現行の `codex-cross-project-autohotkey-v2.ahk` と `install.ps1` は当面ルート直下に残す。

## GitHub automationの責務

共通側で扱うもの:

- 判定ロジック
- 設定スキーマ
- テンプレート
- reusable workflow / Action
- テスト
- 導入ドキュメント

導入先側で扱うもの:

- `issue_comment`, `pull_request_review`, `pull_request_review_comment`, `workflow_run`, `pull_request.closed`, `push` などのイベントを受ける薄いworkflow
- repository固有設定
- labels
- variables / secrets
- fine-grained PAT
- queue Issue

このIssueでは、自動レビュー・自動マージ本体の移植はまだ行わない。

## 変更時の確認

- `codex-cross-project-autohotkey-v2.ahk` を変更したら、Windows + AutoHotkey v2で `;ahtest` / `;cxgo` の展開確認を行う。
- `install.ps1` を変更したら、PowerShellでコピー先パスとスタートアップ設定手順に矛盾がないか確認する。
- READMEの手順と実ファイル名を一致させる。
- GitHub automation領域を変更したら、該当docs、tests、テンプレートの整合性を確認する。

## 禁止事項

- 実プロジェクトのID、URL、Secret、トークンをサンプルに含めない。
- 特定プロジェクト専用の長い業務仕様を共通テンプレートへ入れない。
- 本番環境への直接操作手順を自動化しない。
- `pull_request_target` を使わない。
- fork / external PRへSecretを渡さない。
- 共通化を理由に導入先の安全条件を緩めない。
