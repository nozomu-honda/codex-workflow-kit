# Usage

## First setup

```powershell
git clone https://github.com/nozomu-honda/codex-workflow-kit.git "$env:USERPROFILE\codex-workflow-kit"
Set-Location "$env:USERPROFILE\codex-workflow-kit"
.\install.ps1
```

Then start the AutoHotkey script:

```powershell
& "$env:USERPROFILE\codex-prompts\common\codex-cross-project-autohotkey-v2.ahk"
```

## Daily use

Open a project in Codex and type one of these hotstrings:

- `;cxgo`
- `;cxq`
- `;cxpr`
- `;cxgas`
- `;cxmkpr`

## Recommended project files

Each project should have at least:

```text
AGENTS.md
```

Better:

```text
AGENTS.md
docs/current-status.md
docs/TODO.md
```

## Updating the kit

```powershell
Set-Location "$env:USERPROFILE\codex-workflow-kit"
git pull
.\install.ps1
```

If AutoHotkey is already running, reload it from the tray icon or restart the `.ahk` file.
