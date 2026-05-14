# Google Apps Script セットアップ手順

## 目的：月¥20,000超過時に sales@bearidge.jp へメール通知

---

## セットアップ手順

### 1. 既存の Google Apps Script を開く

1. https://script.google.com にアクセス
2. 既存の Mr. B-EAR スクリプト（QAログ用）を開く
3. 既存のスクリプト URL：`https://script.google.com/macros/s/AKfycbz0Jm2Fc.../exec`

### 2. コードを置き換える

1. 既存の `Code.gs`（または既存のファイル）の内容を、**`GAS_USAGE_MONITORING.gs` の内容で完全に置き換え**
2. 既存のQAログ機能も含まれているので、これだけでOK
3. **保存**（Ctrl+S）

### 3. ウェブアプリとして再デプロイ

1. 右上の **デプロイ** → **デプロイを管理**
2. 既存のデプロイメントの右側 **編集**（鉛筆アイコン）
3. **バージョン** を「新しいバージョン」に変更
4. **アクセスできるユーザー** を「全員」に設定（既にそうなっているはず）
5. **デプロイ** をクリック

※ URL は変わらないので、`api/chat.js` の `USAGE_LOG_URL` を更新する必要はありません

### 4. 権限の許可

初回デプロイ時、以下の権限を承認する必要があります：
- スプレッドシートへのアクセス
- メール送信（GmailApp / MailApp）

「権限を確認」→ Googleアカウント選択 → 「許可」

---

## 動作確認

### 1. テスト用のログ送信
スクリプトエディタで以下を実行：

```javascript
function testUsageLog() {
  handleUsageLog({
    type: 'api_usage',
    ip: '192.0.2.1',
    model: 'claude-sonnet-4-6',
    usage: {
      input_tokens: 100,
      cache_creation_input_tokens: 7000,
      cache_read_input_tokens: 0,
      output_tokens: 200
    },
    cost_usd: 0.05,
    timestamp: new Date().toISOString()
  });
}
```

実行後、スプレッドシートに `USAGE_LOG` シートが作成され、データが記録されることを確認。

### 2. 月次合計の確認
```javascript
function showCurrentMonthlyTotal()
```
を実行 → 実行ログで今月の合計を確認。

### 3. アラートメール送信テスト

閾値を一時的に低く設定してテスト：

```javascript
// 一時的に閾値を変更（テスト後は元に戻す）
const ALERT_THRESHOLD_JPY = 1; // 1円で発火
```

→ `testUsageLog()` を実行
→ sales@bearidge.jp にメールが届くことを確認

テスト後、`ALERT_THRESHOLD_JPY = 20000` に戻す。

---

## アラート設定

### 通知メールアドレスを変更

`GAS_USAGE_MONITORING.gs` の以下を編集：

```javascript
const ALERT_EMAIL_TO = 'sales@bearidge.jp'; // ← 変更可能
```

### 閾値を変更

```javascript
const ALERT_THRESHOLD_JPY = 20000; // ← ¥10000、¥30000などに変更可能
```

### 為替レートを変更

```javascript
const USD_TO_JPY_RATE = 150; // ← 実勢レートに更新
```

---

## アラート挙動

| 状況 | 動作 |
|------|------|
| 月内コストが¥20,000未満 | 何もしない |
| 月内コストが¥20,000を超えた瞬間 | sales@bearidge.jp へメール送信 |
| 月内に再度API呼び出し | アラート送信済みなので追加メールは送らない |
| 翌月になる | アラート送信状態がリセット、再度監視開始 |

---

## トラブルシューティング

### メールが送信されない
- **権限**：MailApp の権限が許可されているか確認
- **Gmail の制限**：Google Apps Script のメール送信は1日100通まで（個人アカウント）

### 重複送信を防ぐ
- `ALERT_STATUS` シートで管理しているので、自動的に月1回に制限

### 再テストしたい
- `resetAlertForCurrentMonth()` を実行すれば、当月のアラート送信状態がリセットされ、再送信可能

### 月次合計が正しくない
- `USAGE_LOG` シートの「日時」列が Date 型になっているか確認
- 列の順序が変わっていないか確認（D列=入力トークン、I列=コスト(JPY)）
