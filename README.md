# Codex Cross Project Kit

このディレクトリは、株管理ツール以外のプロジェクトでも使えるCodex向けショートカット/プロンプト運用の雛形です。

目的は、各リポジトリごとに細かいショートカットを作るのではなく、共通の入口を使って、Codexにそのリポジトリの `AGENTS.md` / `CLAUDE.md` / `docs/current-status.md` / `docs/TODO.md` を読ませる運用にすることです。

## 推奨配置

ローカルPCでは、以下のようにプロジェクト横断の共通ファイルとして置く想定です。

```text
C:\Users\user\codex-prompts\
  common\
    codex-cross-project-autohotkey-v2.ahk
    README.md
```

このリポジトリからコピーする場合:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\codex-prompts\common"
Copy-Item .\tools\codex-cross-project\codex-cross-project-autohotkey-v2.ahk "$env:USERPROFILE\codex-prompts\common\"
Copy-Item .\tools\codex-cross-project\README.md "$env:USERPROFILE\codex-prompts\common\"
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

## 使い始めの手順

1. このディレクトリの `.ahk` をローカル共通フォルダへコピーする
2. `.ahk` を起動する
3. 必要ならスタートアップフォルダへショートカットを置く
4. メモ帳で `;ahtest` → `OK` を確認する
5. Codex入力欄で `;cxgo` を確認する
6. 各プロジェクトの `AGENTS.md` を整備する
7. 必要ならプロジェクト固有の補足だけ、そのリポジトリ内の docs に置く

## このキットでやらないこと

- 各プロジェクト固有の実IDやSecret管理
- 本番環境への直接反映
- GitHub rulesetやCIの個別設定変更
- Codexアプリ本体のUI拡張
