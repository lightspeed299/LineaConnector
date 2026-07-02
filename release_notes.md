## v5.1.2 Icon Background Fix

- **Fix: Linea Connector のアプリアイコン背景を修正**
  - 現行 Linea の青いロゴを黒背景つきで切り出し直し
  - Windows のアプリ本体、タスクバー、デスクトップ/スタートメニューショートカット、インストーラー/アンインストーラー用 ICO を再生成
  - 透明背景になっていた v5.1.1 のアイコンを、Linea 本体のアプリアイコンと同じ黒背景系の見た目へ修正

## v5.1.1 Icon Refresh

- **Update: Linea Connector のアプリアイコンを更新**
  - Windows のアプリ本体、タスクバー、デスクトップ/スタートメニューショートカット、インストーラー/アンインストーラーで使うアイコンを現行 Linea の青いロゴへ更新
  - 小さい Windows アイコンサイズでも読みやすいよう、ワードマークを外したロゴ本体の ICO を同梱

## v5.1.0 Automatic Idle Updates

- **Update: 自動ダウンロードとアイドル時の自動適用**
  - 更新が見つかった場合は自動でダウンロード
  - ダウンロード完了後、30分間リクエストや設定変更がなければ自動で再起動して適用
  - 解析中またはエンジン設定変更中は自動適用を延期
  - すぐ適用したい場合の「今すぐ再起動」操作は維持

## v5.0.0 Linea Connector

- **Release: Linea Connector として再リリース**
  - アプリ表示版、更新メタデータ、GitHub release を `v5.0.0` に更新
  - 新規セットアップ時の接続先は `https://api.lineashogi.com`
  - 自動アップデート先は `lightspeed299/LineaConnector`
- **Migration: 既存設定の自動移行を維持**
  - 保存済みの旧 API URL は起動時に Linea API へ更新
  - 旧設定フォルダが残っている場合は、現在の設定フォルダへコピーして整理
  - Windows 上の同一アプリ更新を保つため、内部 appId は legacy 値を維持
