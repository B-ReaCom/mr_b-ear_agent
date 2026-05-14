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
 * - シート「QA_LOG」：既存のQ&Aログ用（現行のまま）
 * - シート「USAGE_LOG」：API使用量ログ用（新規・自動作成される）
 * - シート「ALERT_STATUS」：アラート送信状態管理（新規・自動作成される）
 */

// ========== 設定 ==========
const ALERT_THRESHOLD_JPY = 20000;        // ¥20,000超過でアラート
const ALERT_EMAIL_TO = 'sales@bearidge.jp'; // 通知先メールアドレス
const USD_TO_JPY_RATE = 150;              // 為替レート（USD→JPY、必要に応じて調整）

// シート名
const SHEET_QA_LOG = 'QA_LOG';            // Q&Aログシート（既存）
const SHEET_USAGE_LOG = 'USAGE_LOG';      // API使用量ログ
const SHEET_ALERT_STATUS = 'ALERT_STATUS'; // アラート送信状態

// ========== メイン処理 ==========
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    // データタイプによって処理を分岐
    if (data.type === 'api_usage') {
      // API使用量ログ
      handleUsageLog(data);
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
  const ss = SpreadsheetApp.getActiveSpreadsheet();
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
  const ss = SpreadsheetApp.getActiveSpreadsheet();
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
  const ss = SpreadsheetApp.getActiveSpreadsheet();
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
${SpreadsheetApp.getActiveSpreadsheet().getUrl()}

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

// ========== 動作確認・手動テスト用 ==========
function testMonthlyCheck() {
  // 手動でチェックを実行（デバッグ用）
  checkMonthlyThreshold();
}

function showCurrentMonthlyTotal() {
  // 今月の合計を表示（デバッグ用）
  const ss = SpreadsheetApp.getActiveSpreadsheet();
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
  const ss = SpreadsheetApp.getActiveSpreadsheet();
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
