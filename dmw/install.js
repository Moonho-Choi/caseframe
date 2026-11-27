// caseframe.kr 시작 창의 오른쪽 아래에 DMW 설치 아이콘을 놓는다. 누르면 비밀번호를 묻고, 맞으면 설치 파일을 받는다.
// 원본은 DMW 저장소의 site_extra/install.js 이고, publish_site.py가 caseframe 저장소의 dmw/install.js 로 올린다.
// caseframe의 index.html 에는 이 파일을 부르는 한 줄만 있다.
//
// 비밀번호는 지나가는 사람이 누르지 않게 하는 문패 정도다. 공개 홈페이지라 진짜 잠금은 아니다
// (설치 파일의 주소를 아는 사람은 받을 수 있다). 설치 파일에는 환자 자료나 계정이 들어 있지 않다.
//
// 비밀번호 다음에 치과 이름과 원장 이름을 묻고, 다운로드를 누르면 그 둘과 판 번호를 원장님의 받는 통
// (DMW 오류 보고와 같은 구글 설문지, 종류 "다운로드")에 한 줄 남긴다. 누가 몇 번 받았는지 보려는 것이다(원장님 요청 2026-11-25).
(function () {
  var LOG_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSeU43vQoLXAuu3bw4CyYocxks4t02Fg_wPAXp-IgWzT7DOKOg/formResponse';
  var LOG_ENTRY = 'entry.564898876';
  var HASH = 'cfa97f332030d443bb9f10bfc33c82abbd5677baf2c4b44ebac0e1f15e21e533';   // 비밀번호 대조값(비밀번호 자체는 적지 않는다)
  var panel = document.querySelector('.start-panel');
  if (!panel || document.getElementById('dmwInstallBtn')) return;

  var css = document.createElement('style');
  css.textContent =
    '.start-panel{position:relative}' +
    '#dmwInstallBtn{position:absolute;right:18px;bottom:14px;display:flex;align-items:center;gap:7px;padding:5px 9px 5px 5px;' +
    'border:1px solid transparent;border-radius:10px;background:transparent;color:var(--muted,#6B7785);font:inherit;font-size:12px;cursor:pointer}' +
    '#dmwInstallBtn:hover,#dmwInstallBtn:focus-visible{border-color:var(--pop-border,#D9DEE5);background:rgba(127,127,127,.08);color:inherit;outline:none}' +
    '#dmwInstallBtn svg{width:26px;height:26px;flex:none}' +
    '#dmwGate{position:fixed;inset:0;z-index:60;display:none;place-items:center;padding:20px;background:rgba(10,20,25,.45)}' +
    '#dmwGate.open{display:grid}' +
    '#dmwGate [hidden]{display:none}' +
    '#dmwGate form,#dmwGate .ask{width:100%;max-width:300px;padding:22px 20px 18px;border-radius:16px;background:#fff;color:#1B2430;' +
    'box-shadow:0 18px 50px rgba(0,0,0,.28);font-size:14px}' +
    '#dmwGate h3{margin:0 0 4px;font-size:17px}' +
    '#dmwGate p{margin:0 0 14px;color:#5B6675;font-size:13px;line-height:1.5}' +
    '#dmwGate input{width:100%;box-sizing:border-box;height:44px;padding:0 12px;border:1px solid #D9DEE5;border-radius:9px;font:inherit;font-size:16px}' +
    '#dmwGate input:focus{outline:2px solid #2a78d6;outline-offset:1px}' +
    '#dmwGate .who input+input{margin-top:8px}' +
    '#dmwGate .msg{min-height:20px;margin:8px 0 10px;color:#A32B2B;font-size:13px}' +
    '#dmwGate .row{display:flex;gap:8px}' +
    '#dmwGate button{flex:1;height:42px;border-radius:9px;border:1px solid #D9DEE5;background:#fff;color:#1B2430;font:inherit;font-weight:600;cursor:pointer}' +
    '#dmwGate button.go{border-color:#1D5FBF;background:#1D5FBF;color:#fff}' +
    '@media (max-width:640px){#dmwInstallBtn{position:static;margin:14px 0 0 auto}}';
  document.head.appendChild(css);

  var LOGO = '<svg viewBox="0 0 32 32" aria-hidden="true">' +
    '<rect x="0.75" y="0.75" width="30.5" height="30.5" rx="7" fill="#fff" stroke="#C3CAD4" stroke-width="1.5"/>' +
    '<rect x="5" y="17" width="6" height="10" rx="1.5" fill="#2a78d6"/>' +
    '<rect x="13" y="11.5" width="6" height="15.5" rx="1.5" fill="#2a78d6"/>' +
    '<rect x="21" y="5" width="6" height="22" rx="1.5" fill="#eb6834"/></svg>';

  var btn = document.createElement('button');
  btn.id = 'dmwInstallBtn';
  btn.type = 'button';
  btn.title = 'DMW 설치 파일 받기 (비밀번호 필요)';
  btn.innerHTML = LOGO + '<span>DMW 설치</span>';
  panel.appendChild(btn);

  var gate = document.createElement('div');
  gate.id = 'dmwGate';
  gate.innerHTML =
    '<form autocomplete="off"><h3>DMW 설치 파일</h3>' +
    '<p>덴트웹을 쓰는 치과용 경영 화면 프로그램입니다. 받은 비밀번호를 넣어 주세요.</p>' +
    '<input type="password" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="비밀번호" placeholder="비밀번호">' +
    '<div class="msg" role="status"></div>' +
    '<div class="row"><button type="button" class="no">닫기</button><button type="submit" class="go">확인</button></div></form>' +
    '<form class="who" autocomplete="off" hidden><h3>DMW 설치 파일</h3>' +
    '<p>받는 분을 적어 주세요. 문제가 생겼을 때 어느 치과인지 알기 위한 것입니다.</p>' +
    '<input type="text" class="clinic" maxlength="40" aria-label="치과 이름" placeholder="치과 이름">' +
    '<input type="text" class="doctor" maxlength="20" aria-label="원장 이름" placeholder="원장 이름">' +
    '<div class="msg" role="status"></div>' +
    '<div class="row"><button type="button" class="no">닫기</button><button type="submit" class="go">다음</button></div></form>' +
    '<div class="ask" hidden><h3>DMW 설치 파일</h3><p class="what"></p>' +
    '<div class="row"><button type="button" class="no">취소</button><button type="button" class="go yes">다운로드</button></div></div>';
  document.body.appendChild(gate);
  var form = gate.querySelector('form'), input = gate.querySelector('input'), msg = gate.querySelector('.msg');   // 맨 앞의 것 = 비밀번호 창
  var ask = gate.querySelector('.ask'), what = gate.querySelector('.what'), yes = gate.querySelector('.yes');
  var who = gate.querySelector('.who'), clinic = gate.querySelector('.clinic'), doctor = gate.querySelector('.doctor');
  var whoMsg = who.querySelector('.msg');
  var found = null;                                   // 비밀번호가 맞은 뒤 받아 둔 새 판 안내

  function show(step) { form.hidden = step !== 'pw'; who.hidden = step !== 'who'; ask.hidden = step !== 'ask'; }
  function recall(key) { try { return localStorage.getItem(key) || ''; } catch (e) { return ''; } }
  function keep(key, value) { try { localStorage.setItem(key, value); } catch (e) { } }
  // 받는 통에 한 줄 남긴다. 오류 보고와 같은 모양이라 같은 시트에 쌓인다. 실패해도 다운로드는 그대로 한다.
  function record(version) {
    var d = new Date(), two = function (n) { return ('0' + n).slice(-2); };
    var body = '병원: ' + clinic.value.trim() + '\n원장: ' + doctor.value.trim() + '\n판: ' + version + '\n종류: 다운로드\n시각: ' +
      d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + ' ' + two(d.getHours()) + ':' + two(d.getMinutes());
    try {
      var data = new URLSearchParams(); data.append(LOG_ENTRY, body);
      return (window.__dmwLog || function (u, b) { return fetch(u, { method: 'POST', mode: 'no-cors', keepalive: true, body: b }); })(LOG_URL, data)
        .catch(function () { });
    } catch (e) { return Promise.resolve(); }
  }
  function open() {
    found = null; msg.textContent = ''; msg.style.color = ''; input.value = ''; show('pw');
    gate.classList.add('open'); setTimeout(function () { input.focus(); }, 30);
  }
  function close() { gate.classList.remove('open'); input.value = ''; found = null; }
  function confirmStep() {
    what.textContent = 'DMW 설치 파일(판 ' + found.version + ')을 다운로드할까요? 받은 뒤 압축을 풀고 "설치-안내.txt"를 따라 주세요.';
    show('ask');
    setTimeout(function () { yes.focus(); }, 30);
  }
  who.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (!found) return;
    if (!clinic.value.trim() || !doctor.value.trim()) {
      whoMsg.textContent = '치과 이름과 원장 이름을 모두 넣어 주세요.';
      (clinic.value.trim() ? doctor : clinic).focus();
      return;
    }
    whoMsg.textContent = '';
    keep('dmwClinic', clinic.value.trim()); keep('dmwDoctor', doctor.value.trim());
    confirmStep();
  });

  btn.addEventListener('click', function (ev) { ev.stopPropagation(); open(); });
  gate.addEventListener('click', function (ev) { if (ev.target === gate) close(); });
  Array.prototype.forEach.call(gate.querySelectorAll('.no'), function (b) { b.addEventListener('click', close); });
  // 한 번 더 묻는다: 다운로드를 누르면 받기를 시작하고 창을 닫는다(원장님 요청 2026-11-25).
  yes.addEventListener('click', function () {
    if (!found) return;
    var url = found.install, done = false;
    var go = function () { if (done) return; done = true; (window.__dmwGo || function (u) { window.location.href = u; })(url); };
    record(found.version).then(go);                   // 기록이 나간 뒤에 받기 시작(늦어도 1.5초 뒤에는 시작)
    setTimeout(go, 1500);
    close();
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && gate.classList.contains('open')) { ev.stopPropagation(); close(); }
  }, true);

  function sha256(text) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    });
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    msg.style.color = '';
    sha256('dmw-install:' + input.value.trim()).then(function (h) {
      if (h !== HASH) { msg.textContent = '비밀번호가 맞지 않습니다.'; input.select(); return null; }
      msg.textContent = '';
      return fetch('/dmw/latest.json', { cache: 'no-store' }).then(function (r) { return r.json(); });
    }).then(function (latest) {
      if (!latest) return;
      if (!latest.install) throw new Error('no install');
      found = latest;
      clinic.value = recall('dmwClinic'); doctor.value = recall('dmwDoctor'); whoMsg.textContent = '';
      show('who');
      setTimeout(function () { (clinic.value ? doctor : clinic).focus(); }, 30);
    }).catch(function () {
      msg.style.color = '';
      msg.textContent = '지금은 받을 수 없습니다. 잠시 뒤에 다시 해 주세요.';
    });
  });
})();
