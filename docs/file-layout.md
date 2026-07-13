# File layout

```text
README.md
AGENTS.md
LICENSE
package.json
package-lock.json
install.ps1
codex-cross-project-autohotkey-v2.ahk
desktop/
  README.md
actions/
  README.md
reusable-workflows/
  README.md
templates/
  README.md
  chatgpt-automation.yml
scripts/
  validate-config.mjs
examples/
  AGENTS.example.md
  current-status.example.md
  TODO.example.md
  tasks.example.md
docs/
  autohotkey.md
  branching.md
  changelog.md
  checklist.md
  commands.md
  design.md
  development.md
  faq.md
  file-layout.md
  history.md
  hotstrings.md
  install.md
  local-paths.md
  maintenance.md
  next-steps.md
  notes.md
  project-files.md
  project-setup.md
  release-notes.md
  repository-goals.md
  repository-split.md
  roadmap.md
  security.md
  source-of-truth.md
  scope.md
  troubleshooting.md
  update.md
  usage.md
  windows-startup.md
  github-automation/
    README.md
    architecture.md
    config-schema.md
    permissions.md
    installation.md
    migration.md
    validation.md
    follow-up-issues.md
packages/
  chatgpt-automation-core/
    src/config/
    test/
schemas/
  chatgpt-automation.schema.json
```

## Compatibility notes

The existing Windows helper entrypoints stay at the repository root:

- `install.ps1`
- `codex-cross-project-autohotkey-v2.ahk`

`desktop/` is the future home for AutoHotkey / PowerShell helper organization, but the current install flow still copies the root files into `%USERPROFILE%\codex-prompts\common`.

GitHub automation areas are intentionally separate:

- `actions/` for shared JavaScript Action or implementation code
- `reusable-workflows/` for `workflow_call` workflows
- `templates/` for thin caller workflows, config examples, and setup notes
- `docs/github-automation/` for architecture, permissions, installation, migration, validation, and follow-up planning

This layout does not migrate existing auto-review or auto-merge implementation yet.
