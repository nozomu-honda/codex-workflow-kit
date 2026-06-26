# Security

## Do not store secrets

Do not commit:

- API keys
- OAuth tokens
- cookies
- real production IDs
- real production URLs
- private deployment URLs

## Use project-local secret management

Put real values in:

- GitHub Secrets
- local environment variables
- private configuration files excluded by `.gitignore`
- each platform's secret store

## Pull request safety

Do not use `pull_request_target` casually.
Do not pass secrets to fork or external pull requests.

## Production operations

This kit is for Codex prompt and shortcut operations.
It should not directly automate production deployment or production data changes.
