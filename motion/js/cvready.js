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
// 직전에 반드시 then을 지우거나, 안 지워지면 then이 undefined인 껍데기 객체를 대신
// 넘겨서 절대 thenable을 그대로 넘기지 않는다.
//
// 껍데기는 Object.create(cv)로 만든다 — cv를 프로토타입으로 삼으므로 cv.Mat, cv.ORB
// 같은 것은 그대로 읽히고, 자기 자신에만 then: undefined를 박아 가린다. (Proxy로
// 가리는 방법은 then이 configurable:false + writable:false로 박혀 있는 경우
// "프록시는 고칠 수 없는 속성의 실제 값을 돌려줘야 한다"는 규칙에 걸려 TypeError로
// 터진다 — 정확히 이 대비책이 필요한 상황에서 못 쓰는 셈이라 쓰지 않는다.)
// timeoutMs를 넘겨도 cv가 준비되지 않으면 거절한다. 예전에는 무한히 100ms마다 다시
// 확인만 해서, opencv.js(11MB) 요청이 막히면 "사진 읽는 중"에서 영원히 멈춘 채
// 아무 메시지도 안 나오고 그 뒤로 끌어다 놓는 사진도 전부 조용히 무시됐다.
export function cvReady(win = globalThis.window, timeoutMs = 30000) {
  // 아직 Module 자체가 thenable인 초기 단계: then(cb)을 한 번 걸어 두면 Emscripten이
  // calledRun 이후 cb(Module)을 불러 주는데, 이때 win.cv를 그 결과로 덮어써 둔다.
  // 이건 콜백을 등록하는 것일 뿐 Promise를 그 값으로 resolve하는 게 아니므로 안전하다.
  if (win.cv && typeof win.cv.then === 'function') win.cv.then(m => { win.cv = m; });
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (!(win.cv && win.cv.Mat)) {
        if (Date.now() - t0 >= timeoutMs) { reject(new Error('OpenCV를 불러오지 못했습니다. 새로고침해 주세요.')); return; }
        setTimeout(tick, 100); return;
      }
      const cv = win.cv;
      try { delete cv.then; } catch (e) { /* 지워지지 않으면 아래서 껍데기로 가린다 */ }
      if (typeof cv.then === 'function') {
        const shim = Object.create(cv);
        Object.defineProperty(shim, 'then', { value: undefined });
        resolve(shim);
      } else resolve(cv);
    };
    tick();
  });
}
