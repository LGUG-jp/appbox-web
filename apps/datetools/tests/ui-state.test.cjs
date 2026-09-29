'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./ui-fixture.cjs');

test('早見表は検索なしで101年分、旧元号表示と印刷も全件を維持する', () => {
  const f = fixture();
  assert.equal(f.get('reference-query'), null);
  assert.equal(f.get('reference-rows').querySelectorAll('tbody tr').length, 101);
  f.get('reference-previous-era').checked = true; f.get('reference-previous-era').emit('change');
  assert.match(f.get('reference-rows').textContent, /平成31年／令和元年/);
  f.get('print-reference').click();
  assert.equal(f.get('print-dialog').open, true);
  assert.equal(f.get('print-rows').querySelectorAll('tbody tr').length, 101);
});
test('結果は満年齢・和暦西暦・年度末・誕生日・日数を保持し、コピーにも条件を含む', async () => {
  const f = fixture(); f.birth(); f.submit();
  const result = f.get('result-age');
  assert.equal(result.querySelector('.result-main').textContent, '36歳');
  for (const text of ['1990年5月15日', '平成2年5月15日', '年度末年齢', '次回の誕生日', '基準日からの日数']) assert.ok(result.textContent.includes(text), text);
  result.querySelector('button').click(); await Promise.resolve();
  const copied = result.querySelector('textarea').value;
  assert.match(copied, /基準日：2026年9月19日/);
  assert.match(copied, /2月29日生まれ/);
  f.set('birth-day', '16'); assert.equal(result.querySelector('textarea'), null); assert.equal(result.querySelector('button'), null);
});
test('西暦と和暦は入力済みの日付を保持して変換し、元年と全角も使える', () => {
  const f = fixture(); f.birth(); f.get('birth-format-japanese').click();
  assert.equal(f.get('birth-year').value, '2'); assert.equal(f.get('birth-calendar').value, 'heisei');
  f.submit(); assert.equal(f.get('result-age').querySelector('.result-main').textContent, '36歳');
  f.get('birth-format-western').click(); assert.equal(f.get('birth-year').value, '1990');
  f.get('clear-age').click(); f.get('birth-format-japanese').click();
  f.birth('元', '５', '１'); f.submit();
  assert.match(f.get('result-age').textContent, /令和元年5月1日/);
});
test('未完成・不正な生年月日の暦切替では入力を失わず、不正な元号日付も拒否する', () => {
  const f = fixture(); f.set('birth-year', '1990'); f.get('birth-format-japanese').click();
  assert.equal(f.get('birth-format-western').checked, true); assert.equal(f.get('birth-year').value, '1990');
  assert.match(f.get('error-age').textContent, /正しく入力/);
  f.get('clear-age').click(); f.get('birth-format-japanese').click(); f.birth('元', '4', '30'); f.submit();
  assert.match(f.get('error-age').textContent, /令和の期間外/); assert.equal(f.document.activeElement.id, 'birth-year');
});
test('指定日のカレンダーと和暦直接入力を同期し、不正入力を閉じた際は旧日付を使わない', () => {
  const f = fixture(); f.birth(); f.set('reference-date', '2026-05-14'); f.submit();
  assert.equal(f.get('result-age').querySelector('.result-main').textContent, '35歳');
  f.toggle(true); assert.equal(f.get('reference-year').value, '2026');
  f.set('reference-calendar', 'reiwa'); f.set('reference-year', '８'); f.set('reference-day', '１５'); f.submit();
  assert.equal(f.get('result-age').querySelector('.result-main').textContent, '36歳');
  f.toggle(false); assert.equal(f.get('reference-date').value, '2026-05-15');
  f.toggle(true); f.set('reference-month', '2'); f.set('reference-day', '30'); f.toggle(false); f.submit();
  assert.equal(f.get('reference-date').value, ''); assert.match(f.get('error-age').textContent, /基準日/);
  assert.equal(f.document.activeElement.id, 'reference-date');
});
test('初期基準日は今日に追従するが、利用者が変更した基準日と生年月日は変更しない', () => {
  const f = fixture(); f.birth(); f.submit(); f.advance('2026-09-20'); f.window.emit('focus');
  assert.equal(f.get('reference-date').value, '2026-09-20'); assert.equal(f.get('result-age').querySelector('.result-main'), null);
  f.set('reference-date', '2026-05-14'); f.submit();
  f.advance('2026-09-21'); f.window.emit('focus');
  assert.equal(f.get('reference-date').value, '2026-05-14'); assert.equal(f.get('birth-year').value, '1990');
  assert.equal(f.get('result-age').querySelector('.result-main').textContent, '35歳');
});
test('クリア・ページ離脱・復帰で生年月日と結果を残さず初期状態へ戻す', () => {
  const f = fixture(); f.birth(); f.get('birth-format-japanese').click(); f.set('reference-date', '2026-05-14'); f.toggle(true); f.submit();
  f.get('clear-age').click(); assert.equal(f.get('birth-year').value, ''); assert.equal(f.get('birth-calendar').value, 'western');
  assert.equal(f.get('reference-date').value, '2026-09-19'); assert.equal(f.get('reference-manual').open, false);
  f.birth(); f.submit(); f.window.emit('pagehide');
  assert.equal(f.get('birth-year').value, ''); assert.equal(f.get('reference-date').value, ''); assert.equal(f.get('result-age').querySelector('button'), null);
  f.window.emit('pageshow', { persisted: true }); assert.equal(f.get('reference-date').value, '2026-09-19'); assert.equal(f.get('birth-year').value, '');
  assert.equal(f.get('view-reference').getAttribute('aria-selected'), 'true');
});
test('遅延したコピー失敗で入力変更前の個人情報を再表示しない', async () => {
  let finish;
  const f = fixture({ copyText: () => new Promise(resolve => { finish = resolve; }) });
  f.birth(); f.submit(); f.get('result-age').querySelector('button').click();
  f.get('clear-age').click(); finish(false); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.get('result-age').querySelector('textarea'), null);
});
