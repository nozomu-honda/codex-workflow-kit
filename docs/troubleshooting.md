# Troubleshooting

## Hotstrings do not expand

Check:

- AutoHotkey v2 is installed.
- `codex-cross-project-autohotkey-v2.ahk` is running.
- Try `;ahtest` in Notepad.
- Restart or reload the AutoHotkey script.

## `install.ps1` cannot run

PowerShell execution policy may block scripts.

Use this for the current session only:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\install.ps1
```

## Wrong or old prompt expands

Reload the AutoHotkey script from the tray icon or restart the `.ahk` file.

## Works on one PC but not another

This kit is installed per PC. Clone this repository and run `install.ps1` on each Windows PC.
