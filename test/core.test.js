import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  audit,
  nonIntrusiveReview,
  validateInput,
  ValidationError,
  buildPairs,
  pairIndex,
  applyCode,
  precompute,
  NON_INTRUSIVE_MAX_POS,
} from '../src/audit.js';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 构造机型：rows[state][code] = [response, next] */
function machine(states, codes, rows) {
  const table = {};
  for (const s of states) {
    table[s] = {};
    for (const c of codes) table[s][c] = { response: rows[s][c][0], next: rows[s][c][1] };
  }
  return { positions: states, codes, table };
}

/** 暴力预言机：按长度升序、同长度按 ASCII 字典序枚举所有码序列。 */
function oracle(model, maxDepth) {
  const { positions, codes, table } = model;
  const receipt = (p, seq) => {
    const out = [];
    let cur = p;
    for (const c of seq) {
      out.push(table[cur][c].response);
      cur = table[cur][c].next;
    }
    return out.join('|');
  };
  const distinguishes = seq => {
    const seen = new Set();
    for (const p of positions) {
      const k = receipt(p, seq);
      if (seen.has(k)) return false;
      seen.add(k);
    }
    return true;
  };
  let level = [[]];
  for (let d = 0; d <= maxDepth; d++) {
    for (const seq of level) if (distinguishes(seq)) return seq;
    level = level.flatMap(seq => codes.map(c => [...seq, c]));
  }
  return null;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// ---------------------------------------------------------------------------
// 对位下标一致性
// ---------------------------------------------------------------------------

test('pairIndex 与 buildPairs 枚举顺序一致', () => {
  for (const n of [2, 3, 5, 10]) {
    const pairs = buildPairs(n);
    pairs.forEach(([i, j], k) => assert.equal(pairIndex(i, j, n), k));
    assert.equal(pairs.length, (n * (n - 1)) / 2);
  }
});

// ---------------------------------------------------------------------------
// 规范示例：最短 + ASCII 字典序
// ---------------------------------------------------------------------------

test('示例机型：最短区分序列为 AB（长度 2，单码均不足）', () => {
  const m = machine(['P1', 'P2', 'P3'], ['A', 'B'], {
    P1: { A: ['0', 'P1'], B: ['0', 'P1'] },
    P2: { A: ['0', 'P2'], B: ['1', 'P2'] },
    P3: { A: ['1', 'P1'], B: ['0', 'P3'] },
  });
  const r = audit(m);
  assert.equal(r.found, true);
  assert.deepEqual(r.sequence, ['A', 'B']);
  // 完整回执两两不同
  assert.deepEqual(r.receipts.P1, ['0', '0']);
  assert.deepEqual(r.receipts.P2, ['0', '1']);
  assert.deepEqual(r.receipts.P3, ['1', '0']);
  // 逐步复算明细
  assert.equal(r.trace.length, 2);
  assert.deepEqual(r.trace[0].splitThisRound, ['P1 / P3', 'P2 / P3']);
  assert.deepEqual(r.trace[0].unresolvedAfter, ['P1 / P2']);
  assert.deepEqual(r.trace[1].splitThisRound, ['P1 / P2']);
  assert.equal(r.trace[1].unresolvedAfter.length, 0);
});

test('码录入顺序不影响结果：始终按 ASCII 排序求解', () => {
  const m = machine(['X', 'Y'], ['B', 'A'], {
    X: { A: ['0', 'X'], B: ['0', 'X'] },
    Y: { A: ['1', 'Y'], B: ['1', 'Y'] },
  });
  const r = audit(m);
  assert.deepEqual(r.sequence, ['A']); // A、B 都可行，取 ASCII 较小者
});

test('单个位置：空序列即唯一识别', () => {
  const m = machine(['S'], ['A', 'B'], {
    S: { A: ['0', 'S'], B: ['1', 'S'] },
  });
  const r = audit(m);
  assert.equal(r.found, true);
  assert.deepEqual(r.sequence, []);
  assert.deepEqual(r.trace, []);
});

// ---------------------------------------------------------------------------
// 轨迹重合剪枝：朴素地“丢掉”重合对会把死分支误判为成功
// ---------------------------------------------------------------------------

test('轨迹重合分支必须剪枝：三对均可自适应区分但不存在预设区分序列', () => {
  // A 下 P1/P2 同回执且后继重合（P1）；B 下 P1/P3 同回执且后继重合（P3）。
  // 任意长度 1 前缀都至少杀死一对，但三位置的输出向量两两不同（自适应可分）。
  const m = machine(['P1', 'P2', 'P3'], ['A', 'B'], {
    P1: { A: ['0', 'P1'], B: ['0', 'P3'] },
    P2: { A: ['0', 'P1'], B: ['1', 'P3'] },
    P3: { A: ['1', 'P1'], B: ['0', 'P3'] },
  });
  const r = audit(m);
  assert.equal(r.found, false);
  // 预言机枚举到较深深度同样找不到
  assert.equal(oracle(m, 6), null);
  // 机型已最小（无观测等价类）：必须给结构性封闭证明而非等价类
  assert.equal(r.equivalence.kind, 'structural');
  assert.ok(r.equivalence.states.length >= 1);
  // 初态状态含全部三对；每个分支要么重合要么指向族内非空状态
  for (const st of r.equivalence.states) {
    for (const br of st.branches) {
      if (br.outcome === 'move') {
        assert.ok(br.targetState !== null);
        assert.ok(br.targetState < r.equivalence.states.length);
      } else {
        assert.equal(br.outcome, 'merge');
        assert.ok(br.mergedPairs.length >= 1);
      }
    }
  }
  // 至少存在一个重合分支（否则族不封闭、应该能继续走向空状态）
  const merges = r.equivalence.states.flatMap(s =>
    s.branches.filter(b => b.outcome === 'merge'),
  );
  assert.ok(merges.length >= 1);
});

// ---------------------------------------------------------------------------
// 等价类反例
// ---------------------------------------------------------------------------

test('完全相同的两行：最小化等价类反例与逐码证据', () => {
  const m = machine(['P1', 'P2'], ['A', 'B'], {
    P1: { A: ['0', 'P2'], B: ['x', 'P1'] },
    P2: { A: ['0', 'P2'], B: ['x', 'P1'] },
  });
  const r = audit(m);
  assert.equal(r.found, false);
  assert.deepEqual(r.equivalence.pair, ['P1', 'P2']);
  assert.deepEqual(r.equivalence.witnessClass, ['P1', 'P2']);
  for (const ev of r.equivalence.evidence) {
    assert.equal(ev.successorsStillEquivalent, true);
  }
});

test('三位置中两者等价：反例只含等价的一对', () => {
  const m = machine(['P1', 'P2', 'P3'], ['A', 'B'], {
    P1: { A: ['0', 'P1'], B: ['0', 'P1'] },
    P2: { A: ['0', 'P2'], B: ['0', 'P2'] },
    P3: { A: ['1', 'P3'], B: ['1', 'P3'] },
  });
  const r = audit(m);
  assert.equal(r.found, false);
  assert.deepEqual(r.equivalence.pair, ['P1', 'P2']);
  assert.deepEqual(r.equivalence.allEquivalentPairs, ['P1 / P2']);
});

test('等价但后继相互跳转：后继始终同属一个等价类', () => {
  const m = machine(['P1', 'P2'], ['A'], {
    P1: { A: ['z', 'P2'] },
    P2: { A: ['z', 'P1'] },
  });
  // 只有一个码会触发校验错误（>=2），直接调核心不可行，故给两个完全同效的码
  const m2 = machine(['P1', 'P2'], ['A', 'B'], {
    P1: { A: ['z', 'P2'], B: ['z', 'P2'] },
    P2: { A: ['z', 'P1'], B: ['z', 'P1'] },
  });
  const r = audit(m2);
  assert.equal(r.found, false);
  assert.deepEqual(r.equivalence.pair, ['P1', 'P2']);
  assert.ok(r.equivalence.evidence.every(e => e.successorsStillEquivalent));
  void m;
});

// ---------------------------------------------------------------------------
// 非法输入：合并报告、非确定定义
// ---------------------------------------------------------------------------

test('非法输入合并显示：缺失转移 + 下一位置越界', () => {
  const raw = {
    positions: ['P1', 'P2'],
    codes: ['A', 'B'],
    table: {
      P1: { A: { response: '0', next: 'P1' } /* 缺 B */ },
      P2: { A: { response: '1', next: 'P2' }, B: { response: '0', next: 'X' } },
    },
  };
  assert.throws(
    () => audit(raw),
    err => {
      assert.ok(err instanceof ValidationError);
      assert.ok(err.messages.some(m => m.includes('缺失转移')));
      assert.ok(err.messages.some(m => m.includes('不在声明位置列表')));
      return true;
    },
  );
});

test('重复位置名与空位置合并报告', () => {
  const raw = {
    positions: ['P1', 'P1', '  '],
    codes: ['A', 'B'],
    table: { P1: { A: { response: '0', next: 'P1' }, B: { response: '0', next: 'P1' } } },
  };
  assert.throws(
    () => validateInput(raw),
    err =>
      err.messages.some(m => m.includes('位置名重复')) &&
      err.messages.some(m => m.includes('空位置名')),
  );
});

test('空码表 / 码数不足 / 码数超限 / 非 ASCII', () => {
  const base = {
    positions: ['P1'],
    codes: [],
    table: { P1: {} },
  };
  assert.throws(() => validateInput(base), /探测码表为空/);
  assert.throws(
    () => validateInput({ positions: ['P1'], codes: ['A'], table: { P1: {} } }),
    /至少需要 2 个/,
  );
  assert.throws(
    () =>
      validateInput({
        positions: ['P1'],
        codes: ['A', 'B', 'C', 'D', 'E'],
        table: { P1: {} },
      }),
    /至多 4 个/,
  );
  assert.throws(
    () => validateInput({ positions: ['P1', 'P2'], codes: ['码', 'B'], table: {} }),
    /不是纯 ASCII/,
  );
});

test('非确定定义：同一位置/码给多条回执', () => {
  const raw = {
    positions: ['P1', 'P2'],
    codes: ['A', 'B'],
    table: {
      P1: {
        A: [
          { response: '0', next: 'P1' },
          { response: '1', next: 'P2' },
        ],
        B: { response: '0', next: 'P1' },
      },
      P2: {
        A: { response: '0', next: 'P1' },
        B: { response: '1', next: 'P2' },
      },
    },
  };
  assert.throws(
    () => audit(raw),
    err => err.messages.some(m => m.includes('非确定定义')),
  );
});

test('缺失回执与重复探测码合并报告', () => {
  const raw = {
    positions: ['P1', 'P2'],
    codes: ['A', 'A'],
    table: {
      P1: { A: { response: '', next: 'P1' } },
      P2: { A: { response: '1', next: 'P2' } },
    },
  };
  assert.throws(
    () => audit(raw),
    err =>
      err.messages.some(m => m.includes('探测码重复')) &&
      err.messages.some(m => m.includes('缺失回执')),
  );
});

// ---------------------------------------------------------------------------
// applyCode 语义：split / merged / 后继映射
// ---------------------------------------------------------------------------

test('applyCode：区分、重合、后继映射三类处理正确', () => {
  const m = machine(['P1', 'P2', 'P3'], ['A', 'B'], {
    P1: { A: ['0', 'P1'], B: ['0', 'P1'] },
    P2: { A: ['1', 'P1'], B: ['0', 'P1'] }, // A 与 P1 回执不同；B 与 P1 重合
    P3: { A: ['0', 'P2'], B: ['0', 'P2'] }, // A 与 P1 同回执，后继对 P1/P2
  });
  const normalized = validateInput(m);
  normalized.codes.sort();
  const ctx = { ...precompute(normalized), n: 3 };
  const all = (1n << 3n) - 1n; // 对: P1P2=0, P1P3=1, P2P3=2
  const a = applyCode(all, 0, ctx);
  assert.deepEqual(a.split, [0, 2]); // P1/P2、P2/P3 回执不同
  assert.deepEqual(a.merged, []);
  assert.equal(a.mask, 1n << BigInt(pairIndex(0, 1, 3))); // P1/P3 -> 后继 P1/P2
  assert.equal(a.dead, false);
  const b = applyCode(all, 1, ctx);
  // P1/P2 同回执且后继重合于 P1；P1/P3、P2/P3 同回执映射到后继对 P1/P2
  assert.deepEqual(b.merged, [0]);
  assert.equal(b.mask, 1n << BigInt(pairIndex(0, 1, 3)));
  assert.equal(b.dead, true);
});

// ---------------------------------------------------------------------------
// 随机机型对拍：BFS 结果（存在性/最短长度/字典序序列）必须与暴力枚举一致
// ---------------------------------------------------------------------------

/**
 * 独立验证无解反例：
 *  - class：witness 对在所有长度 <=bound 的码串下回执必须完全相同；
 *  - structural：按给出的未分对列表重建 mask 状态族，用 applyCode 独立复核
 *    每个码要么重合（dead），要么目标状态仍在族内且非空。
 */
function verifyImpossibilityWitness(m, r, bound, trial) {
  const eq = r.equivalence;
  if (eq.kind === 'class') {
    const [x, y] = eq.pair;
    let level = [[]];
    for (let d = 0; d <= bound; d++) {
      for (const seq of level) {
        const rx = [];
        const ry = [];
        let cx = x;
        let cy = y;
        for (const cc of seq) {
          rx.push(m.table[cx][cc].response);
          ry.push(m.table[cy][cc].response);
          cx = m.table[cx][cc].next;
          cy = m.table[cy][cc].next;
        }
        assert.deepEqual(rx, ry, `trial ${trial} 等价对在序列 ${seq.join('')} 下被分开`);
      }
      level = level.flatMap(seq => m.codes.map(c => [...seq, c]));
    }
    return;
  }
  assert.equal(eq.kind, 'structural', `trial ${trial}：未知反例类型`);
  const normalized = validateInput(m);
  normalized.codes.sort();
  const ctx = { ...precompute(normalized), n: normalized.positions.length };
  const pairNames = buildPairs(normalized.positions.length).map(
    ([i, j]) => `${normalized.positions[i]} / ${normalized.positions[j]}`,
  );
  const fromPairs = list => {
    let mask = 0n;
    for (const name0 of list) {
      const k = pairNames.indexOf(name0);
      assert.ok(k >= 0, `trial ${trial}：反例含未知对 ${name0}`);
      mask |= 1n << BigInt(k);
    }
    return mask;
  };
  const masks = eq.states.map(st => fromPairs(st.unresolvedPairs));
  assert.equal(masks[0], (1n << BigInt(pairNames.length)) - 1n, `trial ${trial}：初态必须是全对集合`);
  for (const st of eq.states) {
    const mask = masks[st.state];
    for (const br of st.branches) {
      const ci = normalized.codes.indexOf(br.code);
      const res = applyCode(mask, ci, ctx);
      if (br.outcome === 'merge') {
        assert.equal(res.dead, true, `trial ${trial}：状态 ${st.state} 码 ${br.code} 应为重合`);
      } else {
        assert.equal(res.dead, false, `trial ${trial}：状态 ${st.state} 码 ${br.code} 不应重合`);
        assert.notEqual(res.mask, 0n, `trial ${trial}：结构性证明中出现了到空状态的边`);
        assert.ok(
          masks.includes(res.mask),
          `trial ${trial}：状态 ${st.state} 码 ${br.code} 指向族外状态`,
        );
        assert.equal(masks.indexOf(res.mask), br.targetState);
      }
    }
  }
}

test('随机机型 ×60：与暴力枚举预言机完全一致', () => {
  const states = ['s0', 's1', 's2'];
  const codes = ['A', 'B'];
  const outputs = ['0', '1'];
  const rand = rng(20260927);
  const bound = (states.length * (states.length - 1)) / 2; // 预设区分序列长度上界
  for (let trial = 0; trial < 60; trial++) {
    const rows = {};
    for (const s of states) {
      rows[s] = {};
      for (const c of codes) {
        rows[s][c] = [outputs[Math.floor(rand() * outputs.length)], states[Math.floor(rand() * 3)]];
      }
    }
    const m = machine(states, codes, rows);
    const r = audit(m);
    const expected = oracle(m, bound);
    if (expected === null) {
      assert.equal(r.found, false, `trial ${trial}：预言机找不到，BFS 却声称找到`);
      verifyImpossibilityWitness(m, r, bound, trial);
    } else {
      assert.equal(r.found, true, `trial ${trial}：预言机找到 ${expected.join('')}，BFS 失败`);
      assert.ok(r.sequence.length <= bound, `trial ${trial}：长度超过理论上界`);
      assert.deepEqual(
        r.sequence,
        expected,
        `trial ${trial}：BFS=${r.sequence.join('')} oracle=${expected.join('')}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 规模与耗时：10 个位置（45 对）随机机型应快速完成
// ---------------------------------------------------------------------------

test('10 位置随机机型在 2 秒内完成审计', () => {
  const n = 10;
  const states = Array.from({ length: n }, (_, i) => `q${i}`);
  const codes = ['A', 'B', 'C', 'D'];
  const rand = rng(424242);
  const rows = {};
  for (const s of states) {
    rows[s] = {};
    for (const c of codes) {
      rows[s][c] = [String(Math.floor(rand() * 2)), states[Math.floor(rand() * n)]];
    }
  }
  const t0 = Date.now();
  const r = audit(machine(states, codes, rows));
  const ms = Date.now() - t0;
  assert.ok(ms < 2000, `耗时 ${ms}ms 超限`);
  if (r.found) assert.ok(r.sequence.length <= (n * (n - 1)) / 2);
});

// ---------------------------------------------------------------------------
// 非侵入辨识复核：区分 + 复位的复合目标
// ---------------------------------------------------------------------------

/** 非侵入预言机：长度升序、ASCII 序枚举；要求回执两两不同且各初态终局回到自身。 */
function oracleNonIntrusive(model, maxDepth) {
  const { positions, codes, table } = model;
  const run = (p, seq) => {
    const out = [];
    let cur = p;
    for (const c of seq) {
      out.push(table[cur][c].response);
      cur = table[cur][c].next;
    }
    return { out: out.join('|'), end: cur };
  };
  const ok = seq => {
    const seen = new Set();
    for (const p of positions) {
      const r = run(p, seq);
      if (r.end !== p) return false;
      if (seen.has(r.out)) return false;
      seen.add(r.out);
    }
    return true;
  };
  let level = [[]];
  for (let d = 0; d <= maxDepth; d++) {
    for (const seq of level) if (ok(seq)) return seq;
    level = level.flatMap(seq => codes.map(c => [...seq, c]));
  }
  return null;
}

test('非侵入复核：单码自环且回执不同 → 最短串为该码并 ASCII 取小', () => {
  const m = machine(['s0', 's1'], ['B', 'A'], {
    s0: { A: ['0', 's0'], B: ['0', 's0'] },
    s1: { A: ['1', 's1'], B: ['1', 's1'] },
  });
  const r = nonIntrusiveReview(m);
  assert.equal(r.found, true);
  assert.deepEqual(r.sequence, ['A']);
  assert.deepEqual(r.receipts.s0, ['0']);
  assert.deepEqual(r.receipts.s1, ['1']);
  assert.equal(r.endAt.s0, 's0');
  assert.equal(r.endAt.s1, 's1');
});

test('非侵入复核：单码虽区分但未复位，最短解 AA（逐轮映射先换位后归位）', () => {
  // A：s0 出 0 到 s1，s1 出 1 到 s0 —— 一轮已分开但位置互换，AA 后各自归位；
  // B：两者均出 0 留 s0，不能区分。长度 1 无解，AA 为最短解。
  const m = machine(['s0', 's1'], ['A', 'B'], {
    s0: { A: ['0', 's1'], B: ['0', 's0'] },
    s1: { A: ['1', 's0'], B: ['0', 's0'] },
  });
  const r = nonIntrusiveReview(m);
  assert.equal(r.found, true);
  assert.deepEqual(r.sequence, ['A', 'A']);
  assert.deepEqual(r.receipts.s0, ['0', '1']);
  assert.deepEqual(r.receipts.s1, ['1', '0']);
  assert.equal(r.endAt.s0, 's0');
  assert.equal(r.endAt.s1, 's1');

  assert.equal(r.trace.length, 2);
  // 第一轮后：对已分开（mask 空），但映射是换位、非恒等
  assert.equal(r.trace[0].splitThisRound.length, 1);
  assert.equal(r.trace[0].unresolvedAfter.length, 0);
  assert.equal(r.trace[0].identityAfter, false);
  const after1 = Object.fromEntries(r.trace[0].mappingAfter.map(x => [x.from, x.to]));
  assert.deepEqual(after1, { s0: 's1', s1: 's0' });
  // 第二轮后：映射恒等、仍无未分对，复合终态达成
  assert.equal(r.trace[1].identityAfter, true);
  assert.equal(r.trace[1].unresolvedAfter.length, 0);
  const after2 = Object.fromEntries(r.trace[1].mappingAfter.map(x => [x.from, x.to]));
  assert.deepEqual(after2, { s0: 's0', s1: 's1' });
});

test('非侵入复核：位置超限（8 > 7）被拒绝且普通校验通过', () => {
  assert.equal(NON_INTRUSIVE_MAX_POS, 7);
  const states = Array.from({ length: 8 }, (_, i) => `q${i}`);
  const rows = {};
  for (const s of states) {
    rows[s] = { A: ['0', s], B: ['0', s] };
  }
  const m = machine(states, ['A', 'B'], rows);
  assert.doesNotThrow(() => validateInput(m)); // 普通审计口径仍合法
  assert.throws(
    () => nonIntrusiveReview(m),
    err => {
      assert.ok(err instanceof ValidationError);
      assert.ok(err.messages.some(x => x.includes('只受理不超过 7 个位置')));
      assert.ok(err.messages.some(x => x.includes('当前为 8 个')));
      return true;
    },
  );
});

test('非侵入复核：单个位置空序列即成功（天然复位）', () => {
  const m = machine(['S'], ['A', 'B'], {
    S: { A: ['0', 'S'], B: ['1', 'S'] },
  });
  const r = nonIntrusiveReview(m);
  assert.equal(r.found, true);
  assert.deepEqual(r.sequence, []);
  assert.deepEqual(r.trace, []);
  assert.equal(r.endAt.S, 'S');
});

test('非侵入复核：两初态恒同 → 无解，闭合范围仅初态且各码均轨迹重合', () => {
  const m = machine(['s0', 's1'], ['A', 'B'], {
    s0: { A: ['0', 's0'], B: ['0', 's0'] },
    s1: { A: ['0', 's0'], B: ['0', 's0'] },
  });
  const r = nonIntrusiveReview(m);
  assert.equal(r.found, false);
  assert.equal(r.closedSearch.kind, 'nonIntrusive');
  assert.equal(r.closedSearch.states.length, 1);
  const st0 = r.closedSearch.states[0];
  assert.equal(st0.state, 0);
  assert.deepEqual(st0.unresolvedPairs, ['s0 / s1']);
  assert.deepEqual(st0.unmetConditions, ['pairs']); // 映射恒等，但未分对非空
  for (const br of st0.branches) {
    assert.equal(br.outcome, 'merge');
    assert.deepEqual(br.mergedPairs, ['s0 / s1']);
  }
});

test('非侵入复核：普通审计有解但复核无解（三位置，9 个可达复合状态封闭）', () => {
  // 普通审计最短串 AB；但任何使三初态两两分开的串都无法同时让三者归位。
  const m = machine(['P1', 'P2', 'P3'], ['A', 'B'], {
    P1: { A: ['1', 'P3'], B: ['1', 'P2'] },
    P2: { A: ['0', 'P2'], B: ['0', 'P2'] },
    P3: { A: ['1', 'P1'], B: ['0', 'P3'] },
  });
  assert.equal(audit(m).found, true);
  const r = nonIntrusiveReview(m);
  assert.equal(r.found, false);
  assert.ok(r.closedSearch.states.length >= 2);
  // 初态：恒等映射 + 全部三对未分
  const s0 = r.closedSearch.states[0];
  assert.equal(s0.identity, true);
  assert.equal(s0.unresolvedPairs.length, 3);
  // 封闭性：每个分支要么重合，要么指向族内状态；族内无复合终态（恒等且无未分对）。
  for (const st of r.closedSearch.states) {
    assert.ok(st.unmetConditions.length >= 1, '终态不应出现在封闭族中');
    for (const br of st.branches) {
      if (br.outcome === 'move') {
        assert.ok(br.targetState !== null);
        assert.ok(br.targetState < r.closedSearch.states.length);
      } else {
        assert.equal(br.outcome, 'merge');
        assert.ok(br.mergedPairs.length >= 1);
      }
    }
  }
});

/**
 * 独立复核闭合搜索范围：用原始转移表从每个给出的复合状态重放每个码，
 * 验证 move 边封闭在状态族内且非终态，merge 边确实轨迹重合。
 */
function verifyClosedSearch(m, r) {
  const { positions, codes, table } = model_validate(m);
  const states = r.closedSearch.states;
  const keyOf = (mapping, pairs) => {
    const mm = mapping.map(x => `${x.from}->${x.to}`).join(',');
    return `${mm}|${[...pairs].sort().join(';')}`;
  };
  const keys = states.map(st => keyOf(st.mapping, st.unresolvedPairs));
  for (const st of states) {
    const cur = Object.fromEntries(st.mapping.map(x => [x.from, x.to]));
    for (const br of st.branches) {
      const nextCur = {};
      const step = {};
      for (const p of positions) {
        const t = table[cur[p]][br.code];
        nextCur[p] = t.next;
        step[p] = t.response;
      }
      const still = [];
      let merged = false;
      for (const pair of st.unresolvedPairs) {
        const [a, b] = pair.split(' / ');
        if (step[a] !== step[b]) continue; // 本轮被分开
        if (nextCur[a] === nextCur[b]) merged = true;
        else still.push(pair);
      }
      if (br.outcome === 'merge') {
        assert.equal(merged, true, '标记重合的分支必须确实重合');
      } else {
        assert.equal(merged, false, 'move 分支不应重合');
        const target = states[br.targetState];
        const tMap = Object.fromEntries(target.mapping.map(x => [x.from, x.to]));
        assert.deepEqual(tMap, nextCur, 'move 边目标映射必须与重放一致');
        assert.deepEqual([...target.unresolvedPairs].sort(), [...still].sort());
        assert.ok(keys.includes(keyOf(target.mapping, target.unresolvedPairs)));
        // 目标不能是复合终态
        assert.ok(
          !target.mapping.every(x => x.from === x.to) || target.unresolvedPairs.length > 0,
        );
      }
    }
  }
}

function model_validate(m) {
  const normalized = validateInput(m);
  normalized.codes.sort();
  return normalized;
}

test('非侵入复核 ×随机机型：存在性/最短/字典序 与暴力预言机一致，无解给封闭证明', () => {
  const codes = ['A', 'B'];
  const outputs = ['0', '1'];
  const rand = rng(20260930);
  let trials = 0;
  for (const n of [2, 3, 4]) {
    const states = Array.from({ length: n }, (_, i) => `s${i}`);
    for (let trial = 0; trial < 50; trial++) {
      trials++;
      const rows = {};
      for (const s of states) {
        rows[s] = {};
        for (const c of codes) {
          rows[s][c] = [outputs[Math.floor(rand() * 2)], states[Math.floor(rand() * n)]];
        }
      }
      const m = machine(states, codes, rows);
      const r = nonIntrusiveReview(m);
      const expected = oracleNonIntrusive(m, 12);
      if (r.found) {
        // 防御性自检 + 与预言机一致
        assert.ok(expected !== null, `n=${n} trial=${trial}：预言机找不到却声称找到`);
        assert.deepEqual(r.sequence, expected, `n=${n} trial=${trial}：序列不一致`);
        assert.ok(r.sequence.length <= 12);
        assert.equal(r.endAt && states.every(p => r.endAt[p] === p), true);
      } else {
        assert.ok(r.closedSearch && r.closedSearch.states.length >= 1);
        verifyClosedSearch(m, r);
      }
    }
  }
  assert.ok(trials === 150);
});
