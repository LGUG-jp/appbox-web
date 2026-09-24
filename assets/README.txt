お役立ちアプリBOX 共通アセット 早見表
========================================

このフォルダは同梱アプリが実行時に使用する共通CSS・JavaScriptを収録します。
仕様、共通クラス、JavaScript API、変更時の注意は次を参照してください。

共通アセット版: v1.4.1

  ../docs/COMMON_ASSETS.md

■ 標準配置

同梱アプリ: apps/<app-id>/
共通アセット: assets/

同梱アプリ直下からは ../../assets/ で参照します。

■ CSS読み込み順

1. appbox-tokens.css
2. appbox-themes.css
3. appbox-base.css
4. appbox-chrome.css
5. appbox-components.css
6. アプリ固有のapp.css

ヘルプ画面では6の代わりにappbox-help.cssを読み込み、アプリ固有CSSは
読み込みません。

■ JavaScript読み込み順

appbox-utilities.jsを使う場合は、アプリ固有のapp.jsより先に読み込みます。
折りたたみ機能を使う画面では、必要に応じてappbox-collapse.jsも読み込みます。
ヘルプ画面では、目次のスクロール連動ハイライトを行うappbox-help.jsを読み込みます。

■ キャッシュ識別子

- 共通CSS・JavaScriptの?v=: 共通assetsのバージョン
- アプリ固有CSS・JavaScriptの?v=: 対象アプリの機能バージョン

AppBox全体の版が変わっただけでは、番号合わせのために変更しません。

■ 更新時の注意

共通アセットの変更は複数アプリへ影響します。参照元、既存クラス・APIとの
互換性、共通assets版、Microsoft Edgeでの表示と操作を確認してください。
アプリ固有の処理や例外は各アプリ側へ実装します。
