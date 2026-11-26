# X-Chrome-Plugin-for-Onecomment

X Live（配信チャット）のコメントをリアルタイムに取得し、`Onecomment-Plugin-for-X-Instagram` 経由でわんコメ（OneComme）の **X用枠（`X Live コメント`）** へ送信する Chrome 拡張機能（Manifest V3）です。

## 前提条件

- わんコメに `Onecomment-Plugin-for-X-Instagram` がインストール・有効化されていること。

## インストール手順（Google Chrome）

1. Chrome のアドレスバーに `chrome://extensions/` と入力して開きます。
2. 画面右上の **「デベロッパー モード」** を ON にします。
3. **「パッケージ化されていない拡張機能を読み込む」** をクリックし、この `X-Chrome-Plugin-for-Onecomment` フォルダを選択します。
4. ツールバーにピン留めして拡張アイコンを開き、プラグイン接続が **「接続OK」** になっていることを確認します。

## 使い方

1. Chrome で X Live（配信チャットが表示されているページ、例: `https://x.com/i/broadcasts/...`）を開きます。
2. 拡張機能のポップアップを開き、スイッチが ON・現在のタブが **「チャット監視中」** であることを確認します。
3. 新規に投稿されたチャットが自動的にわんコメの `X Live コメント` 枠へ反映されます。
4. X の仕様変更でコメントが取得できなくなった場合は、**「詳細設定」** 画面の「カスタムCSSセレクタ」からセレクタを上書きできます。
