# Vercel セットアップ手順（Mr. B-EAR 全製品対応版）

## 必須設定

### 1. Vercel ダッシュボードで環境変数を設定

1. https://vercel.com にログイン
2. プロジェクト「mr_b-ear_agent」を開く
3. **Settings** タブをクリック
4. 左メニューから **Environment Variables** を選択
5. 以下の環境変数を追加：

| Name | Value | Environment |
|------|-------|-------------|
| `ANTHROPIC_API_KEY` | （Anthropic Console で取得したAPIキー） | Production, Preview, Development |

6. **Save** をクリック

### 2. 設定後、再デプロイ

環境変数を追加した後、Vercel ダッシュボードで：
- **Deployments** タブ → 最新のデプロイメントの「⋯」メニュー → **Redeploy**

または、Git に何か変更をプッシュすれば自動的に再デプロイされます。

---

## 動作確認

### 確認1：API エンドポイントの応答

ブラウザの開発者ツール（F12）→ Network タブを開きながら質問を送信。

- ✅ `/api/chat` へのリクエストが Status 200 で成功
- ❌ Status 500 で `server_not_configured` エラー → 環境変数未設定

### 確認2：レート制限の動作

質問を短時間に連続送信して、以下のメッセージが出ることを確認：
- 5回以上：「1分間のリクエスト上限に達しました」
- 50回以上：「1時間のリクエスト上限に達しました」
- 200回以上：「本日のリクエスト上限に達しました」

---

## レート制限の設定

`api/chat.js` で以下を変更可能：

```javascript
const RATE_LIMITS = {
  perMinute: 5,      // 1分間に5リクエストまで
  perHour: 50,       // 1時間に50リクエストまで
  perDay: 200,       // 1日に200リクエストまで
};
```

変更後は Git にプッシュすれば自動デプロイ。

---

## オプション：Vercel KV による永続的レート制限

現在の実装は **インメモリ・レート制限** のため、Edge Function インスタンスが切り替わると制限がリセットされます。

本格運用には **Vercel KV**（Redis互換）の利用を推奨。設定方法は別途ご案内します。

---

## Anthropic Console での予算上限設定

最終的な保険として：

1. https://console.anthropic.com にログイン
2. **Settings** → **Billing**
3. **Usage limits** で月次予算上限を設定（例：$200）

予算超過時は API が自動的に停止し、過剰な請求を防げます。

---

## トラブルシューティング

### `/api/chat` が 404 になる
→ Vercel が Edge Function を認識していない可能性。
→ プロジェクトの **Functions** タブで関数が表示されているか確認。
→ 表示されていなければ「再デプロイ」を実行。

### 「ANTHROPIC_API_KEY が設定されていません」エラー
→ 環境変数を保存後、必ず **Redeploy** が必要。

### サーバー側ではなく直接API呼び出しに戻したい
→ `index.html` の `USE_SERVER_PROXY = true` を `false` に変更してプッシュ。
