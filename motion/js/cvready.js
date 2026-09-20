// opencv.js 준비를 기다린다.
//
// 이 프로젝트가 쓰는 opencv.js 빌드는 Emscripten Module 객체에
// `Module.then = function(func){ if (calledRun) func(Module); ... }` 같은 커스텀
// then을 영구히 달아 둔다. Module.Mat이 생긴 뒤(=cv가 다 준비된 뒤)에도 Module.then은
// 여전히 함수라서, 이 Promise를 그 객체로 그냥 resolve()해 버리면 네이티브 Promise의
// "thenable 처리" 알고리즘이 자동으로 then(resolveFn)을 부르고, 그 then은 다시
// resolveFn(Module)로 "자기 자신"을 넘겨 또 thenable 취급을 받는 일이 마이크로태스크
// 단위로 영원히 반복된다. 화면은 아무 에러 없이 "사진 읽는 중" 직후에서 멈춘 것처럼
// 보인다(실은 렌더러가 이 무한 microtask 루프에 갇혀 있는 것). 그래서 resolve하기
// 직전에 반드시 then을 지우거나, 안 지워지면 Proxy로 가려서 절대 thenable을 그대로
// 넘기지 않는다.
//
// Node 테스트(motion/test/_cv.mjs)는 원래 Proxy로 then을 가려서 이 문제를 피해 왔다 —
// 브라우저에서 실제로 쓰는 이 함수도 같은 방어를 하도록 옮겨 왔다.
export function cvReady(win = globalThis.window) {
  // 아직 Module 자체가 thenable인 초기 단계: then(cb)을 한 번 걸어 두면 Emscripten이
  // calledRun 이후 cb(Module)을 불러 주는데, 이때 win.cv를 그 결과로 덮어써 둔다.
  // 이건 콜백을 등록하는 것일 뿐 Promise를 그 값으로 resolve하는 게 아니므로 안전하다.
  if (win.cv && typeof win.cv.then === 'function') win.cv.then(m => { win.cv = m; });
  return new Promise(resolve => {
    const tick = () => {
      if (!(win.cv && win.cv.Mat)) { setTimeout(tick, 100); return; }
      const cv = win.cv;
      try { delete cv.then; } catch (e) { /* 지워지지 않으면 아래서 Proxy로 가린다 */ }
      if (typeof cv.then === 'function') resolve(new Proxy(cv, { get: (t, p) => (p === 'then' ? undefined : t[p]) }));
      else resolve(cv);
    };
    tick();
  });
}
