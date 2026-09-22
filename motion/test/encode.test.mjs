import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outputName, pickEncoder, labelMetrics, safeName } from '../js/encode.js';

test('outputName', () => {
  assert.equal(outputName('임희진_20221128_160831.jpg', 'mp4'), '임희진_교정진행.mp4');
  assert.equal(outputName('case.png', 'mp4'), 'case_교정진행.mp4');
});
test('outputName with title: 제목이 첫 사진 이름을 대신하고 금지 글자는 빠진다', () => {
  assert.equal(outputName('case.png', 'mp4', 'high', new Date(2026, 8, 22), '홍길동 상악'), '홍길동 상악_교정진행_고품질_2026-09-22.mp4');
  assert.equal(outputName('case.png', 'mp4', null, null, '  a/b:c  '), 'a b c_교정진행.mp4');
  assert.equal(outputName('case.png', 'mp4', null, null, '   '), 'case_교정진행.mp4');
  assert.equal(safeName('x'.repeat(50)).length, 40);
});

test('outputName with quality and date', () => {
  assert.equal(outputName('임희진_20221128_160831.jpg', 'mp4', 'high', new Date(2026, 8, 21)), '임희진_교정진행_고품질_2026-09-21.mp4');
  assert.equal(outputName('case.png', 'mp4', 'fast', new Date(2026, 0, 5)), 'case_교정진행_빠르게_2026-01-05.mp4');
  assert.equal(outputName('case.png', 'mp4', 'none', new Date(2026, 11, 31)), 'case_교정진행_단순_2026-12-31.mp4');
  assert.equal(outputName('case.png', 'mp4'), 'case_교정진행.mp4');
});
// WebCodecs가 없으면 null만 돌려준다(예비 WebM 경로 없음) → main.js가 "크롬이나
// 엣지를 써 주세요"로 안내한다.
test('pickEncoder returns null without WebCodecs', () => { assert.equal(pickEncoder(), null); });
test('labelMetrics scale with width', () => {
  assert.deepEqual(labelMetrics(1152), { band: 63, font: 40, pad: 14 });
});
