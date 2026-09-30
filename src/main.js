// 页面状态与渲染。求解全部在 Web Worker 中完成；非法输入时合并展示并清除旧结论。
// 普通审计结论与“非侵入辨识复核”结论分栏并存；任一录入被修改后，非侵入结论立即失效。

const MAX_POS = 10;
const MIN_CODES = 2;
const MAX_CODES = 4;

const state = {
  codes: ['A', 'B'],
  positions: [
    { name: 'P1', cells: {} },
    { name: 'P2', cells: {} },
    { name: 'P3', cells: {} },
  ],
};

const $ = sel => document.querySelector(sel);
const codeList = $('#codeList');
const gridHead = $('#gridHead');
const gridBody = $('#gridBody');
const errBox = $('#errors');
const resultBox = $('#result');
const niBox = $('#niResult');
const niErrBox = $('#niErrors');
const statusEl = $('#workerStatus');

let worker = null;

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ev => {
    setBusy(null, false);
    if (ev.data.type === 'error') showErrors(ev.data.messages);
    else if (ev.data.type === 'result') showResult(ev.data.result);
    else if (ev.data.type === 'niResult') showNiResult(ev.data.result);
    else if (ev.data.type === 'niError') showNiErrors(ev.data.messages);
  };
  worker.onerror = e => {
    setBusy(null, false);
    showErrors([`Worker 运行失败：${e.message}`]);
  };
  return worker;
}

function setBusy(kind, busy) {
  if (kind === 'ni') $('#niReviewBtn').disabled = busy;
  else if (kind === 'audit') $('#auditBtn').disabled = busy;
  else {
    $('#auditBtn').disabled = busy;
    $('#niReviewBtn').disabled = busy;
  }
  statusEl.textContent = busy ? '搜索中…' : '';
}

/** 修改任一位置、探测码或定义后，非侵入结论立即失效（普通审计结论保留）。 */
function invalidateNonIntrusive() {
  niBox.classList.add('hidden');
  niBox.innerHTML = '';
  delete niBox.dataset.outcome;
  niErrBox.classList.add('hidden');
  niErrBox.innerHTML = '';
  delete niErrBox.dataset.outcome;
}

// ---- 录入渲染 -------------------------------------------------------------

function renderCodes() {
  codeList.innerHTML = '';
  state.codes.forEach((code, idx) => {
    const wrap = document.createElement('div');
    wrap.className = 'code-input';
    const label = document.createElement('label');
    label.textContent = `码 ${idx + 1}`;
    const input = document.createElement('input');
    input.value = code;
    input.dataset.codeIdx = idx;
    input.addEventListener('input', () => {
      const oldCode = state.codes[idx];
      const newCode = input.value;
      state.codes[idx] = newCode;
      // 迁移该码列下已录入的转移定义
      for (const pos of state.positions) {
        if (pos.cells[oldCode]) {
          pos.cells[newCode] = pos.cells[oldCode];
          delete pos.cells[oldCode];
        }
      }
      invalidateNonIntrusive();
      renderGrid(); // 表头与列随之变化
    });
    wrap.append(label, input);
    codeList.appendChild(wrap);
  });
  $('#addCode').disabled = state.codes.length >= MAX_CODES;
  $('#removeCode').disabled = state.codes.length <= MIN_CODES;
}

function renderGrid() {
  // 表头
  gridHead.innerHTML = '';
  const tr = document.createElement('tr');
  const th0 = document.createElement('th');
  th0.textContent = '位置 ＼ 探测码（回执 → 下一位置）';
  tr.appendChild(th0);
  state.codes.forEach(code => {
    const th = document.createElement('th');
    th.textContent = JSON.stringify(code) || '（空码）';
    tr.appendChild(th);
  });
  gridHead.appendChild(tr);

  // 表体
  gridBody.innerHTML = '';
  state.positions.forEach((pos, r) => {
    const tr = document.createElement('tr');
    const tdName = document.createElement('td');
    tdName.className = 'pos-col';
    const nameInput = document.createElement('input');
    nameInput.className = 'cell';
    nameInput.value = pos.name;
    nameInput.placeholder = '位置名';
    nameInput.addEventListener('input', () => {
      pos.name = nameInput.value;
      invalidateNonIntrusive();
    });
    tdName.appendChild(nameInput);
    tr.appendChild(tdName);

    state.codes.forEach(code => {
      const td = document.createElement('td');
      const cell = (pos.cells[code] ??= { response: '', next: '' });
      const rIn = document.createElement('input');
      rIn.className = 'cell';
      rIn.placeholder = '回执';
      rIn.value = cell.response;
      rIn.dataset.row = r;
      rIn.dataset.code = code;
      rIn.dataset.field = 'response';
      const nIn = document.createElement('input');
      nIn.className = 'cell';
      nIn.placeholder = '下一位置';
      nIn.value = cell.next;
      nIn.dataset.row = r;
      nIn.dataset.code = code;
      nIn.dataset.field = 'next';
      rIn.addEventListener('input', () => {
        cell.response = rIn.value;
        invalidateNonIntrusive();
      });
      nIn.addEventListener('input', () => {
        cell.next = nIn.value;
        invalidateNonIntrusive();
      });
      td.append(rIn, nIn);
      tr.appendChild(td);
    });
    gridBody.appendChild(tr);
  });
  $('#addPos').disabled = state.positions.length >= MAX_POS;
}

function reindexCells() {
  // 码被改名/增删后，把旧录入迁移到当前码集合（按位置对齐，无法对齐则丢弃）。
  // 简化策略：cell 以码为键，重渲染时只保留当前码；renderCodes input 已直接改键值，
  // 因此这里重建每个位置的 cells。
  for (const pos of state.positions) {
    const next = {};
    for (const code of state.codes) next[code] = pos.cells[code] ?? { response: '', next: '' };
    pos.cells = next;
  }
}

function addCode() {
  if (state.codes.length >= MAX_CODES) return;
  state.codes.push(String.fromCharCode(65 + state.codes.length));
  reindexCells();
  renderCodes();
  renderGrid();
  clearConclusions();
  invalidateNonIntrusive();
}
function removeCode() {
  if (state.codes.length <= MIN_CODES) return;
  state.codes.pop();
  reindexCells();
  renderCodes();
  renderGrid();
  clearConclusions();
  invalidateNonIntrusive();
}
function addPosition() {
  if (state.positions.length >= MAX_POS) return;
  const idx = state.positions.length + 1;
  const cells = {};
  for (const code of state.codes) cells[code] = { response: '', next: '' };
  state.positions.push({ name: `P${idx}`, cells });
  renderGrid();
  clearConclusions();
  invalidateNonIntrusive();
}

// ---- 收集输入 -------------------------------------------------------------

function gatherPayload() {
  const codes = state.codes.map(c => c);
  const positions = state.positions.map(p => p.name);
  const table = {};
  state.positions.forEach(pos => {
    table[pos.name] = {};
    state.codes.forEach(code => {
      const cell = pos.cells[code] ?? { response: '', next: '' };
      table[pos.name][code] = { response: cell.response, next: cell.next };
    });
  });
  return { positions, codes, table };
}

// ---- 结果展示 -------------------------------------------------------------

function clearConclusions() {
  errBox.classList.add('hidden');
  errBox.innerHTML = '';
  delete errBox.dataset.outcome;
  resultBox.classList.add('hidden');
  resultBox.innerHTML = '';
  delete resultBox.dataset.outcome;
}

function showErrors(messages) {
  // 非法输入：合并显示全部问题，并清除旧结论。
  clearConclusions();
  errBox.classList.remove('hidden');
  errBox.dataset.outcome = 'error';
  const h = document.createElement('h2');
  h.textContent = `输入不合法（${messages.length} 项），请修正后重新审计`;
  const ul = document.createElement('ul');
  ul.dataset.testid = 'error-list';
  messages.forEach(m => {
    const li = document.createElement('li');
    li.textContent = m;
    ul.appendChild(li);
  });
  errBox.append(h, ul);
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function showResult(r) {
  clearConclusions();
  resultBox.classList.remove('hidden');
  if (r.found) renderSuccess(r);
  else renderEquivalence(r);
}

function renderSuccess(r) {
  resultBox.dataset.outcome = 'success';
  const len = r.sequence.length;
  resultBox.appendChild(
    el('h3', {}, `✅ 存在规范探测串（长度 ${len}，最短；并列方案中 ASCII 字典序最小）`),
  );
  const box = document.createElement('div');
  box.className = 'seq-box';
  box.dataset.testid = 'sequence';
  if (len === 0) {
    box.textContent = '（仅一个位置，空序列即唯一识别）';
  } else {
    r.sequence.forEach((c, i) => {
      const chip = document.createElement('span');
      chip.className = 'seq-chip';
      chip.textContent = JSON.stringify(c);
      chip.title = `第 ${i + 1} 轮`;
      box.appendChild(chip);
    });
  }
  resultBox.appendChild(box);

  resultBox.appendChild(el('h3', {}, '每轮仍未分开的初态对'));
  const tbl = document.createElement('table');
  tbl.className = 'out';
  tbl.innerHTML =
    '<thead><tr><th>轮次</th><th>探测码</th><th>本轮前未分对</th><th>本轮被回执分开</th><th>本轮后仍未分</th></tr></thead>';
  const tb = document.createElement('tbody');
  if (r.trace.length === 0) {
    tb.innerHTML = '<tr><td colspan="5">无需探测轮次。</td></tr>';
  }
  for (const step of r.trace) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${step.round}</td>` +
      `<td class="pair">${esc(JSON.stringify(step.code))}</td>` +
      `<td>${step.unresolvedBefore.map(esc).join('<br>') || '—'}</td>` +
      `<td>${
        step.splitThisRound.map(p => `<span class="pair">${esc(p)}</span>`).join('<br>') ||
        '<span class="muted">—</span>'
      }</td>` +
      `<td>${step.unresolvedAfter.map(p => `<span class="pair">${esc(p)}</span>`).join('<br>') || '✅ 全部初态已分开'}</td>`;
    tb.appendChild(tr);
  }
  tbl.appendChild(tb);
  resultBox.appendChild(tbl);

  // 回溯链复算得到的每个初态完整回执串（独立复算证据）。
  resultBox.appendChild(
    el('h3', {}, '沿规范串复算：每个初态的完整回执串（两两不同）'),
  );
  const rt = document.createElement('table');
  rt.className = 'out';
  const rthead = document.createElement('tr');
  rthead.innerHTML = '<th>初态位置</th><th>逐轮回执</th>';
  rt.appendChild(rthead);
  for (const p of r.model.positions) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td class="pair">${esc(p)}</td>` +
      `<td class="pair">${r.receipts[p].map(esc).join(' , ') || '（空）'}</td>`;
    rt.appendChild(tr);
  }
  resultBox.appendChild(rt);
}

function renderEquivalence(r) {
  const eq = r.equivalence;
  resultBox.dataset.outcome = 'impossible';
  resultBox.appendChild(el('h3', {}, '❌ 不存在任何区分序列'));
  if (!eq) {
    resultBox.appendChild(el('p', { className: 'muted' }, '未能构造反例（内部错误）。'));
    return;
  }
  if (eq.kind === 'class') renderClassProof(eq);
  else renderStructuralProof(eq);
}

function renderClassProof(eq) {
  const [a, b] = eq.pair;
  const intro = document.createElement('p');
  intro.innerHTML =
    `最小化等价类反例：初态 <span class="pair bad">${esc(a)}</span> 与 ` +
    `<span class="pair bad">${esc(b)}</span>` +
    ` 对任意探测码序列的完整回执串始终相同。`;
  resultBox.appendChild(intro);

  resultBox.appendChild(
    el('p', { className: 'muted' },
      `二者同属最小化（最粗）等价类 {${eq.witnessClass.map(esc).join(', ')}}：` +
      '类内位置对每个码回执相同，且后继仍落在同一个等价类中；由归纳可知长度任意的码串都无法将它们分开。'),
  );

  const tbl = document.createElement('table');
  tbl.className = 'out';
  tbl.innerHTML =
    '<thead><tr><th>探测码</th><th>两者回执（相同）</th>' +
    `<th>${esc(a)} 的下一位置</th><th>${esc(b)} 的下一位置</th><th>后继仍在同一等价类</th></tr></thead>`;
  const tb = document.createElement('tbody');
  for (const ev of eq.evidence) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td class="pair">${esc(JSON.stringify(ev.code))}</td>` +
      `<td class="pair">${esc(ev.responseBoth)}</td>` +
      `<td class="pair">${esc(ev.nextI)}</td>` +
      `<td class="pair">${esc(ev.nextJ)}</td>` +
      `<td>${ev.successorsStillEquivalent ? '✅ 是' : '❌ 否'}</td>`;
    tb.appendChild(tr);
  }
  tbl.appendChild(tb);
  resultBox.appendChild(tbl);

  if (eq.allEquivalentPairs.length > 1) {
    const det = document.createElement('details');
    det.innerHTML = `<summary>全部不可区分初态对（${eq.allEquivalentPairs.length}）</summary>`;
    const ul = document.createElement('ul');
    eq.allEquivalentPairs.forEach(p => {
      const li = document.createElement('li');
      li.className = 'pair';
      li.textContent = p;
      ul.appendChild(li);
    });
    det.appendChild(ul);
    resultBox.appendChild(det);
  }
}

function renderStructuralProof(eq) {
  resultBox.appendChild(el('p', { className: 'muted' }, eq.explanation));
  const tbl = document.createElement('table');
  tbl.className = 'out';
  const codeSet = eq.states[0]?.branches.map(b => b.code) ?? [];
  tbl.innerHTML =
    '<thead><tr><th>状态</th><th>仍未分开的初态对</th>' +
    codeSet.map(c => `<th>码 ${esc(JSON.stringify(c))}</th>`).join('') +
    '</tr></thead>';
  const tb = document.createElement('tbody');
  for (const st of eq.states) {
    const tr = document.createElement('tr');
    let html =
      `<td class="pair">#${st.state}${st.state === 0 ? '（初态）' : ''}</td>` +
      `<td>${st.unresolvedPairs.map(p => `<span class="pair">${esc(p)}</span>`).join('<br>')}</td>`;
    for (const br of st.branches) {
      if (br.outcome === 'merge') {
        html +=
          `<td><span class="badge merge">轨迹重合</span><br>` +
          `<span class="pair">${br.mergedPairs.map(esc).join('<br>')}</span><br>` +
          `<span class="muted">此后永不可分</span></td>`;
      } else {
        html += `<td><span class="badge wait">转入状态 #${br.targetState}</span></td>`;
      }
    }
    tr.innerHTML = html;
    tb.appendChild(tr);
  }
  tbl.appendChild(tb);
  resultBox.appendChild(tbl);
}

function el(tag, attrs, text) {
  const node = document.createElement(tag);
  if (attrs) Object.assign(node, attrs);
  if (text != null) node.textContent = text;
  return node;
}

// ---- 非侵入辨识复核：结果展示 ---------------------------------------------
// 与普通审计结论完全独立：普通结论（#result/#errors）不被复核操作清除，
// 复核结论只写入 #niResult/#niErrors；录入修改后由 invalidateNonIntrusive 清除。

function clearNiPanel() {
  niErrBox.classList.add('hidden');
  niErrBox.innerHTML = '';
  delete niErrBox.dataset.outcome;
  niBox.classList.add('hidden');
  niBox.innerHTML = '';
  delete niBox.dataset.outcome;
}

function showNiErrors(messages) {
  clearNiPanel();
  niErrBox.classList.remove('hidden');
  niErrBox.dataset.outcome = 'error';
  const h = document.createElement('h2');
  h.textContent = `非侵入复核未受理（${messages.length} 项）`;
  const ul = document.createElement('ul');
  ul.dataset.testid = 'ni-error-list';
  messages.forEach(m => {
    const li = document.createElement('li');
    li.textContent = m;
    ul.appendChild(li);
  });
  niErrBox.append(h, ul);
}

function showNiResult(r) {
  clearNiPanel();
  niBox.classList.remove('hidden');
  if (r.found) renderNiSuccess(r);
  else renderNiClosed(r);
}

function renderNiSuccess(r) {
  niBox.dataset.outcome = 'success';
  const len = r.sequence.length;
  niBox.appendChild(
    el('h3', {}, `✅ 存在非侵入规范探测串（长度 ${len}，最短；并列方案中 ASCII 字典序最小）`),
  );
  niBox.appendChild(
    el(
      'p',
      { className: 'muted' },
      '整串执行后每个初态恰好回到自身位置，且不同初态的完整回执串两两不同；诊断结束无任何上电位置停留在别处。',
    ),
  );
  const box = document.createElement('div');
  box.className = 'seq-box';
  box.dataset.testid = 'ni-sequence';
  if (len === 0) {
    box.textContent = '（仅一个位置，空序列即唯一识别且无需移动）';
  } else {
    r.sequence.forEach((c, i) => {
      const chip = document.createElement('span');
      chip.className = 'seq-chip';
      chip.textContent = JSON.stringify(c);
      chip.title = `第 ${i + 1} 轮`;
      box.appendChild(chip);
    });
  }
  niBox.appendChild(box);

  niBox.appendChild(el('h3', {}, '逐轮：各初态当前所在位置映射 与 仍未分开的初态对'));
  const tbl = document.createElement('table');
  tbl.className = 'out';
  tbl.innerHTML =
    '<thead><tr><th>轮次</th><th>探测码</th><th>本轮前位置映射（初态→当前）</th>' +
    '<th>本轮后位置映射（初态→当前）</th><th>本轮被回执分开</th><th>本轮后仍未分</th></tr></thead>';
  const tb = document.createElement('tbody');
  if (r.trace.length === 0) tb.innerHTML = '<tr><td colspan="6">无需探测轮次。</td></tr>';
  for (const step of r.trace) {
    const fmtMap = m =>
      m
        .map(({ from, to }) =>
          from === to
            ? `<span class="pair">${esc(from)}→${esc(to)}</span>`
            : `<span class="pair bad">${esc(from)}→${esc(to)}</span>`,
        )
        .join('<br>');
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${step.round}</td>` +
      `<td class="pair">${esc(JSON.stringify(step.code))}</td>` +
      `<td>${fmtMap(step.mappingBefore)}</td>` +
      `<td>${fmtMap(step.mappingAfter)}${step.identityAfter ? '<br><span class="muted">已恒等</span>' : ''}</td>` +
      `<td>${
        step.splitThisRound.map(p => `<span class="pair">${esc(p)}</span>`).join('<br>') ||
        '<span class="muted">—</span>'
      }</td>` +
      `<td>${step.unresolvedAfter.map(p => `<span class="pair">${esc(p)}</span>`).join('<br>') || '✅ 无未分对'}</td>`;
    tb.appendChild(tr);
  }
  tbl.appendChild(tb);
  niBox.appendChild(tbl);

  niBox.appendChild(el('h3', {}, '沿规范串复算：每个初态的完整回执串与终局位置'));
  const rt = document.createElement('table');
  rt.className = 'out';
  rt.innerHTML = '<thead><tr><th>初态位置</th><th>逐轮回执</th><th>终局位置</th></tr></thead>';
  const rtb = document.createElement('tbody');
  for (const p of r.model.positions) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td class="pair">${esc(p)}</td>` +
      `<td class="pair">${r.receipts[p].map(esc).join(' , ') || '（空）'}</td>` +
      `<td class="pair ${r.endAt[p] === p ? 'ok' : 'bad'}">${esc(r.endAt[p])}${
        r.endAt[p] === p ? ' ✅ 回到自身' : ' ❌ 未复位'
      }</td>`;
    rtb.appendChild(tr);
  }
  rt.appendChild(rtb);
  niBox.appendChild(rt);
}

function renderNiClosed(r) {
  niBox.dataset.outcome = 'impossible';
  const cs = r.closedSearch;
  niBox.appendChild(el('h3', {}, '❌ 不存在满足非侵入约束的固定探测串'));
  niBox.appendChild(el('p', { className: 'muted' }, cs.explanation));

  const req = document.createElement('p');
  req.innerHTML =
    '终态须同时满足：<ol style="margin:4px 0 0 18px">' +
    cs.terminalRequirements.map(t => `<li>${esc(t)}</li>`).join('') +
    '</ol>';
  niBox.appendChild(req);

  niBox.appendChild(
    el('h3', {}, `闭合搜索范围：${cs.states.length} 个可达复合状态（映射 × 未分初态对）`),
  );
  const tbl = document.createElement('table');
  tbl.className = 'out';
  const codeCols = cs.states[0]?.branches.map(b => b.code) ?? [];
  tbl.innerHTML =
    '<thead><tr><th>状态</th><th>位置映射（初态→当前）</th><th>未分初态对</th><th>未满足的终态条件</th>' +
    codeCols.map(c => `<th>码 ${esc(JSON.stringify(c))}</th>`).join('') +
    '</tr></thead>';
  const tb = document.createElement('tbody');
  for (const st of cs.states) {
    const tr = document.createElement('tr');
    const mapHtml = st.mapping
      .map(({ from, to }) =>
        from === to
          ? `<span class="pair">${esc(from)}→${esc(to)}</span>`
          : `<span class="pair bad">${esc(from)}→${esc(to)}</span>`,
      )
      .join('<br>');
    const unmetHtml = st.unmetConditions
      .map(u =>
        u === 'mapping'
          ? '<span class="badge merge">映射非恒等</span>'
          : '<span class="badge merge">仍有未分对</span>',
      )
      .join('<br>');
    let html =
      `<td class="pair">#${st.state}${st.state === 0 ? '（初态）' : ''}</td>` +
      `<td>${mapHtml}</td>` +
      `<td>${st.unresolvedPairs.map(p => `<span class="pair">${esc(p)}</span>`).join('<br>') || '—'}</td>` +
      `<td>${unmetHtml}</td>`;
    for (const br of st.branches) {
      if (br.outcome === 'merge') {
        html +=
          `<td><span class="badge merge">轨迹重合</span><br>` +
          `<span class="pair">${br.mergedPairs.map(esc).join('<br>')}</span><br>` +
          `<span class="muted">此后永不可分</span></td>`;
      } else {
        html += `<td><span class="badge wait">转入状态 #${br.targetState}</span></td>`;
      }
    }
    tr.innerHTML = html;
    tb.appendChild(tr);
  }
  tbl.appendChild(tb);
  niBox.appendChild(tbl);
}

// ---- 示例 -----------------------------------------------------------------

function loadDemo() {
  // 三位置：单码都不足以识别（A 分不开 P1/P2，B 分不开 P1/P3），
  // 规范最短区分序列为 AB：A 先分出 P3，B 再把 P1/P2 分开。
  state.codes = ['A', 'B'];
  const T = (response, next) => ({ response, next });
  const rows = {
    P1: { A: T('0', 'P1'), B: T('0', 'P1') },
    P2: { A: T('0', 'P2'), B: T('1', 'P2') },
    P3: { A: T('1', 'P1'), B: T('0', 'P3') },
  };
  state.positions = Object.keys(rows).map(name => ({ name, cells: rows[name] }));
  renderCodes();
  renderGrid();
  clearConclusions();
  invalidateNonIntrusive();
}

function clearAll() {
  state.codes = ['A', 'B'];
  state.positions = [{ name: 'P1', cells: {} }, { name: 'P2', cells: {} }];
  reindexCells();
  renderCodes();
  renderGrid();
  clearConclusions();
  invalidateNonIntrusive();
}

// ---- 事件 -----------------------------------------------------------------

$('#addCode').addEventListener('click', addCode);
$('#removeCode').addEventListener('click', removeCode);
$('#addPos').addEventListener('click', addPosition);
$('#loadDemo').addEventListener('click', loadDemo);
$('#clearAll').addEventListener('click', clearAll);
$('#auditBtn').addEventListener('click', () => {
  clearConclusions();
  setBusy('audit', true);
  ensureWorker().postMessage({ type: 'audit', payload: gatherPayload() });
});
$('#niReviewBtn').addEventListener('click', () => {
  // 非侵入复核在普通审计结论旁发起：不清空、不覆盖普通结论与逐轮记录。
  clearNiPanel();
  setBusy('ni', true);
  ensureWorker().postMessage({ type: 'nonIntrusiveReview', payload: gatherPayload() });
});

renderCodes();
renderGrid();
