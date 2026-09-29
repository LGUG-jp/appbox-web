/**
 * 組織独自閉庁日の設定
 *
 * 自治体・組織独自の休庁日（開庁しない日）を定義します。
 * キー: "YYYY-MM-DD" 形式の日付文字列
 * 値: 休庁理由（例: "創立記念日", "夏季一斉休庁日"）
 *
 * 【設定方法】
 * 1. テキストエディタ（メモ帳など）で直接編集する場合:
 *    customClosedDays オブジェクト内に "年-月-日": "理由" を記述して保存します。
 * 2. 管理者用ツール（maintenance.html）を使用する場合:
 *    maintenance.html をブラウザで開き、GUI上で追加・編集した設定ファイルを
 *    ダウンロードして本ファイルに上書き配置します。
 */
(function (root) {
  "use strict";

  var customClosedDays = {
    // 設定例（必要に応じてコメントアウトを解除または追記してください）:
    // "2026-10-01": "創立記念日",
    // "2026-08-14": "夏季一斉休庁日"
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = customClosedDays;
  }
  if (root) {
    root.AppBoxCustomClosedDays = customClosedDays;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
