$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$sourceDir = Join-Path $repoRoot 'tools\codex-cross-project'
$targetDir = Join-Path $env:USERPROFILE 'codex-prompts\common'

New-Item -ItemType Directory -Force $targetDir | Out-Null

Copy-Item (Join-Path $sourceDir 'codex-cross-project-autohotkey-v2.ahk') $targetDir -Force
Copy-Item (Join-Path $sourceDir 'README.md') $targetDir -Force

$ahkPath = Join-Path $targetDir 'codex-cross-project-autohotkey-v2.ahk'

Write-Host 'Installed Codex cross-project shortcuts:'
Write-Host $ahkPath
Write-Host ''
Write-Host 'Next steps:'
Write-Host '1. Double-click the .ahk file, or run:'
Write-Host "   & `"$ahkPath`""
Write-Host '2. Test in Notepad: ;ahtest should expand to OK'
Write-Host '3. Test in Codex: ;cxgo should expand to the cross-project task prompt'
Write-Host ''
Write-Host 'Optional startup folder:'
Write-Host 'Win + R -> shell:startup -> place a shortcut to the .ahk file there.'
