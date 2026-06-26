# AGENTS.md

このリポジトリでCodexに作業させるときの前提ルールを書くファイルです。

## 作業開始時に読むもの

- `AGENTS.md`
- `docs/current-status.md`
- `docs/TODO.md`
- 関連する仕様ドキュメント

## ブランチ/PR運用

- main / develop へ直接コミットしない。
- 作業ごとにfeature/docs/fix系のブランチを切る。
- 明確な作業依頼では、調査・実装・テスト・必要ドキュメント更新・コミット・Draft PR作成まで進めてよい。
- Ready for review化、マージ、本番反映はユーザーの明示指示があるまでしない。

## セキュリティ

- Secret、トークン、OAuth情報、Cookie、実URL、実IDをコミットしない。
- 本番環境や本番データに触る必要がある場合は止まって確認する。

## 完了報告

- 変更ファイル
- 変更概要
- 実行したテスト
- 未確認事項
- リスク
- Draft PR URL
