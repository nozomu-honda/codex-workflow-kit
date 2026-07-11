# Scope

In scope:

- Codex prompt hotstrings
- AutoHotkey v2 script
- PowerShell install helper
- Cross-project prompt and operation templates
- Shared GitHub Actions auto-review / auto-merge foundation design
- Future shared GitHub Action or reusable workflow implementation
- Documentation, examples, and migration guidance

Out of scope:

- project-specific business logic
- production deployment automation
- secret management
- repository-specific labels, variables, secrets, fine-grained PATs, and Queue Issues
- consumer repository event routing beyond thin caller workflow templates
- migrating existing auto-review or auto-merge implementation as part of the initial structure task

GitHub automation support is split between this shared kit and each consumer repository. This kit owns shared decision logic, config schema, templates, reusable workflow / Action code, tests, and docs. Consumer repositories own actual event triggers, repository settings, secrets, labels, and operational queues.
