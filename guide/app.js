'use strict';
(() => {
  const modules = window.IEUM_GUIDE.modules;
  const options = document.getElementById('guide-options');
  const output = document.getElementById('guide-sections');
  const dateInput = document.getElementById('next-visit');
  const selected = new Set(modules.filter(item => item.selected).map(item => item.id));
  const inputs = new Map();
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function render() {
    const active = modules.filter(item => selected.has(item.id));
    const fragment = document.createDocumentFragment();
    active.forEach((item, index) => {
      const section = element('section', 'guide-section');
      section.dataset.moduleId = item.id;
      section.append(element('span', 'guide-number', String(index + 1).padStart(2, '0')));
      const content = element('div');
      content.append(element('h3', '', item.title), element('p', '', item.text));
      section.append(content);
      fragment.append(section);
    });
    output.replaceChildren(fragment);
    inputs.forEach((input, id) => { input.checked = selected.has(id); });
    document.getElementById('selection-status').textContent = `${active.length}개 항목 선택 · A4 세로`;
    document.getElementById('empty-state').hidden = active.length !== 0;
    document.getElementById('print-button').disabled = active.length === 0;
    const value = dateInput.value;
    document.getElementById('printed-next-visit').textContent = value
      ? value.split('-').map((part, i) => `${Number(part)}${['년', '월', '일'][i]}`).join(' ')
      : '진료실에서 안내받은 일정을 확인해 주세요.';
  }
  modules.forEach(item => {
    const label = element('label', 'option');
    const input = document.createElement('input');
    input.type = 'checkbox'; input.value = item.id;
    input.setAttribute('aria-label', item.title);
    input.addEventListener('change', () => { input.checked ? selected.add(item.id) : selected.delete(item.id); render(); });
    inputs.set(item.id, input);
    const text = element('span');
    text.append(element('span', 'option-title', item.title), element('span', 'option-hint', item.hint));
    label.append(input, text); options.append(label);
  });
  dateInput.addEventListener('input', render);
  document.getElementById('print-button').addEventListener('click', () => { if (selected.size) window.print(); });
  render();
  const context = document.modelContext;
  if (context?.registerTool) {
    const lifecycle = new AbortController();
    const registrations = [{
      name: 'read_guide_draft', title: '현재 안내지 초안 읽기',
      description: '현재 선택된 검수용 안내지 항목과 문구를 읽습니다. 모든 문구는 원장 검수 전 초안입니다.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: () => ({ reviewStatus: 'draft', modules: modules.filter(item => selected.has(item.id)).map(({id,title,text}) => ({id,title,text})) })
    }, {
      name: 'select_guide_modules', title: '안내지 항목 선택',
      description: '검수용 안내지에 포함할 항목을 선택합니다. 인쇄하거나 승인 상태를 변경하지 않습니다.',
      inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string', enum: modules.map(item => item.id) }, uniqueItems: true } }, required: ['ids'], additionalProperties: false },
      annotations: { readOnlyHint: false },
      execute: input => {
        if (!input || typeof input !== 'object' || Object.keys(input).length !== 1 || !Array.isArray(input.ids) || input.ids.some(id => !inputs.has(id)) || new Set(input.ids).size !== input.ids.length) throw new Error('유효한 항목 ID 목록이 필요합니다.');
        selected.clear(); input.ids.forEach(id => selected.add(id)); render();
        return { reviewStatus: 'draft', selectedIds: modules.filter(item => selected.has(item.id)).map(item => item.id) };
      }
    }];
    registrations.forEach(tool => {
      try { Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => {}); } catch { /* 일반 화면은 계속 사용할 수 있습니다. */ }
    });
    window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
  }
})();
