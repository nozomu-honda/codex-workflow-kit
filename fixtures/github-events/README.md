# GitHub event fixtures

Issue #29 では、Issue #24〜#26 の review routing、auto merge、main follow-up で共通利用する GitHub event payload fixture を追加します。

このfixtureは完全offlineで動き、GitHub API、Secret、実repository、実URL、実メール、実SHAを使いません。

## 配置

```text
fixtures/github-events/
  index.js
  README.md
  snapshots/github-events.snapshot.json
  test/github-events.test.js
```

## 命名規則

- event builder: `build<Event>Payload`
- scenario helper: 状態が分かる短い名前にする
- invalid fixture: `invalidPayloadFixture(eventName, reason)`
- malformed fixture: `MALFORMED_EVENT_PAYLOADS`

例:

```js
import {
  sameRepoReview,
  forkReview,
  mergedPr,
  failedWorkflowRun,
  pushDefaultBranch
} from './fixtures/github-events/index.js';
```

## builder追加方法

1. `index.js` にevent builderまたはscenario helperを追加する。
2. `validateGithubEventPayload()` の最低限schemaに必要なpathを追加する。
3. `test/github-events.test.js` にdeterministic生成、invalid、snapshot、禁止値確認を追加する。
4. 安定した要約が必要な場合は `snapshots/github-events.snapshot.json` に追加する。

body全文や実URLをsnapshotへ入れず、後続ロジックが必要とする安全なメタ情報だけを固定します。

## fixture専用値

- repository: `owner/example-repo`
- fork repository: `fork-owner/example-repo`
- external repository: `external-owner/external-repo`
- URL: `https://example.invalid/...`
- SHA: `0000000000000000000000000000000000000001` など固定ダミー値
- actor: `fixture-user`, `unknown-actor`, `github-actions[bot]`, `chatgpt-review-bot`

実repository、実URL、実メール、実SHA、Secret-like値を追加しないでください。
