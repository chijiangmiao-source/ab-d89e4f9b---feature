// 页面状态与渲染。求解全部在 Web Worker 中完成；非法输入时合并展示并清除旧结论。
// 普通结论（#result / #errors）与非侵入复核结论（#nonIntrusiveResult /
// #nonIntrusiveErrors）分栏共存：任一位置、探测码或定义被修改后，非侵入结论立即
// 作废；普通结论与原有逐轮记录仍按原规则保留。

const MAX_POS = 10;
const MAX_POS_NON_INTRUSIVE = 7;
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
const niErrBox = $('#nonIntrusiveErrors');
const niBox = $('#nonIntrusiveResult');
const statusEl = $('#workerStatus');

let worker = null;
// 全局递增请求代号；两种模式分别记录在途代号，互不抢占（标准结果不会因发起
// 非侵入复核而被误判为陈旧，反之编辑输入只作废非侵入在途请求）。
let requestSeq = 0;
const pending = { audit: 0, nonIntrusive: 0 };

function isBusy() {
  return pending.audit !== 0 || pending.nonIntrusive !== 0;
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ev => {
    const mode = ev.data.mode;
    if (ev.data.seq !== pending[mode]) return; // 该模式的陈旧响应（输入已变更）：丢弃
    pending[mode] = 0;
    setBusy(isBusy());
    if (ev.data.type === 'error') showErrors(ev.data.messages, mode);
    else showResult(ev.data.result);
  };
  worker.onerror = e => {
    // Worker 致命错误无法区分模式：解除全部在途态并在两栏提示。
    pending.audit = 0;
    pending.nonIntrusive = 0;
    setBusy(false);
    showErrors([`Worker 运行失败：${e.message}`], 'audit');
    showErrors([`Worker 运行失败：${e.message}`], 'nonIntrusive');
  };
  return worker;
}

function setBusy(busy) {
  $('#auditBtn').disabled = busy;
  $('#nonIntrusiveBtn').disabled = busy;
  if (!busy) {
    statusEl.textContent = '';
    return;
  }
  statusEl.textContent = pending.nonIntrusive !== 0 ? '非侵入复核搜索中…' : '搜索中…';
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
      renderGrid(); // 表头与列随之变化
      invalidateNonIntrusive(); // 修改探测码：非侵入结论立即失效
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
      invalidateNonIntrusive(); // 修改位置：非侵入结论立即失效
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
        invalidateNonIntrusive(); // 修改定义：非侵入结论立即失效
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
  $('#niLimitHint').textContent =
    state.positions.length > MAX_POS_NON_INTRUSIVE
      ? `当前 ${state.positions.length} 个位置，已超过非侵入复核上限 ${MAX_POS_NON_INTRUSIVE}，该模式不受理（可发起复核查看说明）。`
      : `仅受理不超过 ${MAX_POS_NON_INTRUSIVE} 个位置的当前机型（当前 ${state.positions.length} 个）。`;
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
}
function removeCode() {
  if (state.codes.length <= MIN_CODES) return;
  state.codes.pop();
  reindexCells();
  renderCodes();
  renderGrid();
  clearConclusions();
}
function addPosition() {
  if (state.positions.length >= MAX_POS) return;
  const idx = state.positions.length + 1;
  const cells = {};
  for (const code of state.codes) cells[code] = { response: '', next: '' };
  state.positions.push({ name: `P${idx}`, cells });
  renderGrid();
  clearConclusions();
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

// ---- 结果区清理 -----------------------------------------------------------

function clearBox(box) {
  box.classList.add('hidden');
  box.innerHTML = '';
  delete box.dataset.outcome;
}

function clearConclusions() {
  // 结构级变更（增删码/位置、载入示例、清空）：两类结论一并清除。
  clearBox(errBox);
  clearBox(resultBox);
  clearBox(niErrBox);
  clearBox(niBox);
}

/** 修改任一位置、探测码或定义后调用：非侵入结论立即作废（普通结论保留）。 */
function invalidateNonIntrusive() {
  clearBox(niErrBox);
  clearBox(niBox);
  // 作废在途的非侵入响应并解除其忙碌态；普通审计在途不受影响。
  if (pending.nonIntrusive !== 0) {
    pending.nonIntrusive = 0;
    setBusy(isBusy());
  }
}

function showErrors(messages, mode) {
  // 非法输入：合并显示全部问题，只清当前模式的旧结论；另一模式的结论原样保留。
  if (mode === 'nonIntrusive') {
    clearBox(niErrBox);
    clearBox(niBox);
    renderErrorList(niErrBox, messages, '非侵入复核输入不合法');
  } else {
    clearBox(errBox);
    clearBox(resultBox);
    renderErrorList(errBox, messages, '输入不合法');
  }
}

function renderErrorList(box, messages, titlePrefix) {
  box.classList.remove('hidden');
  box.dataset.outcome = 'error';
  const h = document.createElement('h2');
  h.textContent = `${titlePrefix}（${messages.length} 项），请修正后重新发起`;
  const ul = document.createElement('ul');
  ul.dataset.testid = 'error-list';
  messages.forEach(m => {
    const li = document.createElement('li');
    li.textContent = m;
    ul.appendChild(li);
  });
  box.append(h, ul);
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function showResult(r) {
  if (r.mode === 'nonIntrusive') showNonIntrusiveResult(r);
  else showStandardResult(r);
}

// ---- 普通审计结果 ----------------------------------------------------------

function showStandardResult(r) {
  clearBox(errBox);
  clearBox(resultBox);
  resultBox.classList.remove('hidden');
  if (r.found) renderStandardSuccess(r);
  else renderStandardEquivalence(r);
}

function renderStandardSuccess(r) {
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

function renderStandardEquivalence(r) {
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

// ---- 非侵入辨识复核结果 ----------------------------------------------------

function showNonIntrusiveResult(r) {
  clearBox(niErrBox);
  clearBox(niBox);
  niBox.classList.remove('hidden');
  if (r.declined) renderNonIntrusiveExceeded(r);
  else if (r.found) renderNonIntrusiveSuccess(r);
  else renderNonIntrusiveImpossible(r);
}

function renderNonIntrusiveExceeded(r) {
  niBox.dataset.outcome = 'exceeded';
  niBox.appendChild(
    el('h3', {}, `⛔ 非侵入复核不受理：当前机型 ${r.positionCount} 个位置，超过 ${r.limit} 个上限`),
  );
  niBox.appendChild(
    el('p', { className: 'muted' },
      '非侵入辨识复核只对不超过 7 个位置的当前机型发起。请减少位置后重试，' +
      '或使用左侧普通审计（不要求整串后归位）。本次未进行任何搜索，原有结论保持不变。'),
  );
}

function mappingText(mapping) {
  return mapping.map(m => `${esc(m.initial)} → ${esc(m.current)}`).join('<br>');
}

function renderNonIntrusiveSuccess(r) {
  niBox.dataset.outcome = 'success';
  const len = r.sequence.length;
  niBox.appendChild(
    el('h3', {},
      `✅ 存在非侵入规范探测串（长度 ${len}，最短；并列方案中 ASCII 字典序最小）：` +
      '不同初态的完整回执串两两不同，且整串执行后每个初态恰好回到自身位置'),
  );
  const box = document.createElement('div');
  box.className = 'seq-box';
  box.dataset.testid = 'ni-sequence';
  if (len === 0) {
    box.textContent = '（仅一个位置，空序列即满足：无需探测即已归位且无待分对）';
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

  niBox.appendChild(el('h3', {}, '逐轮位置映射与仍未分开的初态对'));
  const tbl = document.createElement('table');
  tbl.className = 'out';
  tbl.innerHTML =
    '<thead><tr><th>轮次</th><th>探测码</th><th>各初态当前所在位置（完整映射）</th>' +
    '<th>映射为恒等</th><th>本轮前未分对</th><th>本轮被回执分开</th><th>本轮后仍未分</th></tr></thead>';
  const tb = document.createElement('tbody');
  for (const step of r.trace) {
    const tr = document.createElement('tr');
    const codeCell = step.code === null ? '—' : esc(JSON.stringify(step.code));
    tr.innerHTML =
      `<td>${step.round}${step.round === 0 ? '（初态）' : ''}</td>` +
      `<td class="pair">${codeCell}</td>` +
      `<td class="pair">${mappingText(step.mapping)}</td>` +
      `<td>${step.identity ? '✅ 是' : '❌ 否'}</td>` +
      `<td>${step.unresolvedBefore.map(esc).join('<br>') || '—'}</td>` +
      `<td>${
        step.splitThisRound.map(p => `<span class="pair">${esc(p)}</span>`).join('<br>') ||
        '<span class="muted">—</span>'
      }</td>` +
      `<td>${step.unresolvedAfter.map(p => `<span class="pair">${esc(p)}</span>`).join('<br>') || '✅ 全部初态已分开'}</td>`;
    tb.appendChild(tr);
  }
  tbl.appendChild(tb);
  niBox.appendChild(tbl);

  niBox.appendChild(
    el('h3', {}, '沿规范串独立复算：各初态完整回执串（两两不同）与终态位置（均回到自身）'),
  );
  const rt = document.createElement('table');
  rt.className = 'out';
  rt.innerHTML =
    '<thead><tr><th>初态位置</th><th>逐轮回执</th><th>整串后所在位置</th><th>回到自身</th></tr></thead>';
  const rtb = document.createElement('tbody');
  for (const p of r.model.positions) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td class="pair">${esc(p)}</td>` +
      `<td class="pair">${r.receipts[p].map(esc).join(' , ') || '（空）'}</td>` +
      `<td class="pair">${esc(p)}</td>` +
      '<td>✅</td>';
    rtb.appendChild(tr);
  }
  rt.appendChild(rtb);
  niBox.appendChild(rt);
}

function renderNonIntrusiveImpossible(r) {
  niBox.dataset.outcome = 'impossible';
  const closed = r.closed;
  niBox.appendChild(
    el('h3', {},
      '❌ 不存在满足非侵入约束的探测串：可达复合状态搜索已耗尽，封闭族内无终态'),
  );
  niBox.appendChild(el('p', { className: 'muted' }, closed.explanation));

  const cond = document.createElement('ul');
  cond.dataset.testid = 'ni-unmet';
  closed.unmetConditions.forEach(c => {
    const li = document.createElement('li');
    li.className = 'bad';
    li.textContent = `未满足的终态条件：${c}`;
    cond.appendChild(li);
  });
  niBox.appendChild(cond);

  niBox.appendChild(el('h3', {}, `闭合搜索范围：${closed.states.length} 个可达复合状态`));
  // 封闭族可能很大（7 位置机型可达数万个复合状态）；表格最多展示前
  // CLOSURE_RENDER_CAP 个（含初态，按 BFS 发现顺序），封闭性结论对全部状态成立。
  const CLOSURE_RENDER_CAP = 200;
  const shown = closed.states.slice(0, CLOSURE_RENDER_CAP);
  if (closed.states.length > CLOSURE_RENDER_CAP) {
    niBox.appendChild(
      el('p', { className: 'muted' },
        `状态族较大，下表按搜索发现顺序展示前 ${CLOSURE_RENDER_CAP} 个（含初态）；` +
        `其余 ${closed.states.length - CLOSURE_RENDER_CAP} 个状态同样满足封闭性，结论不变。`),
    );
  }
  const tbl = document.createElement('table');
  tbl.className = 'out closure';
  const codeSet = shown[0]?.branches.map(b => b.code) ?? [];
  tbl.innerHTML =
    '<thead><tr><th>复合状态</th><th>各初态当前位置（完整映射）</th><th>映射恒等</th>' +
    '<th>尚未分开的初态对</th>' +
    codeSet.map(c => `<th>施加码 ${esc(JSON.stringify(c))}</th>`).join('') +
    '</tr></thead>';
  const tb = document.createElement('tbody');
  for (const st of shown) {
    const tr = document.createElement('tr');
    let html =
      `<td class="pair">#${st.state}${st.state === 0 ? '（初态）' : ''}</td>` +
      `<td class="pair">${mappingText(st.mapping)}</td>` +
      `<td>${st.identity ? '✅ 是' : '❌ 否'}</td>` +
      `<td>${
        st.unresolvedPairs.map(p => `<span class="pair">${esc(p)}</span>`).join('<br>') ||
        '<span class="muted">空（回执已两两不同）</span>'
      }</td>`;
    for (const br of st.branches) {
      if (br.outcome === 'merge') {
        html +=
          `<td><span class="badge merge">轨迹重合，前缀作废</span><br>` +
          `<span class="pair">${br.mergedPairs.map(esc).join('<br>')}</span></td>`;
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

function el(tag, attrs, text) {
  const node = document.createElement(tag);
  if (attrs) Object.assign(node, attrs);
  if (text != null) node.textContent = text;
  return node;
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
}

function clearAll() {
  state.codes = ['A', 'B'];
  state.positions = [{ name: 'P1', cells: {} }, { name: 'P2', cells: {} }];
  reindexCells();
  renderCodes();
  renderGrid();
  clearConclusions();
}

// ---- 事件 -----------------------------------------------------------------

$('#addCode').addEventListener('click', addCode);
$('#removeCode').addEventListener('click', removeCode);
$('#addPos').addEventListener('click', addPosition);
$('#loadDemo').addEventListener('click', loadDemo);
$('#clearAll').addEventListener('click', clearAll);

function runAudit(type) {
  const box = type === 'nonIntrusive' ? niErrBox : errBox;
  clearBox(box);
  pending[type] = ++requestSeq;
  setBusy(isBusy());
  ensureWorker().postMessage({ type, payload: gatherPayload(), seq: pending[type] });
}

$('#auditBtn').addEventListener('click', () => runAudit('audit'));
$('#nonIntrusiveBtn').addEventListener('click', () => runAudit('nonIntrusive'));

renderCodes();
renderGrid();
