# Onecomment-Plugin-for-X-Instagram

`X-Chrome-Plugin-for-Onecomment`（X Live用）および `Instagram-Chrome-Plugin-for-Onecomment`（Instagram Live用）から送信されたコメントを受信し、わんコメ（OneComme）の **X用枠 / Instagram用枠** に振り分けて投入するわんコメプラグインです。

外部npmパッケージへの依存はなく、フォルダをコピーするだけで動作します。

## インストール手順（Windows）

1. この `Onecomment-Plugin-for-X-Instagram` フォルダを丸ごと、わんコメのプラグインディレクトリにコピーします。
   ```text
   %APPDATA%\onecomme\plugins\Onecomment-Plugin-for-X-Instagram\
   ```
   ※ 通常は `C:\Users\<ユーザー名>\AppData\Roaming\onecomme\plugins\Onecomment-Plugin-for-X-Instagram\` です。
2. わんコメを起動し、右上のメニューから **「プラグイン」** ウィンドウを開きます。
3. **「再読み込み」** ボタンを押し、**「X & Instagram Live コメント連携プラグイン」** を **有効（ON）** にします。
4. 起動するとローカルブリッジサーバー（デフォルト `http://127.0.0.1:11185`）が自動的に待ち受けを開始します。

## わんコメの枠構成（X用 / Instagram用の自動分離）

- X Live からのコメント → デフォルト枠名 `X Live コメント`
- Instagram Live からのコメント → デフォルト枠名 `Instagram Live コメント`

初回コメント受信時、該当する枠がわんコメ上に存在しない場合は自動で枠を作成します。既存の枠を使いたい場合は、各Chrome拡張機能の詳細設定画面から枠を選択してください。

## 動作確認（疎通チェック）

ブラウザまたはターミナルで以下へアクセスして `status: "ok"` が返れば正常稼働しています。

```bash
curl http://127.0.0.1:11185/health
```

## 主なAPIエンドポイント

- `GET /health` : 稼働状況・わんコメ疎通確認・枠マッピング情報
- `GET /services` : わんコメの枠一覧を取得
- `GET /config` : 現在の設定を取得
- `POST /config` : ポート番号・枠ID・共有トークン・システム通知除外等の設定を更新
- `POST /comments` : Chrome拡張機能からのコメントを受信しわんコメへ投入

## フォルダ構成

```text
Onecomment-Plugin-for-X-Instagram/
├─ plugin.js              # わんコメプラグイン本体
├─ lib/
│  ├─ config.js           # デフォルト設定・バリデーション
│  ├─ normalizer.js       # 正規化・サニタイズ・重複排除キャッシュ
│  ├─ onecommeClient.js   # わんコメAPI (/api/services, /api/comments) クライアント
│  └─ server.js           # ローカル専用HTTPブリッジサーバー (127.0.0.1:11185)
└─ README.md
```
