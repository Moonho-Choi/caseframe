// 튀는 사진 빼기(2026-09-23, 처음 이름 "부드럽게 고르기"): 앞에서 남긴 사진과 구도가 크게 어긋나는 사진을 뺀다.
// score(a, b) = 두 사진의 겹침 점수(높을수록 비슷). threshold 이상이면 남기고, 아니면 건너뛴다.
// 연속으로 maxSkip장을 건너뛰게 되면 그중 가장 잘 겹치는 한 장을 억지로 남겨 시간 흐름이
// 끊기지 않게 한다. 첫 장과 마지막 장은 언제나 남긴다(시작과 끝).
export function pickSmooth(n, score, threshold, maxSkip = 3, protectedIndices = new Set()) {
  if (n <= 2) return Array.from({ length: n }, (_, i) => i);
  const kept = [0];
  let run = [];
  for (let i = 1; i < n - 1; i++) {
    const s = score(kept[kept.length - 1], i);
    if (protectedIndices.has(i) || s >= threshold) { kept.push(i); run = []; continue; }
    run.push([i, s]);
    if (run.length >= maxSkip) {
      const best = run.reduce((a, b) => (b[1] > a[1] ? b : a));
      kept.push(best[0]); run = [];
    }
  }
  kept.push(n - 1);
  return kept;
}

// 오름차순 p 분위값(0~1). 빈 배열이면 0.
export function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
}
