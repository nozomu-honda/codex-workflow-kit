#Requires AutoHotkey v2.0
#SingleInstance Force

; Cross-project Codex prompt hotstrings for AutoHotkey v2.
; Keep project-specific rules in each repository's AGENTS.md / CLAUDE.md / docs.
; Do not put secrets, tokens, real IDs, or URLs in this file.

::;ahtest::OK

SendCodexText(text) {
  SendText text
}

CommonHeader() {
  return "まずこのリポジトリの前提を確認してください。`n`n読むもの候補:`n- AGENTS.md`n- CLAUDE.md`n- docs/current-status.md`n- docs/TODO.md`n- 関連する仕様ドキュメント`n`n共通制約:`n- main / develop へ直接コミットしない`n- 勝手にReady for review化しない`n- 勝手にマージしない`n- Secret、トークン、OAuth情報、Cookie、実URL、実IDをコミットしない`n- 本番環境や本番データに触らない`n- 仕様変更、DBスキーマ変更、出力列変更、破壊的変更が必要なら止まって確認する`n"
}

::;cx00::SendCodexText(CommonHeader() . "`nこのプロジェクトの現在の状態、未解決課題、次にやるべきことを整理してください。まだコード変更はしないでください。")

::;cxgo::SendCodexText(CommonHeader() . "`n以下のタスクを、調査・実装・関連テスト・必要ドキュメント更新・コミット・Draft PR作成まで進めてください。`n`nタスク: {{タスク}}`nゴール: {{ゴール}}`n対象ファイル候補: {{対象ファイル候補}}`n`n止まる条件:`n- 複数PRに分けるべき大きさになった`n- 既存仕様と矛盾する可能性がある`n- Secretや認証情報が必要`n- 本番環境操作が必要`n`n完了時の報告:`n- 変更ファイル`n- 変更概要`n- 実行したテスト`n- 未確認事項`n- リスク`n- Draft PR URL")

::;cxfast::SendCodexText(CommonHeader() . "`n以下のタスクを、調査・実装・関連テスト・必要ドキュメント更新・コミット・Draft PR作成まで進めてください。`n`nタスク: {{タスク}}`nゴール: {{ゴール}}`n対象ファイル候補: {{対象ファイル候補}}`n`n止まる条件:`n- 複数PRに分けるべき大きさになった`n- 既存仕様と矛盾する可能性がある`n- Secretや認証情報が必要`n- 本番環境操作が必要`n`n完了時の報告:`n- 変更ファイル`n- 変更概要`n- 実行したテスト`n- 未確認事項`n- リスク`n- Draft PR URL")

::;cxq::SendCodexText(CommonHeader() . "`n以下の目的で調査だけしてください。まだコード変更はしないでください。`n`n目的: {{目的}}`n対象ファイル候補: {{対象ファイル候補}}`n`n出力:`n1. 結論`n2. 根拠`n3. 影響範囲`n4. 最小修正案`n5. 実装する場合の対象ファイル`n6. 実行すべきテスト`n7. Draft PRまで進める場合の手順")

::;cxpr::SendCodexText(CommonHeader() . "`nPR #{{PR番号}} をレビューしてください。まだコード変更はしないでください。`n`n重点:`n- 既存仕様との矛盾`n- テスト不足`n- CIがfalse positiveになっていないか`n- Secret、実ID、実URLの混入`n- マージ前の手動確認`n`n出力:`n1. マージしてよいかの暫定判断`n2. ブロッカー`n3. できれば直したい点`n4. 問題なさそうな点`n5. 次に依頼すべき最小タスク")

::;cxgas::SendCodexText(CommonHeader() . "`nデプロイ前チェックをしてください。まだコード変更はしないでください。`n`nGASプロジェクトの場合は以下も確認してください:`n- appsscript.json の oauthScopes`n- GAS / V8 構文`n- google.script.run の呼び出し名`n- DB_CONFIG の実値混入`n- DriveAppの権限・実行ユーザー`n- runSmokeTests / runAllTests`n`nGAS以外のプロジェクトでは、そのプロジェクトのデプロイ/CI前チェックとして読み替えてください。")

::;cxmkpr::SendCodexText(CommonHeader() . "`n現在の作業ブランチから、既定のbaseブランチ向けにDraft PRを作成してください。`n`nPR作成前に確認:`n- 未コミット差分が残っていないか`n- 目的どおりの差分か`n- 実行すべきテストが完了しているか`n- 未確認事項がPR本文に明記されているか`n- Secret、実ID、実URLが混ざっていないか`n`nPR作成後:`n- PR URL`n- base / head`n- 確認済みテスト`n- 未確認事項`nを報告してください。まだReady化・マージはしないでください。")
