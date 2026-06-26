# Hotstrings

## Main entries

| Hotstring | Purpose |
|---|---|
| `;cxgo` | Main task entry. Research, implement, test, docs, commit, Draft PR. |
| `;cxfast` | Same as `;cxgo`. |
| `;cxq` | Research only. No code changes. |
| `;cxpr` | PR review only. No code changes. |
| `;cxgas` | Pre-deploy check. GAS check for GAS projects. |
| `;cxmkpr` | Create Draft PR only. |
| `;cx00` | Context check. |
| `;ahtest` | AutoHotkey test. Expands to `OK`. |

## Design

The hotstrings are intentionally generic.
They tell Codex to read each project's local context files instead of embedding project-specific rules in the AutoHotkey script.
