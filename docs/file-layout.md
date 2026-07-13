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
  validate-config/
    README.md
    action.yml
    dist/index.js
    dist/package.json
    src/index.js
    test/
reusable-workflows/
  README.md
  validate-config.yml
  test/
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
- `actions/validate-config/` for the side-effect-free config validation Action
- `reusable-workflows/` for `workflow_call` workflows
- `reusable-workflows/validate-config.yml` for the read-only config validation reusable workflow source
- `templates/` for thin caller workflows, config examples, and setup notes
- `docs/github-automation/` for architecture, permissions, installation, migration, validation, and follow-up planning

`actions/validate-config/` reads a config file and runs the fail-closed validator only. It does not perform GitHub API writes, comments, reviews, merges, Codex triggers, or Queue Issue operations. `dist/index.js` is the committed bundled runtime so adopters can run the Action without installing this repository's npm dependencies.

`reusable-workflows/validate-config.yml` calls the validation Action through `workflow_call` and keeps permissions at `contents: read`. It does not define Secret inputs, use `secrets: inherit`, or perform write operations.

This layout does not migrate existing auto-review or auto-merge implementation yet.
