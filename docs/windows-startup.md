# Windows startup

To start the AutoHotkey shortcuts automatically when Windows starts:

1. Press `Win + R`.
2. Enter:

```text
shell:startup
```

3. Put a shortcut to this file in the startup folder:

```text
C:\Users\user\codex-prompts\common\codex-cross-project-autohotkey-v2.ahk
```

4. Restart Windows.
5. Open Notepad and type `;ahtest`.
6. Confirm it expands to `OK`.

PowerShell shortcut creation:

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
