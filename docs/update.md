# Update

To update the local installed shortcuts:

```powershell
Set-Location "$env:USERPROFILE\codex-workflow-kit"
git pull
.\install.ps1
```

Then reload AutoHotkey:

1. Right-click the AutoHotkey tray icon.
2. Choose `Reload Script`.

Or exit AutoHotkey and start the script again:

```powershell
& "$env:USERPROFILE\codex-prompts\common\codex-cross-project-autohotkey-v2.ahk"
```
