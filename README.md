# Codex Workflow Kit

Codexを中心にした開発・PR運用の共通基盤です。

現在は、WindowsローカルのCodex入力補助と、プロジェクト横断で使うプロンプト/運用テンプレートを提供しています。今後は、GitHub Actionsによる自動レビュー・自動マージ基盤の共通実装もこのリポジトリで扱います。

各リポジトリごとに細かいショートカットを作るのではなく、共通の入口を使って、Codexにそのリポジトリの `AGENTS.md` / `CLAUDE.md` / `docs/current-status.md` / `docs/TODO.md` を読ませる運用にします。

導入先リポジトリ固有の設定、labels、Variables、Secrets、fine-grained PAT、Queue Issue はこのリポジトリには置きません。実際のGitHubイベントは導入先側の薄いcaller workflowで受け、このリポジトリ側は共通ロジック、設定スキーマ、テンプレート、reusable workflow / Action、テスト、導入ドキュメントを提供します。

## このリポジトリに入っているもの

```text
README.md
AGENTS.md
codex-cross-project-autohotkey-v2.ahk
install.ps1
desktop/
actions/
reusable-workflows/
templates/
docs/github-automation/
```

現時点では、AutoHotkey / PowerShell の既存利用手順を壊さないため、`codex-cross-project-autohotkey-v2.ahk` と `install.ps1` はルート直下に残します。`desktop/` は今後の整理先であり、このIssueでは既存ファイルを移動しません。

## 責務分離

| 領域 | 責務 |
|---|---|
| `desktop/` | AutoHotkey / PowerShell などWindowsローカル補助の整理先 |
| `actions/` | 共通JavaScript Actionまたは処理本体の配置先 |
| `reusable-workflows/` | `workflow_call` 対応の共通workflow配置先 |
| `templates/` | 導入先caller workflow、config、labels、setup examples |
| `docs/github-automation/` | architecture、permissions、installation、migration、validation |
| `packages/chatgpt-automation-core/` | GitHub automation設定schema / validatorなどの純粋ロジック |
| `schemas/` | JSON Schemaなど、設定正本の配置先 |

このIssueでは、自動レビュー・自動マージ本体の移植や公開はまだ行いません。

`actions/validate-config` には、設定ファイルを読み込んでfail-closed validatorを実行する副作用なしのShared Actionを置いています。このActionはGitHub API write、PR/Issueコメント、自動レビュー、自動マージ、Codex起動を行いません。GitHub Actions runtimeは `node24` です。

`.github/workflows/validate-config.yml` には、`workflow_call` で `actions/validate-config` を呼び出す読み取り専用reusable workflowの最小骨格を置いています。権限は `contents: read` のみで、Secret input、`secrets: inherit`、GitHub API writeは使いません。内部Action参照もレビュー済みの40桁commit SHAへ固定し、caller側と内部Action側の両方で再現性を保ちます。

`templates/workflows/validate-config.yml` には、導入先が `.github/workflows/validate-config.yml` へコピーして使う設定検証用caller workflowテンプレートを置いています。triggerは `workflow_dispatch` のみで、reusable workflow refは導入時に `v1.2.3` 形式の完全なversion tagまたは40桁commit SHAへ置換します。

`scripts/audit-consumer-installation.mjs` には、導入先リポジトリのChatGPT automation設定とcaller workflowをネットワークアクセスなし・GitHub API writeなしで監査するread-only CLIを置いています。詳細は `docs/github-automation/installation-audit.md` を参照してください。

`.github/workflows/ci.yml` には、この共通キット自身のread-only CIを置いています。`pull_request`、`master` push、`workflow_dispatch` で起動し、workflow / job permissionsは `contents: read` のみに固定します。外部Actionはレビュー済み40桁commit SHAで参照し、Secret、GitHub API write、release、deploy、tag作成、mergeは行いません。

CIでは Node 20.19.0 以上でフルvalidationを行い、Node 24で `actions/validate-config` と配布物整合性を確認します。さらにローカルのreusable workflow smokeをjob-level `uses` で実行し、`ok`、`error-count`、`warning-count`、`capabilities-json`、`dry-run` outputsが期待どおりであることを確認します。

offline consumer E2Eは、`templates/` から一時的な導入先リポジトリを作り、config / caller workflow / installation audit CLI / Shared Action source / Shared Action distを副作用なしで検証します。このE2Eは実GitHub repository、Secret、外部API、ネットワーク、GitHub API writeを使いません。実導入先リポジトリを使ったcross-repo E2Eは後続Issueで扱います。

主なローカル確認コマンド:

```bash
npm ci
npm run ci
npm run test:e2e:consumer
npm run lint:e2e
```

## 推奨配置

ローカルPCでは、以下のようにプロジェクト横断の共通ファイルとして置く想定です。

```text
C:\Users\user\codex-prompts\common\
  codex-cross-project-autohotkey-v2.ahk
  README.md
```

## インストール

このリポジトリをcloneして、`install.ps1` を実行します。

```powershell
git clone https://github.com/nozomu-honda/codex-workflow-kit.git "$env:USERPROFILE\codex-workflow-kit"
Set-Location "$env:USERPROFILE\codex-workflow-kit"
.\install.ps1
```

手動でコピーする場合:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\codex-prompts\common"
Copy-Item .\codex-cross-project-autohotkey-v2.ahk "$env:USERPROFILE\codex-prompts\common\"
Copy-Item .\README.md "$env:USERPROFILE\codex-prompts\common\"
```

起動:

```powershell
& "$env:USERPROFILE\codex-prompts\common\codex-cross-project-autohotkey-v2.ahk"
```

## PC起動時に自動起動する設定

毎回 `.ahk` を手動で起動しなくてよいように、Windowsのスタートアップフォルダへショートカットを置きます。

1. `Win + R` を押す
2. 以下を入力してEnter

```text
shell:startup
```

3. スタートアップフォルダが開く
4. 別のエクスプローラーで以下のファイルを開く

```text
C:\Users\user\codex-prompts\common\codex-cross-project-autohotkey-v2.ahk
```

5. `.ahk` ファイルを右クリックして、`その他のオプションを確認` → `ショートカットの作成`
6. 作成したショートカットを、スタートアップフォルダへ移動する
7. PCを再起動し、メモ帳で `;ahtest` → `OK` になるか確認する

PowerShellでショートカットを作る場合は以下でもよいです。

```powershell
$ahkPath = "$env:USERPROFILE\codex-prompts\common\codex-cross-project-autohotkey-v2.ahk"
$startup = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startup 'Codex Cross Project Shortcuts.lnk'
$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $ahkPath
$shortcut.WorkingDirectory = Split-Path $ahkPath
$shortcut.Save()
```

AutoHotkeyを更新した場合は、タスクトレイのAutoHotkeyアイコンを右クリックして `Reload Script` するか、一度終了して `.ahk` を起動し直してください。

## ショートカット方針

AutoHotkey側には、プロジェクト固有の長い仕様を書かない。

残す入口は以下に絞る。

| 入力 | 用途 |
|---|---|
| `;cxgo` | 通常の効率重視タスク。調査・実装・テスト・Draft PRまで |
| `;cxfast` | `;cxgo` と同じ |
| `;cxq` | 調査だけ |
| `;cxpr` | PRレビュー |
| `;cxgas` | GAS/デプロイ前チェック。GAS以外ではデプロイ前チェックとして使う |
| `;cxmkpr` | Draft PR作成だけ |
| `;cx00` | 文脈確認 |
| `;ahtest` | AutoHotkey動作確認 |

## Codexに読ませる前提ファイル

各プロジェクト側には、可能なら以下を置く。

```text
AGENTS.md
CLAUDE.md
docs/current-status.md
docs/TODO.md
```

最低限 `AGENTS.md` があれば、共通ショートカットからでもそのプロジェクトのルールを読み込ませやすいです。

## 共通ショートカットの考え方

### `;cxgo`

明確な作業依頼の通常入口です。

Codexに以下を任せます。

1. 現状確認
2. 影響範囲確認
3. 実装
4. 関連テスト追加/更新
5. ローカルで可能な確認
6. 必要なドキュメント更新
7. コミット
8. Draft PR作成

ただし、以下では止まらせます。

- main / develop への直接コミットが必要
- Secret、トークン、OAuth情報、実URL、実IDが必要
- 本番環境や本番データに触る必要
- DBスキーマや出力列など破壊的変更が必要
- 複数PRに分けるべき大きさ
- 既存仕様と矛盾する可能性

### `;cxq`

仕様リスクが高いときの調査専用入口です。

コード変更はさせません。

### `;cxpr`

PRレビュー専用です。

コード変更はさせず、危険箇所、テスト不足、手動確認項目を洗い出します。

### `;cxgas`

株管理ツールではGAS反映前チェックに使います。

GAS以外のプロジェクトでは「デプロイ前チェック」として読み替えます。

## セキュリティ方針

- Secret、トークン、OAuth情報、Cookie、実URL、実IDはショートカットやテンプレに埋め込まない。
- 具体的な値が必要な場合は、GitHub Secrets、ローカル環境変数、各プロジェクトの非公開設定で管理する。
- `pull_request_target` を安易に使わない。
- fork / external PR にSecretを渡さない。
- 共通化によって導入先の安全条件を緩めない。
- 設定欠落や不正値は安全側に倒す。

## 使い始めの手順

1. このリポジトリをcloneする
2. `install.ps1` を実行する
3. `.ahk` を起動する
4. 必要ならスタートアップフォルダへショートカットを置く
5. メモ帳で `;ahtest` → `OK` を確認する
6. Codex入力欄で `;cxgo` を確認する
7. 各プロジェクトの `AGENTS.md` を整備する
8. 必要ならプロジェクト固有の補足だけ、そのリポジトリ内の docs に置く

## このキットでやらないこと

- 各プロジェクト固有の実IDやSecret管理
- 本番環境への直接反映
- GitHub rulesetやCIの個別設定変更
- Codexアプリ本体のUI拡張
- 導入先リポジトリのworkflow/scriptを無条件に移植すること
