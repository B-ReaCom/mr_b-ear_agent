/**
 * Mr. B-EAR 利用量モニタリング & ¥20,000超過アラート
 * Google Apps Script
 *
 * 機能：
 * 1. APIリクエストのログ受信（既存）
 * 2. 月次の使用量集計
 * 3. ¥20,000を超えた時点で sales@bearidge.jp へメール送信（月1回のみ）
 *
 * 設置方法：
 * 1. https://script.google.com にアクセス
 * 2. 既存の Mr. B-EAR スクリプト（URL: AKfycbz0Jm2Fc...）を開く
 * 3. このコードを貼り付け（または既存コードに統合）
 * 4. 「ウェブアプリとしてデプロイ」を実行
 * 5. デプロイURL が変わる場合は、api/chat.js の USAGE_LOG_URL も更新
 *
 * 必要なシート構成：
 * - シート「シート1」：既存のQ&Aログ用（現行のまま・Google Sheets日本語版のデフォルト名）
 * - シート「USAGE_LOG」：API使用量ログ用（新規・自動作成される）
 * - シート「ALERT_STATUS」：アラート送信状態管理（新規・自動作成される）
 */

// ========== 設定 ==========
const ALERT_THRESHOLD_JPY = 20000;        // ¥20,000超過でアラート
const ALERT_EMAIL_TO = 'sales@bearidge.jp'; // 通知先メールアドレス
const USD_TO_JPY_RATE = 150;              // 為替レート（USD→JPY、必要に応じて調整）

// ▼ ミッドランドハーツ 見積もり依頼の通知先
const QUOTE_EMAIL_TO = 'info@midhts.com';
const QUOTE_EMAIL_CC = ''; // 必要ならカンマ区切りで追加

// シート名
const SHEET_QA_LOG = 'シート1';            // Q&Aログシート（既存・スプレッドシートのデフォルト名）
const SHEET_USAGE_LOG = 'USAGE_LOG';      // API使用量ログ
const SHEET_ALERT_STATUS = 'ALERT_STATUS'; // アラート送信状態
const SHEET_QUOTE_LOG = 'QUOTE_LOG';      // 見積もり依頼ログ

// スプレッドシートID（既存のQ&Aログと同じスプレッドシートを使用）
const SPREADSHEET_ID = '1N6_QebV3Z7Idxuc4UO3xqSSoQFsZ33prstbd5S0BjEo';
function getSpreadsheet() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

// ========== メイン処理 ==========
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    // データタイプによって処理を分岐
    if (data.type === 'api_usage') {
      // API使用量ログ
      handleUsageLog(data);
    } else if (data.type === 'quote_request') {
      // ミッドランドハーツ 見積もり依頼
      handleQuoteRequest(data);
    } else {
      // 既存のQ&Aログ
      handleQALog(data);
    }

    return ContentService.createTextOutput(JSON.stringify({ success: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ========== Q&Aログ記録（既存機能） ==========
function handleQALog(data) {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_QA_LOG);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_QA_LOG);
    sheet.appendRow(['日時', '質問', '回答', 'デバイス']);
  }
  sheet.appendRow([
    new Date(),
    data.question || '',
    data.answer || '',
    data.device || ''
  ]);
}

// ========== API使用量ログ記録 ==========
function handleUsageLog(data) {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_USAGE_LOG);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_USAGE_LOG);
    sheet.appendRow([
      '日時', 'IP', 'モデル',
      '入力トークン', 'キャッシュ書込', 'キャッシュ読込', '出力トークン',
      'コスト(USD)', 'コスト(JPY)'
    ]);
  }

  const usage = data.usage || {};
  const costUSD = data.cost_usd || 0;
  const costJPY = costUSD * USD_TO_JPY_RATE;

  sheet.appendRow([
    new Date(data.timestamp || Date.now()),
    data.ip || 'unknown',
    data.model || 'unknown',
    usage.input_tokens || 0,
    usage.cache_creation_input_tokens || 0,
    usage.cache_read_input_tokens || 0,
    usage.output_tokens || 0,
    costUSD.toFixed(6),
    Math.round(costJPY * 100) / 100
  ]);

  // ¥20,000超過チェック
  checkMonthlyThreshold();
}

// ========== 月次¥20,000超過チェック ==========
function checkMonthlyThreshold() {
  const ss = getSpreadsheet();
  const usageSheet = ss.getSheetByName(SHEET_USAGE_LOG);
  if (!usageSheet) return;

  const now = new Date();
  const yearMonth = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM');

  // 今月の合計を計算
  const data = usageSheet.getDataRange().getValues();
  let monthlyTotalJPY = 0;
  for (let i = 1; i < data.length; i++) {
    const rowDate = data[i][0];
    if (rowDate instanceof Date) {
      const rowYM = Utilities.formatDate(rowDate, 'Asia/Tokyo', 'yyyy-MM');
      if (rowYM === yearMonth) {
        monthlyTotalJPY += Number(data[i][8] || 0);
      }
    }
  }

  // 閾値を超えていなければ何もしない
  if (monthlyTotalJPY < ALERT_THRESHOLD_JPY) return;

  // アラート送信状態を確認（同月内に重複送信しない）
  let alertSheet = ss.getSheetByName(SHEET_ALERT_STATUS);
  if (!alertSheet) {
    alertSheet = ss.insertSheet(SHEET_ALERT_STATUS);
    alertSheet.appendRow(['年月', 'アラート送信日時', '超過時の月次合計(JPY)']);
  }

  // 当月のアラート送信済みか確認
  const alertData = alertSheet.getDataRange().getValues();
  for (let i = 1; i < alertData.length; i++) {
    if (alertData[i][0] === yearMonth) {
      return; // 既に送信済み
    }
  }

  // アラートメール送信
  sendAlertEmail(monthlyTotalJPY, yearMonth);

  // 送信記録
  alertSheet.appendRow([yearMonth, new Date(), Math.round(monthlyTotalJPY)]);
}

// ========== アラートメール送信 ==========
function sendAlertEmail(monthlyTotalJPY, yearMonth) {
  const subject = `【Mr. B-EAR】月間利用コストが¥${ALERT_THRESHOLD_JPY.toLocaleString()}を超過しました`;
  const body = `Mr. B-EAR の今月（${yearMonth}）の利用コストが ¥${Math.round(monthlyTotalJPY).toLocaleString()} に達しました。

設定した警告閾値（¥${ALERT_THRESHOLD_JPY.toLocaleString()}）を超過しています。

詳細は以下のスプレッドシートでご確認ください：
${getSpreadsheet().getUrl()}

ご対応をお願いいたします。

──────────────────────────────────────
このメールはMr. B-EAR利用量モニタリング自動通知です。
今月の閾値超過アラートは今回のみ送信されます。
来月になれば再度監視されます。`;

  MailApp.sendEmail({
    to: ALERT_EMAIL_TO,
    subject: subject,
    body: body
  });
}

// ========== ミッドランドハーツ 見積もり依頼処理 ==========
function handleQuoteRequest(data) {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_QUOTE_LOG);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_QUOTE_LOG);
    sheet.appendRow([
      '日時', '見積番号', 'コース', '連絡希望', 'お名前', '会社名', '部署', 'メール', '電話',
      '製品内訳', '小計(JPY 税抜)', '合計(JPY 税込)', '6W4H', '備考', 'IP'
    ]);
  }

  const customer = data.customer || {};
  const items = data.items || [];
  const sit = data.situation || null;
  const contactRequested = data.contactRequested !== false; // default true

  const itemsText = items.map(it =>
    `${it.name} × ${it.quantity} = ¥${(it.unitPrice * it.quantity).toLocaleString()}`
  ).join('\n');

  const sitText = sit ? [
    sit.who ? `[Who] ${sit.who}` : null,
    sit.whom ? `[Whom] ${sit.whom}` : null,
    sit.what ? `[What] ${sit.what}` : null,
    sit.when ? `[When] ${sit.when}` : null,
    sit.where ? `[Where] ${sit.where}` : null,
    sit.why ? `[Why] ${sit.why}` : null,
    sit.how ? `[How] ${sit.how}` : null,
    sit.howMany ? `[How many] ${sit.howMany}` : null,
    sit.howMuch ? `[How much] ${sit.howMuch}` : null,
    sit.howLong ? `[How long] ${sit.howLong}` : null,
  ].filter(Boolean).join('\n') : '';

  const subtotal = data.subtotal || 0;
  const grandTotal = Math.floor(subtotal * 1.1); // 税込

  sheet.appendRow([
    new Date(data.timestamp || Date.now()),
    data.quoteNumber || '',
    data.mode === 'detailed' ? '詳しく相談' : 'クイック見積もり',
    contactRequested ? '希望' : '不要',
    customer.name || '',
    customer.company || '',
    customer.department || '',
    customer.email || '',
    customer.phone || '',
    itemsText,
    subtotal,
    grandTotal,
    sitText,
    data.notes || '',
    data.ip || ''
  ]);

  // 連絡希望時のみメール通知
  if (contactRequested) {
    sendQuoteNotification(data, itemsText, sitText);
  }
}

function sendQuoteNotification(data, itemsText, sitText) {
  const customer = data.customer || {};
  const courseLabel = data.mode === 'detailed' ? '詳しく相談' : 'クイック見積もり';
  const quoteNumber = data.quoteNumber || '(自動採番なし)';
  const subtotal = data.subtotal || 0;
  const grandTotal = Math.floor(subtotal * 1.1);
  const subject = `【自動見積もり】${customer.name || '名前未入力'} 様（${quoteNumber}）`;

  let body = `ミッドランドハーツ 自動見積もりシステムにて見積書が発行されました。
お客様は担当者からの連絡を希望されています。

━━━━━━━━━━━━━━━━━━━━━━━━━━
見積番号: ${quoteNumber}
コース: ${courseLabel}
発行日時: ${new Date(data.timestamp || Date.now()).toLocaleString('ja-JP')}
━━━━━━━━━━━━━━━━━━━━━━━━━━

【お客様情報】
お名前: ${customer.name || ''}
会社名: ${customer.company || '(未入力)'}
部署・役職: ${customer.department || '(未入力)'}
メール: ${customer.email || ''}
電話: ${customer.phone || '(未入力)'}

【ご希望の製品】
${itemsText || '(なし)'}

小計（税抜）: ¥${subtotal.toLocaleString()}
消費税（10%）: ¥${(grandTotal - subtotal).toLocaleString()}
合計（税込）: ¥${grandTotal.toLocaleString()}
`;

  if (sitText) {
    body += `
【ご利用シーン（6W4H）】
${sitText}
`;
  }

  if (data.notes) {
    body += `
【備考・ご要望】
${data.notes}
`;
  }

  body += `
━━━━━━━━━━━━━━━━━━━━━━━━━━
このメールは自動見積もりシステムより自動送信されています。
ログはスプレッドシートでご確認ください：
${getSpreadsheet().getUrl()}
`;

  const options = { to: QUOTE_EMAIL_TO, subject, body };
  if (QUOTE_EMAIL_CC) options.cc = QUOTE_EMAIL_CC;
  MailApp.sendEmail(options);
}

// ========== 動作確認・手動テスト用 ==========
function testMonthlyCheck() {
  // 手動でチェックを実行（デバッグ用）
  checkMonthlyThreshold();
}

function showCurrentMonthlyTotal() {
  // 今月の合計を表示（デバッグ用）
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_USAGE_LOG);
  if (!sheet) {
    Logger.log('USAGE_LOG シートが存在しません');
    return;
  }

  const now = new Date();
  const yearMonth = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM');
  const data = sheet.getDataRange().getValues();
  let total = 0;
  for (let i = 1; i < data.length; i++) {
    const rowDate = data[i][0];
    if (rowDate instanceof Date) {
      const rowYM = Utilities.formatDate(rowDate, 'Asia/Tokyo', 'yyyy-MM');
      if (rowYM === yearMonth) {
        total += Number(data[i][8] || 0);
      }
    }
  }
  Logger.log(`${yearMonth} の合計コスト: ¥${total.toLocaleString()}`);
}

function resetAlertForCurrentMonth() {
  // 当月のアラート送信状態をリセット（再テスト用）
  const ss = getSpreadsheet();
  const alertSheet = ss.getSheetByName(SHEET_ALERT_STATUS);
  if (!alertSheet) return;

  const now = new Date();
  const yearMonth = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM');
  const data = alertSheet.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    if (data[i][0] === yearMonth) {
      alertSheet.deleteRow(i + 1);
    }
  }
  Logger.log(`${yearMonth} のアラート送信状態をリセットしました`);
}

// ========== メール送信テスト ==========
// GASエディタで手動実行することで、MailApp の権限承認ダイアログを呼び出す
function testQuoteEmail() {
  MailApp.sendEmail({
    to: QUOTE_EMAIL_TO,
    subject: '【テスト】GASからのメール送信確認',
    body: 'これはGASのメール送信機能の動作確認用テストメールです。\n\n受信できていれば、見積もりシステムのメール通知も正しく動作します。\n\n送信日時: ' + new Date().toLocaleString('ja-JP')
  });
  Logger.log('テストメールを ' + QUOTE_EMAIL_TO + ' に送信しました');
}
