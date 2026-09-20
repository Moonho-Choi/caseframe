import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDate, sortItems, monthsLabel, baseName } from '../js/load.js';

test('parseDate finds YYYYMMDD', () => {
  assert.deepEqual(parseDate('임희진_20230724_143958.jpg'), new Date(2023, 6, 24));
  assert.equal(parseDate('photo.jpg'), null);
  assert.equal(parseDate('x_20231301.jpg'), null);
});
test('sortItems by date then name', () => {
  const s = sortItems([{ name: 'b', date: null }, { name: 'a_20230101.jpg', date: new Date(2023, 0, 1) }, { name: 'a_20220101.jpg', date: new Date(2022, 0, 1) }, { name: 'a', date: null }]);
  assert.deepEqual(s.map(i => i.name), ['a_20220101.jpg', 'a_20230101.jpg', 'a', 'b']);
});
test('monthsLabel', () => {
  const d0 = new Date(2022, 10, 28);
  assert.equal(monthsLabel(d0, d0), '시작');
  assert.equal(monthsLabel(d0, new Date(2022, 11, 20)), '시작');       // 30일 미만
  assert.equal(monthsLabel(d0, new Date(2023, 1, 6)), '2개월');
  assert.equal(monthsLabel(d0, new Date(2023, 10, 28)), '1년');
  assert.equal(monthsLabel(d0, new Date(2024, 1, 19)), '1년 2개월');
});
test('baseName', () => {
  assert.equal(baseName('임희진_20230724_143958.jpg'), '임희진');
  assert.equal(baseName('IMG_0001.JPG'), 'IMG');
  assert.equal(baseName('photo.png'), 'photo');
});
