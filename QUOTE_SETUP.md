# ミッドランドハーツ 自動見積もりシステム セットアップ

## ファイル構成

| ファイル | 役割 |
|---|---|
| `quote.html` | お客様向けフォーム（2コース選択UI） |
| `api/quote.js` | Vercel Edge Function（Origin/レート制限、GASへ転送） |
| `GAS_USAGE_MONITORING.gs` | GAS（メール送信＋ログ記録、`handleQuoteRequest` を追加） |

公開URL: `https://mr-b-ear-agent.vercel.app/quote.html`

---

## ユーザー側で必要な作業

### 1. 価格表を実データに差し替える【必須】

`quote.html` の以下のブロックを編集:

```js
// ▼▼▼ ここを実際の価格表で置き換えてください ▼▼▼
const PRODUCTS = [
  {
    category: '本体（ヒアリングシステム）',
    items: [
      { sku: 'MH-001', name: '[ダミー] スタンダードモデル A', unitPrice: 98000, unit: '台' },
      ...
    ]
  },
  ...
];
// ▲▲▲ ここまでが価格表 ▲▲▲
```

- `sku`: 製品コード
- `name`: 製品名
- `unitPrice`: 単価（円・税抜）
- `unit`: 単位（台 / 個 / 式 など）

### 2. 見積もり通知メール先を設定【必須】

`GAS_USAGE_MONITORING.gs` の以下を編集:

```js
const QUOTE_EMAIL_TO = 'example@midland-hearts.example'; // ← 実際のアドレス
const QUOTE_EMAIL_CC = ''; // 必要ならカンマ区切りで
```

### 3. GAS を再デプロイ

1. https://script.google.com で既存のスクリプトを開く
2. `GAS_USAGE_MONITORING.gs` の内容で置き換え、保存
3. 右上「デプロイ」→「デプロイを管理」→ 既存デプロイの編集
4. バージョン: 「新しいバージョン」を選択
5. デプロイ
   - URL は変わらないので、`api/quote.js` の `GAS_WEBHOOK_URL` は変更不要

### 4. Vercel へデプロイ

```bash
git push origin claude/auto-quote-app-rpuYW
```

→ Vercel が自動的にプレビューデプロイを作成。
   本番反映するなら main にマージするか、Vercel管理画面で本番昇格。

### 5. 動作確認

1. `https://mr-b-ear-agent.vercel.app/quote.html` を開く
2. 「クイック見積もり」で送信テスト
3. 通知先メールアドレスに見積もり依頼メールが届くことを確認
4. スプレッドシートに `QUOTE_LOG` シートが作成されたことを確認

---

## 仕様

### 2コース

- **クイック見積もり**: 連絡先＋製品選択＋備考のみ（最短1分）
- **詳しく相談**: 上記＋6W4H（利用シーン）情報

### セキュリティ

- Origin 制限: `mr-b-ear-agent.vercel.app` および `*.bearidge.com`、localhost のみ受付
- レート制限: 1分3件 / 1時間10件 / 1日30件（IP単位）
- 入力サニタイズ: サーバー側でも文字列長制限・型チェック

### GAS への送信ペイロード（`type: 'quote_request'`）

```json
{
  "type": "quote_request",
  "mode": "quick" | "detailed",
  "customer": { "name", "company", "department", "email", "phone" },
  "items": [ { "sku", "name", "unitPrice", "quantity" } ],
  "situation": { "who", "whom", "what", "when", "where", "why", "how", "howMany", "howMuch", "howLong" },
  "notes": "備考",
  "subtotal": 0,
  "ip": "...",
  "timestamp": "ISO8601"
}
```

---

## 将来の独立化（案B）

このアプリを別Vercelプロジェクトに移送したい場合:

1. 新リポジトリを作成
2. `quote.html` → `index.html` にリネームしてコピー
3. `api/quote.js` をコピー
4. `vercel.json` をコピー
5. Vercel で新プロジェクト作成、`ALLOWED_ORIGIN_PATTERNS` を新URL用に更新
