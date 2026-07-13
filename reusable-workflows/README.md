# reusable-workflows

`workflow_call` に対応した共通workflowを置く予定の領域です。

導入先リポジトリでは、`issue_comment`、`pull_request_review`、`workflow_run`、`pull_request.closed`、`push` などのイベントを薄いcaller workflowで受け、必要に応じてここに置くreusable workflowを呼び出す想定です。

このIssueでは、reusable workflow本体はまだ追加しません。
