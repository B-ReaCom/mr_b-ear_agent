# LINE WORKS リード自動通知 セットアップ手順

このドキュメントは、Mr. B-EAR アプリのリード自動通知機能（LINE WORKS Bot 経由）を有効化するための手順書です。

> 概要：Mr. B-EAR で AI と顧客が会話 → サーバー側でリード判定（高優先度のみ）→ 該当時に LINE WORKS のトークルームへ自動通知します。通知失敗時は顧客の応答体験には影響しません（ログのみ）。

---

## 前提条件

LINE WORKS Developer Console で以下を完了済みであること：

- [x] Bot 作成（例：Bot ID `12271017`）
- [x] ClientApp 作成（Client ID / Client Secret 取得）
- [x] Service Account 発行
- [x] Service Account 用の Private Key（`.key` ファイル）ダウンロード

> Developer Console: <https://developers.worksmobile.com/>

---

## Step 1: 管理者画面で Bot を公開

1. LINE WORKS 管理者画面にログイン
   - URL: <https://admin.worksmobile.com/>
2. メニュー「サービス」→「Bot」を選択
3. 作成した「Mr. B-EAR リード通知」Bot を選択
4. 「公開設定」→ 「**全社員に公開**」または「**特定の組織に公開**」を選択
5. 「**保存**」をクリック

> Bot を公開していないと、トークルームに招待できません。

---

## Step 2: 通知用トークルームを作成

1. LINE WORKS アプリ（モバイル / PC / ブラウザ）を開く
2. トーク一覧画面の「**+**」ボタン → 「**グループ作成**」
3. グループ名：**営業リード通知** （推奨）
4. メンバーを招待（営業チームの担当者）
5. 「作成」をタップ

---

## Step 3: Bot をトークルームに招待

1. 作成したトークルームを開く
2. 右上のメニュー → 「**メンバー**」または「**設定**」→ 「**メンバー追加**」
3. 検索ボックスに「**Mr. B-EAR リード通知**」と入力
4. 候補から Bot を選択 → 「**追加**」

招待した時点で Bot がトークルーム内に参加し、メッセージ送信ができる状態になります。

---

## Step 4: チャンネル ID（Channel ID）を取得

LINE WORKS のトークルーム（Bot 用）には固有の Channel ID が割り当てられます。これを Vercel の環境変数として登録する必要があります。

### 取得方法 A：Bot 受信 Webhook 経由（推奨）

Bot をトークルームに招待した直後、Bot は招待イベント（`join`）を受信します。Bot の Callback URL を一時的に <https://webhook.site/> などに設定しておけば、イベントペイロードに `channel.channelId` が含まれます。

### 取得方法 B：LINE WORKS Developer API で問い合わせ

サービスアカウントの Access Token を取得後、`GET https://www.worksapis.com/v1.0/bots/{botId}/channels` を呼ぶと、その Bot が参加しているトークルーム一覧と Channel ID が取得できます。

### 取得方法 C：Developer Console から確認

Developer Console → Bot 詳細 → 「**テスト送信**」セクションで宛先トークルームを選択する画面に Channel ID が表示される場合があります（環境により異なります）。

> 具体的な UI は LINE WORKS の管理者ヘルプ <https://guide.worksmobile.com/> を参照してください。

---

## Step 5: Vercel に環境変数を登録

1. <https://vercel.com/> にログイン
2. プロジェクト「**mr-b-ear-agent**」を選択
3. 「**Settings**」→ 「**Environment Variables**」
4. 以下のキーをすべて追加（**Production / Preview / Development** の3つすべてにチェック）：

| キー | 値の例 |
|---|---|
| `LINE_WORKS_CLIENT_ID` | `42qYp97fiDqaZKw3HJuA` |
| `LINE_WORKS_CLIENT_SECRET` | Developer Console の Client Secret |
| `LINE_WORKS_SERVICE_ACCOUNT` | `5e3le.serviceaccount@bearidge55` |
| `LINE_WORKS_PRIVATE_KEY` | `.key` ファイルの中身全文（後述） |
| `LINE_WORKS_BOT_ID` | `12271017` |
| `LINE_WORKS_DOMAIN_ID` | `400393035` |
| `LINE_WORKS_CHANNEL_ID` | Step 4 で取得した Channel ID |

### Private Key の登録方法（重要）

`.key` ファイルをテキストエディタ（VS Code / メモ帳など）で開き、以下のような形式の **全文をそのままコピー** します：

```
-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ...
... (複数行) ...
-----END PRIVATE KEY-----
```

この内容を **そのまま** Vercel の `LINE_WORKS_PRIVATE_KEY` の値として貼り付けてください。

- 改行はそのままでOK（Vercel の入力欄は複数行に対応）
- もし1行で貼り付ける必要がある場合は、改行を `\n` というリテラル文字列に置換してください（サーバー側で自動的にデコードされます）

---

## Step 6: Vercel 再デプロイ

環境変数の追加後、Vercel が自動的に再デプロイします。もし自動デプロイが走らない場合は：

- 「**Deployments**」タブ → 最新デプロイの「**…**」メニュー → 「**Redeploy**」

---

## Step 7: 動作テスト

1. <https://mr-b-ear-agent.vercel.app/> にアクセス
2. 以下のようなテストメッセージを入力（スコア 8 以上になる組み合わせ）：

   ```
   X10 を 30人分検討しています。見積お願いします。
   電話番号は 03-1234-5678 です。
   ```

   このメッセージの想定スコア：
   - 「見積」キーワード：+3
   - 数字+単位「30人」：+2
   - 電話番号「03-1234-5678」：+5
   - 合計：**10 点 → 通知発火**

3. AI 応答を待つ（数秒）
4. LINE WORKS の「営業リード通知」トークルームに通知が来るか確認

---

## トラブルシューティング

### 通知が来ない場合

1. Vercel ダッシュボード → 「**Functions**」 → 「**Logs**」を確認
2. `[lineworks-notify]` または `[chat.js] lineworks notify` で始まるエラーを検索
3. よくあるエラーと対処法：

| エラーメッセージ | 原因 | 対処 |
|---|---|---|
| `Missing env vars: [...]` | 環境変数未設定 | Step 5 で全項目を Vercel に登録 |
| `LINE_WORKS_PRIVATE_KEY is not a valid PEM` | Private Key の形式不正 | `-----BEGIN PRIVATE KEY-----` から `-----END PRIVATE KEY-----` まで全文を貼り直す |
| `Token request failed: 401` | Service Account / Private Key / Client ID/Secret の不一致 | Developer Console で再確認 |
| `Message send failed: 403` | Bot がトークルームに招待されていない、または Channel ID 不一致 | Step 3 / Step 4 を再実施 |
| `Message send failed: 404` | Bot ID または Channel ID が間違っている | 値を再確認 |
| `forbidden_origin` | Origin 検証で弾かれた | 通常は社内 fetch では発生しない。直接叩きをしていないか確認 |

### スコア閾値の調整

通知頻度を変えたい場合は、`api/chat.js` の `detectLead` 関数の戻り値:

```js
isHighPriority: score >= 8,
```

の `8` を変更します：

- 閾値を **下げる**（例：5）→ より多くの会話が通知対象になる
- 閾値を **上げる**（例：12）→ 緊急度の高いリードのみに絞り込む

### キーワードの追加・削除

`api/chat.js` の `highPriorityKeywords` 配列を編集してください。`detectedInfo` の項目（メアド / 電話 / 会社名 / 数字単位）は別途正規表現で判定しています。

---

## セキュリティ注意事項

- `LINE_WORKS_PRIVATE_KEY` は**絶対に Git にコミットしない**こと
- ローカル開発で `.env.local` を作る場合は `.gitignore` に追加する
- Slack / メール / Notion などで Private Key を平文共有しないこと
- 顧客の個人情報（メアド・電話番号）は LINE WORKS トークルームと Vercel のメモリ内でのみ扱われ、サーバーログには出力しません（メッセージ本文はログ対象外）
- Bot を退会させたい場合：管理者画面 → Bot → 「公開停止」または、トークルームから Bot を除外

---

## 仕組み（参考）

```
┌─────────────────────────┐
│  顧客（mr-b-ear-agent）  │
└──────────┬──────────────┘
           │ POST /api/chat
           ▼
┌─────────────────────────┐
│   api/chat.js           │
│  (Edge Runtime)         │
│   ├ Anthropic API 呼出  │
│   ├ レスポンス返却       │
│   └ detectLead()        │ ← スコア >=8 のときのみ
└──────────┬──────────────┘
           │ POST /api/lineworks-notify
           │ （fire-and-forget）
           ▼
┌─────────────────────────┐
│ api/lineworks-notify.js │
│  (Node.js Runtime)      │
│   ├ JWT 署名 (RS256)    │
│   ├ Access Token 取得   │
│   └ Bot メッセージ送信  │
└──────────┬──────────────┘
           │
           ▼
┌─────────────────────────┐
│  LINE WORKS トークルーム │
└─────────────────────────┘
```

- **Edge Runtime**：chat.js は応答ストリーミングが速い Edge で動かす
- **Node.js Runtime**：lineworks-notify.js は JWT 署名（RSA-SHA256）に Node.js の `crypto` モジュールが必要なため別 Runtime
- **Fire-and-forget**：chat.js から lineworks-notify を呼ぶ際は結果を待たず、通知失敗が顧客の応答遅延につながらないようにしています

---

## 関連ファイル

- `api/chat.js` — リード判定ロジック（`detectLead` / `formatLeadMessage`）を含む
- `api/lineworks-notify.js` — LINE WORKS Bot 通知用エンドポイント（Node.js Runtime）
- `docs/LINEWORKS_SETUP.md` — 本ファイル
