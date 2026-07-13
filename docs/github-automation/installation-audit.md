# Installation audit CLI

`audit-consumer-installation` は、導入先リポジトリの ChatGPT automation 設定と caller workflow をローカルで監査する read-only CLI です。

このCLIはネットワークアクセス、GitHub API write、自動修正、workflow実行、deploy、mergeを行いません。対象リポジトリroot配下の設定ファイルとcaller workflowだけを読み取り、導入状態が安全側の条件を満たしているかを判定します。

## 目的

- 導入先の `.github/chatgpt-automation.yml` が共通validatorでvalidか確認する
- 導入先の caller workflow が read-only / `workflow_dispatch` only / pinned reusable workflow ref になっているか確認する
- Secret、token、Cookie、環境変数値、絶対path、stack traceを通常出力へ出さずに監査結果を共有する
- JSON出力をCIや別ツールから安定して処理できるようにする

## 使い方

このリポジトリをcheckoutして依存関係を入れます。

```bash
npm ci
```

導入先リポジトリrootを指定して監査します。

```bash
node scripts/audit-consumer-installation.mjs --root ../consumer-repo
```

config pathやcaller workflow pathを変えている場合:

```bash
node scripts/audit-consumer-installation.mjs \
  --root ../consumer-repo \
  --config config/chatgpt-automation.yml \
  --workflow .github/workflows/validate-chatgpt-automation-config.yml
```

JSONで出力する場合:

```bash
node scripts/audit-consumer-installation.mjs --root ../consumer-repo --json
```

期待する reusable workflow ref を40桁commit SHAで固定する場合:

```bash
node scripts/audit-consumer-installation.mjs \
  --root ../consumer-repo \
  --expected-ref 0123456789abcdef0123456789abcdef01234567
```

将来、監査に非致命warningを追加した場合も失敗扱いにする場合:

```bash
node scripts/audit-consumer-installation.mjs --root ../consumer-repo --strict
```

ヘルプ:

```bash
node scripts/audit-consumer-installation.mjs --help
```

`npm run audit:consumer -- --root ../consumer-repo` でも同じCLIを呼び出せます。

## Options

| Option | Default | 説明 |
| --- | --- | --- |
| `--root <path>` | current directory | 監査対象リポジトリroot |
| `--config <path>` | `.github/chatgpt-automation.yml` | root相対のconfig path |
| `--workflow <path>` | `.github/workflows/validate-config.yml` | root相対のcaller workflow path |
| `--expected-ref <sha>` | unset | reusable workflow refが指定SHAと一致することを要求 |
| `--strict` | false | 非致命warningがある場合もaudit failureとして扱う |
| `--json` | false | stable JSON resultを出力 |
| `--help`, `-h` | false | helpを表示 |

`--config` と `--workflow` はroot配下のpathだけを扱います。root外のpathは `*_PATH_INVALID` で失敗します。

## JSON result schema

JSON出力はhuman-readable出力と独立した安定schemaです。

```json
{
  "ok": true,
  "errors": [],
  "warnings": [],
  "checks": [],
  "capabilities": {
    "autoRequest": false,
    "routeReview": false,
    "autoMerge": false,
    "mainFollowup": false,
    "actionsApproval": false
  },
  "files": {
    "config": ".github/chatgpt-automation.yml",
    "workflow": ".github/workflows/validate-config.yml"
  }
}
```

`errors`、`warnings`、`checks` は機械処理用の `code` と短い `message` を持ちます。必要な場合だけroot相対の `file` とYAML pathの `path` を持ちます。

絶対path、Secret値、token値、Cookie値、OAuth値、環境変数値、stack traceは出力しません。監査失敗時の `capabilities` はすべて `false` になります。

## Human-readable output例

```text
ChatGPT automation installation audit: OK
config: .github/chatgpt-automation.yml
workflow: .github/workflows/validate-config.yml
capabilities:
- autoRequest: false
- routeReview: false
- autoMerge: false
- mainFollowup: false
- actionsApproval: false
checks: 18
- [pass] CONFIG_VALID: Config passed the shared fail-closed validator. (.github/chatgpt-automation.yml)
- [pass] WORKFLOW_DISPATCH_ONLY: Workflow trigger is workflow_dispatch only. (.github/workflows/validate-config.yml)
```

## Exit code

| Code | 意味 |
| --- | --- |
| `0` | audit成功、または `--help` |
| `1` | audit失敗 |
| `2` | CLI引数エラー |

## Config監査

config監査は `packages/chatgpt-automation-core/src/config/index.js` の共通validatorを再利用します。重複したschema実装は持ちません。

確認すること:

- config fileを読める
- YAML parseが成功する
- 共通validatorが成功する
- unknown keyを導入監査のerrorとして検出する
- 型不正や安全条件の弱体化をfail closedにする
- `dryRunDefault` が `true`
- 初期導入ではすべてのcapabilityがdisabledであること
- capabilityが1つでもenabledなら `CONFIG_CAPABILITY_ENABLED_FORBIDDEN` で失敗する
- config欠落、読み取り失敗、validation失敗時は全capabilityを `false`

## Caller workflow監査

caller workflowは構造的にYAML parseして確認します。

要求すること:

- workflow fileを読める
- triggerは `workflow_dispatch` のみ
- `pull_request_target`、`push`、`pull_request`、`schedule`、`workflow_run` などを持たない
- workflow / job permissionsは `contents: read` のみ
- jobは `validate-config` 1つだけ
- job-level `uses` で `nozomu-honda/codex-workflow-kit/.github/workflows/validate-config.yml@<40桁SHA>` を呼ぶ
- refは40桁commit SHAのみ
- `--expected-ref` 指定時は完全一致
- `with.config-file` が監査対象config pathと一致
- `with.dry-run` がboolean `true`
- `secrets`、`secrets: inherit`、`runs-on`、`steps`、`run`、`shell` を持たない
- 想定外job、想定外input、workflow outputを持たない

本番監査では `REPLACE_WITH_TAG_OR_40_CHAR_COMMIT_SHA` placeholder、branch、tag、短縮SHAを許可しません。

## Error code一覧

主なCLI / audit固有code:

- `CONFIG_PATH_INVALID`
- `WORKFLOW_PATH_INVALID`
- `CONFIG_MISSING`
- `CONFIG_READ_FAILED`
- `CONFIG_DRY_RUN_DEFAULT_FALSE`
- `CONFIG_CAPABILITY_ENABLED_FORBIDDEN`
- `WORKFLOW_MISSING`
- `WORKFLOW_READ_FAILED`
- `WORKFLOW_YAML_PARSE_ERROR`
- `WORKFLOW_ROOT_OBJECT_REQUIRED`
- `WORKFLOW_ROOT_KEY_UNEXPECTED`
- `WORKFLOW_OUTPUT_UNEXPECTED`
- `WORKFLOW_TRIGGER_INVALID`
- `WORKFLOW_DISPATCH_INPUTS_UNEXPECTED`
- `WORKFLOW_TRIGGER_UNEXPECTED`
- `PULL_REQUEST_TARGET_FORBIDDEN`
- `WORKFLOW_PERMISSIONS_INVALID`
- `JOBS_OBJECT_REQUIRED`
- `UNEXPECTED_JOB`
- `JOB_OBJECT_REQUIRED`
- `JOB_PERMISSIONS_INVALID`
- `REUSABLE_WORKFLOW_USES_REQUIRED`
- `REUSABLE_WORKFLOW_USES_INVALID`
- `REUSABLE_WORKFLOW_REPOSITORY_MISMATCH`
- `REUSABLE_WORKFLOW_PATH_MISMATCH`
- `REUSABLE_WORKFLOW_REF_PLACEHOLDER`
- `REUSABLE_WORKFLOW_REF_SHORT_SHA`
- `REUSABLE_WORKFLOW_REF_TAG`
- `REUSABLE_WORKFLOW_REF_MUTABLE`
- `REUSABLE_WORKFLOW_REF_MISMATCH`
- `WORKFLOW_WITH_REQUIRED`
- `WORKFLOW_CONFIG_FILE_MISMATCH`
- `WORKFLOW_DRY_RUN_NOT_TRUE`
- `WORKFLOW_INPUT_UNEXPECTED`
- `WORKFLOW_SECRETS_FORBIDDEN`
- `WORKFLOW_SECRETS_INHERIT_FORBIDDEN`
- `WORKFLOW_RUNS_ON_FORBIDDEN`
- `WORKFLOW_STEPS_FORBIDDEN`
- `WORKFLOW_INLINE_RUN_FORBIDDEN`
- `WORKFLOW_SHELL_FORBIDDEN`
- `WORKFLOW_JOB_KEY_UNEXPECTED`
- `EXPECTED_REF_INVALID`
- `STRICT_WARNINGS_FOUND`

config validator由来のcodeもそのまま出ます。代表例:

- `YAML_PARSE_ERROR`
- `ROOT_OBJECT_REQUIRED`
- `UNSUPPORTED_VERSION`
- `INVALID_BASE_BRANCH`
- `INVALID_CI_WORKFLOW_NAME`
- `BOOLEAN_REQUIRED`
- `UNKNOWN_KEY`
- `FENCED_MARKER_IGNORE_REQUIRED`
- `REVIEW_REQUEST_EXCLUSION_REQUIRED`
- `LATEST_CHANGES_REQUESTED_REQUIRED`
- `SECRET_HARD_BLOCK_REQUIRED`
- `SECRET_HARD_BLOCK_DOWNGRADE_FORBIDDEN`

## CI組み込み例

導入先リポジトリをcheckout済みのCIで、このリポジトリも隣にcheckoutして実行します。

```yaml
jobs:
  audit-chatgpt-automation:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          path: consumer
      - uses: actions/checkout@v4
        with:
          repository: nozomu-honda/codex-workflow-kit
          ref: 0123456789abcdef0123456789abcdef01234567
          path: kit
      - run: npm ci
        working-directory: kit
      - run: node scripts/audit-consumer-installation.mjs --root ../consumer --expected-ref 0123456789abcdef0123456789abcdef01234567 --json
        working-directory: kit
```

## expected ref更新手順

1. `codex-workflow-kit` 側で対象commitのCIが成功していることを確認する。
2. 対象commit SHAが40桁であることを確認する。
3. 導入先caller workflowの reusable workflow ref をそのSHAへ更新する。
4. CIやローカルで `--expected-ref <sha>` を指定して監査する。
5. 初回は `workflow_dispatch` のdry-runで確認する。

## Template dogfood

`templates/workflows/validate-config.yml` は導入時にplaceholderを置換するテンプレートです。本番監査ではplaceholderを許可しません。

テンプレート自体のdogfoodは、placeholderを一時fixture内で40桁SHAへ置換して行います。

```bash
npm run audit:template
```

## Troubleshooting

- `CONFIG_MISSING`: `--root` と `--config` の組み合わせを確認する。
- `WORKFLOW_MISSING`: caller workflowのコピー先pathを確認する。
- `UNKNOWN_KEY`: typoまたは未審査の設定が混入しているため、config keyを削除するか別Issueでschema/validatorを拡張する。
- `CONFIG_CAPABILITY_ENABLED_FORBIDDEN`: 初期導入監査では全capabilityを無効化する。自動化を有効にする場合は別Issueで安全条件と運用手順を確認する。
- `REUSABLE_WORKFLOW_REF_PLACEHOLDER`: `REPLACE_WITH_TAG_OR_40_CHAR_COMMIT_SHA` を40桁commit SHAへ置換する。
- `REUSABLE_WORKFLOW_REF_TAG`: tag参照ではなく40桁commit SHAを使う。
- `WORKFLOW_CONFIG_FILE_MISMATCH`: caller workflowの `with.config-file` とCLIの `--config` を一致させる。
- `WORKFLOW_DRY_RUN_NOT_TRUE`: 初回導入caller workflowは `dry-run: true` に戻す。

## このCLIが行わないこと

- GitHub API write
- GitHub API read
- 自動修正
- Secret取得
- repository variables / secrets の値取得
- workflow実行
- deploy
- release tag作成
- merge
