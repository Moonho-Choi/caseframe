// caseframe.kr 시작 창의 오른쪽 아래에 DMW 설치 아이콘을 놓는다. 누르면 비밀번호를 묻고, 맞으면 설치 파일을 받는다.
// 원본은 DMW 저장소의 site_extra/install.js 이고, publish_site.py가 caseframe 저장소의 dmw/install.js 로 올린다.
// caseframe의 index.html 에는 이 파일을 부르는 한 줄만 있다.
//
// 비밀번호는 지나가는 사람이 누르지 않게 하는 문패 정도다. 공개 홈페이지라 진짜 잠금은 아니다
// (설치 파일의 주소를 아는 사람은 받을 수 있다). 설치 파일에는 환자 자료나 계정이 들어 있지 않다.
(function () {
  var HASH = 'd1174443fa904a38ede6207da4dfe9e5402789ba7dbc64a6a1632badcb7088c2';   // 비밀번호 대조값(비밀번호 자체는 적지 않는다)
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
    '#dmwGate form{width:100%;max-width:300px;padding:22px 20px 18px;border-radius:16px;background:#fff;color:#1B2430;' +
    'box-shadow:0 18px 50px rgba(0,0,0,.28);font-size:14px}' +
    '#dmwGate h3{margin:0 0 4px;font-size:17px}' +
    '#dmwGate p{margin:0 0 14px;color:#5B6675;font-size:13px;line-height:1.5}' +
    '#dmwGate input{width:100%;box-sizing:border-box;height:44px;padding:0 12px;border:1px solid #D9DEE5;border-radius:9px;font:inherit;font-size:16px}' +
    '#dmwGate input:focus{outline:2px solid #2a78d6;outline-offset:1px}' +
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
    '<input type="password" inputmode="numeric" aria-label="비밀번호" placeholder="비밀번호">' +
    '<div class="msg" role="status"></div>' +
    '<div class="row"><button type="button" class="no">닫기</button><button type="submit" class="go">받기</button></div></form>';
  document.body.appendChild(gate);
  var form = gate.querySelector('form'), input = gate.querySelector('input'), msg = gate.querySelector('.msg');

  function open() { msg.textContent = ''; input.value = ''; gate.classList.add('open'); setTimeout(function () { input.focus(); }, 30); }
  function close() { gate.classList.remove('open'); }

  btn.addEventListener('click', function (ev) { ev.stopPropagation(); open(); });
  gate.addEventListener('click', function (ev) { if (ev.target === gate) close(); });
  gate.querySelector('.no').addEventListener('click', close);
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
      msg.style.color = '#17602C';
      msg.textContent = '설치 파일을 받는 중입니다…';
      return fetch('/dmw/latest.json', { cache: 'no-store' }).then(function (r) { return r.json(); });
    }).then(function (latest) {
      if (!latest) return;
      if (!latest.install) throw new Error('no install');
      (window.__dmwGo || function (u) { window.location.href = u; })(latest.install);
      msg.textContent = '받기를 시작했습니다. 압축을 풀고 "설치-안내.txt"를 따라 주세요. (판 ' + latest.version + ')';
    }).catch(function () {
      msg.style.color = '';
      msg.textContent = '지금은 받을 수 없습니다. 잠시 뒤에 다시 해 주세요.';
    });
  });
})();
