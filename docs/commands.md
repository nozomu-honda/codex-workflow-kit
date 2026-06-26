# Commands

## Install

```powershell
git clone https://github.com/nozomu-honda/codex-workflow-kit.git "$env:USERPROFILE\codex-workflow-kit"
Set-Location "$env:USERPROFILE\codex-workflow-kit"
.\install.ps1
```

## Start manually

```powershell
& "$env:USERPROFILE\codex-prompts\common\codex-cross-project-autohotkey-v2.ahk"
```

## Update

```powershell
Set-Location "$env:USERPROFILE\codex-workflow-kit"
git pull
.\install.ps1
```

## Test

Type this in Notepad:

```text
;ahtest
```

Expected output:

```text
OK
```
