# Install

```powershell
git clone https://github.com/nozomu-honda/codex-workflow-kit.git "$env:USERPROFILE\codex-workflow-kit"
Set-Location "$env:USERPROFILE\codex-workflow-kit"
.\install.ps1
```

`install.ps1` keeps the existing local helper behavior. It copies the repository-root AutoHotkey script and README into:

```text
%USERPROFILE%\codex-prompts\common
```

For compatibility with older checkouts, it can also resolve the previous `tools\codex-cross-project` layout when that layout exists. The new GitHub automation directories are not required for local AutoHotkey installation.

Start the script:

```powershell
& "$env:USERPROFILE\codex-prompts\common\codex-cross-project-autohotkey-v2.ahk"
```
