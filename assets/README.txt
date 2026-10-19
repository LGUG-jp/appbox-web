共創アプリBOX 共通アセット 早見表
========================================

このフォルダは同梱アプリが実行時に使用する共通CSS・SVG・JavaScriptを収録します。
仕様、共通クラス、JavaScript API、変更時の注意は次を参照してください。

共通アセット版: v2.3.0

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
6. appbox-icons.css（操作アイコンを使う画面のみ）
7. アプリ固有のapp.css

ヘルプ画面ではappbox-help.cssを読み込みます。背景へテーマ色を適用する場合は
appbox-help-theme.cssを続けて読み込みます。アプリ固有CSSは読み込みません。

操作アイコンの図柄はappbox-icons.svg、一覧・用例・追加手順は
../docs/COMMON_ASSETS.md の「共通操作アイコン」を参照してください。
SVGをimage/svg+xmlで配信します（IIS用のassets/web.configを同梱）。

■ JavaScript読み込み順

appbox-utilities.jsを使う場合は、アプリ固有のapp.jsより先に読み込みます。
画像加工・QRコードのデコード前検査はappbox-safe-image.jsをアプリ本体より先に読み込みます。
PNG/JPEG/WebP実体ヘッダー解析とJPEG/PNGの回転時の寸法照合を共有します（Issue #203）。
アニメーションWebPは既定で拒否し、静止PNG化するQRだけallowAnimationで許可します。
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

■ ブランド

brand/ のSVGをヘッダーで使用します。通常は1段ロゴ、640px以下では32pxのマークを表示します。
appbox-header--editor は1024px以下又は高さ500px以下でマークに切り替える指定です。
appbox-favicon.svgはbrand/appbox-mark-compact.svgと同じ内容の互換URLです。
正本を変更するときは互換URLも同期し、?v=を共通assets版へ更新します。
ICOの補助形式はbrand/appbox-favicon.icoです。仕様・用例は../docs/BRAND.mdを参照してください。

■ 変更履歴

v2.3.0:
- そだつBOXの1段ロゴ・小サイズ用マークを共通ヘッダーへ適用（Issue #197）。
- ファビコンの互換URLを新マークへ更新し、SVG・ICOのキャッシュ識別子と縮小表示を統一。

v2.2.0:
- PDF基準の操作アイコン35個と共通CSSを追加し、PDF・画像加工へ適用（Issue #191）。
- SVGのIIS MIME設定、無効状態と強制色対応、利用・追加手順を同梱。

v2.1.0:
- ヘッダーおよびアプリ導入部をコンパクト化し、共通トークンに基づく新ベースラインとして整理（Issue #145）。

v2.0.1:
- 共通ヘルプの狭幅表示で、本文の横あふれと目次の固定重なりを修正（Issue #121）。

v2.0.0:
- 旧アプリ名テーマセレクタを削除し、系統色名テーマへ一本化。
- 破壊的な互換エイリアス削除に伴い共通assetsをMAJOR更新。

v1.5.2:
- orangeテーマのページ背景を #fffaf6 から #fff7f2 へ調整し、背景色を識別しやすく変更。
- ヘルプ画面の背景にテーマ色を適用するappbox-help-theme.cssを追加。

v1.5.1:
- 説明文の左端インデント統一（appbox-chrome.css）とスマホ幅での余白解除。
