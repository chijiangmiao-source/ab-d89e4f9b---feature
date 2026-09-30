// 纯逻辑模块：输入校验、基于“未区分位置对集合”的精确 BFS 最短区分序列求解，
// 以及不可区分时的最小化等价类反例。同一份代码被 Web Worker 与 Node 测试引用。

/**
 * @typedef {Object} Transition
 * @property {string} response 确定回执（非空字符串）
 * @property {string} next     下一位置（必须是已声明位置之一）
 */

/** 校验失败：messages 为合并后的全部问题，调用方须清除旧结论后一次性显示。 */
export class ValidationError extends Error {
  /** @param {string[]} messages */
  constructor(messages) {
    super(messages.join('；'));
    this.name = 'ValidationError';
    this.messages = messages;
  }
}

const show = s => JSON.stringify(String(s));

/**
 * 校验并规范化录入。
 * 接受的原始结构：
 *   { positions: string[],
 *     codes:     string[],                      // 期望 2~4 个 ASCII 码
 *     table:     { [posName]: { [code]: Transition | Transition[] } } }
 * 同一 (位置, 码) 给出多条定义即“非确定定义”，与其余错误一并报告。
 */
export function validateInput(raw) {
  const messages = [];
  const positions = [];
  for (const name of (raw.positions || []).map(s => String(s ?? '').trim())) {
    if (!name) messages.push('存在空位置名');
    else if (positions.includes(name)) messages.push(`位置名重复：${name}`);
    else positions.push(name);
  }

  const codes = [];
  for (const codeRaw of raw.codes || []) {
    const code = String(codeRaw ?? '').trim();
    if (!code) {
      messages.push('存在空探测码');
      continue;
    }
    if (!/^[\x00-\x7F]+$/.test(code)) {
      messages.push(`探测码不是纯 ASCII：${show(code)}`);
      continue;
    }
    if (codes.includes(code)) {
      messages.push(`探测码重复：${show(code)}`); // 重复码也不参与求解
      continue;
    }
    codes.push(code);
  }

  const table = {};
  for (const pos of positions) {
    table[pos] = {};
    for (const code of codes) {
      const cell = raw.table?.[pos]?.[code];
      const defs = Array.isArray(cell) ? cell : cell == null ? [] : [cell];
      if (defs.length === 0) {
        messages.push(`缺失转移：位置 ${pos} / 探测码 ${show(code)}`);
        continue;
      }
      if (defs.length > 1) {
        messages.push(`非确定定义：位置 ${pos} / 探测码 ${show(code)} 存在 ${defs.length} 条回执定义`);
        continue;
      }
      const t = defs[0];
      const response = String(t?.response ?? '').trim();
      const next = String(t?.next ?? '').trim();
      if (!response) {
        messages.push(`缺失回执：位置 ${pos} / 探测码 ${show(code)}`);
        continue;
      }
      if (!next) {
        messages.push(`缺失下一位置：位置 ${pos} / 探测码 ${show(code)}`);
        continue;
      }
      if (!positions.includes(next)) {
        messages.push(`位置 ${pos} 经 ${show(code)} 的下一位置「${next}」不在声明位置列表中`);
        continue;
      }
      table[pos][code] = { response, next };
    }
  }

  if (positions.length === 0) messages.push('未录入任何位置');
  if (codes.length === 0) messages.push('探测码表为空（需要 2~4 个 ASCII 探测码）');
  else if (codes.length === 1) messages.push('探测码仅 1 个（至少需要 2 个）');
  else if (codes.length > 4) messages.push(`探测码共 ${codes.length} 个（至多 4 个）`);

  if (messages.length) throw new ValidationError(messages);
  return { positions, codes, table };
}

// ---------------------------------------------------------------------------
// 核心求解：状态 = 尚未区分的“当前位置对”集合（无序对上的 BigInt 位掩码）。
// 不枚举任何初态的响应串，也不假设深度；在该状态空间上做精确 BFS。
// ---------------------------------------------------------------------------

/** 全部无序位置对 (i,j), i<j，枚举下标即 bit 位。 */
export function buildPairs(n) {
  const pairs = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) pairs.push([i, j]);
  }
  return pairs;
}

/** 与 buildPairs 枚举顺序一致的位置对位下标。 */
export function pairIndex(a, b, n) {
  const i = Math.min(a, b);
  const j = Math.max(a, b);
  return i * n - (i * (i + 1)) / 2 + (j - i - 1);
}

/** 预计算每个码在每个位置下标上的 { 回执, 后继下标 }，供 BFS 热路径使用。 */
export function precompute(model) {
  const { positions, codes, table } = model;
  const index = new Map(positions.map((p, i) => [p, i]));
  const trans = codes.map(code =>
    positions.map(p => ({
      r: table[p][code].response,
      ni: index.get(table[p][code].next),
    })),
  );
  return { trans, pairs: buildPairs(positions.length) };
}

/**
 * 探测码对未区分对集合的确定性变换：
 *  1) 该码下双方回执不同的对 -> 本轮被分开，剔除；
 *  2) 回执相同且后继重合 -> 两条轨迹从此完全一致，该前缀必非区分序列：
 *     置 dead=true，调用方剪枝，不得把该对当作“已解决”；
 *  3) 回执相同、后继不同 -> 映射为后继位置对继续保留。
 * 返回 { mask, split:对位下标[], merged:对位下标[], dead }。
 */
export function applyCode(mask, codeIdx, ctx) {
  const { pairs, trans, n } = ctx;
  const tr = trans[codeIdx];
  let nextMask = 0n;
  const split = [];
  const merged = [];
  for (let k = 0; k < pairs.length; k++) {
    if (!(mask & (1n << BigInt(k)))) continue;
    const [i, j] = pairs[k];
    const a = tr[i];
    const b = tr[j];
    if (a.r !== b.r) {
      split.push(k);
    } else if (a.ni === b.ni) {
      merged.push(k);
    } else {
      nextMask |= 1n << BigInt(pairIndex(a.ni, b.ni, n));
    }
  }
  return { mask: nextMask, split, merged, dead: merged.length > 0 };
}

/**
 * 精确 BFS。codes 预先按 ASCII 字典序排列；BFS 保证最短，
 * 且同一深度按父路径字典序 + 码序首次到达 0 状态，故结果唯一且字典序最小。
 */
export function bfsDistinguishingSequence(model) {
  const { positions, codes } = model;
  const n = positions.length;
  const ctx = { ...precompute(model), positions, n };
  const { pairs } = ctx;

  const initial = pairs.length ? (1n << BigInt(pairs.length)) - 1n : 0n;
  if (initial === 0n) return { found: true, sequence: [], trace: [] };

  const parent = new Map(); // mask -> { code, parent } ，初始态为 null
  parent.set(initial, null);
  const queue = [initial];
  let head = 0;
  let found = false;
  // 记录每个已探索状态在各码下的结局，供无解时构造结构性证明。
  const edgeLog = new Map();

  while (head < queue.length && !found) {
    const mask = queue[head++];
    const logRow = new Array(codes.length);
    for (let c = 0; c < codes.length; c++) {
      const res = applyCode(mask, c, ctx);
      // 任一未分对在该码下后继重合 -> 该前缀永远无法分开它们，整支剪枝。
      if (res.dead) {
        logRow[c] = { kind: 'merge', merged: res.merged };
        continue;
      }
      logRow[c] = { kind: 'move', target: res.mask };
      if (parent.has(res.mask)) continue;
      parent.set(res.mask, { code: c, parent: mask });
      if (res.mask === 0n) {
        found = true;
        break;
      }
      queue.push(res.mask);
    }
    edgeLog.set(mask, logRow);
  }

  if (!found) {
    const partition = computePartition(model);
    if (partition.hasNontrivialClass) {
      return { found: false, ...equivalenceProof(model, partition) };
    }
    return {
      found: false,
      equivalence: null,
      ...structuralProof(initial, codes, ctx, edgeLog, parent),
    };
  }

  // 回溯链：沿 parent 指针从目标状态反推出码下标序列。
  const rev = [];
  let cur = 0n;
  while (parent.get(cur) !== null) {
    const edge = parent.get(cur);
    rev.push(edge.code);
    cur = edge.parent;
  }
  const sequenceIdx = rev.reverse();
  const sequence = sequenceIdx.map(c => codes[c]);

  // 正向逐步复算，列出每轮“仍未分开的初态对”（求解时只跟踪位置对集合，
  // 这里沿序列为每个初态对复算轨迹，纯属结果重建）。
  const tracks = pairs.map(([i, j]) => ({ i, j, done: false, reason: null }));
  const name = ([i, j]) => `${positions[i]} / ${positions[j]}`;
  const trace = [];
  for (let round = 0; round < sequenceIdx.length; round++) {
    const c = sequenceIdx[round];
    const tr = ctx.trans[c];
    const unresolvedBefore = [];
    for (let k = 0; k < tracks.length; k++) {
      if (!tracks[k].done) unresolvedBefore.push(name(pairs[k]));
    }
    const splitThisRound = [];
    const mergedThisRound = [];
    for (let k = 0; k < tracks.length; k++) {
      const t = tracks[k];
      if (t.done) continue;
      const a = tr[t.i];
      const b = tr[t.j];
      if (a.r !== b.r) {
        t.done = true;
        t.reason = 'split';
        splitThisRound.push(name(pairs[k]));
      } else if (a.ni === b.ni) {
        t.done = true;
        t.reason = 'merged';
        mergedThisRound.push(name(pairs[k]));
      } else {
        t.i = a.ni;
        t.j = b.ni;
      }
    }
    const unresolvedAfter = [];
    for (let k = 0; k < tracks.length; k++) {
      if (!tracks[k].done) unresolvedAfter.push(name(pairs[k]));
    }
    trace.push({
      round: round + 1,
      code: codes[c],
      unresolvedBefore,
      splitThisRound,
      mergedThisRound,
      unresolvedAfter,
    });
  }

  return { found: true, sequence, trace };
}

// ---------------------------------------------------------------------------
// 不可区分反例有两种：
//  A) 存在最小化（最粗）等价类：类内位置对每个码回执相同且后继仍在同类，
//     归纳可知对任意码序列回执恒同 —— 直接给出该等价类与逐码证据。
//  B) 机型本身已最小（任何两个位置都存在某个串能分开），但不存在“同一个”
//     固定串同时分开所有初态：给出 BFS 可达状态族的封闭性证明——从初态
//     全对集合出发，每个码要么令某对轨迹重合（该前缀下永不可分），
//     要么落入族中另一个非空状态；故任何码串都到不了空状态。
// ---------------------------------------------------------------------------

/** Moore 式分区细化至不动点（最粗观测等价划分）。 */
function computePartition(model) {
  const { positions, codes, table } = model;
  const n = positions.length;
  const index = new Map(positions.map((p, i) => [p, i]));
  let blocks = new Array(n).fill(0);
  for (;;) {
    const sigs = positions.map((p, i) => {
      const parts = [`b${blocks[i]}`];
      for (const c of codes) {
        const t = table[p][c];
        parts.push(t.response, `b${blocks[index.get(t.next)]}`);
      }
      return parts.join(' ');
    });
    const ids = new Map();
    const next = new Array(n);
    let count = 0;
    sigs.forEach((sig, i) => {
      if (!ids.has(sig)) ids.set(sig, count++);
      next[i] = ids.get(sig);
    });
    if (next.every((b, i) => b === blocks[i])) break;
    blocks = next;
  }
  const byBlock = new Map();
  blocks.forEach((b, i) => {
    if (!byBlock.has(b)) byBlock.set(b, []);
    byBlock.get(b).push(i);
  });
  let hasNontrivialClass = false;
  for (const members of byBlock.values()) {
    if (members.length >= 2) hasNontrivialClass = true;
  }
  return { blocks, byBlock, hasNontrivialClass };
}

function equivalenceProof(model, partition) {
  const { positions, codes, table } = model;
  const index = new Map(positions.map((p, i) => [p, i]));
  const { blocks, byBlock } = partition;

  // 选一个非平凡类作反例；类的选择与类内 witness 对都取名称序最靠前者，保证唯一。
  let chosen = null;
  for (const members0 of byBlock.values()) {
    if (members0.length < 2) continue;
    const members = [...members0].sort((a, b) =>
      positions[a] < positions[b] ? -1 : positions[a] > positions[b] ? 1 : 0,
    );
    const key = members.map(i => positions[i]).join(' ');
    if (chosen === null || key < chosen.key) chosen = { key, members };
  }

  if (!chosen) return { equivalence: null };
  const [wi, wj] = chosen.members;
  const witnessClass = chosen.members.map(i => positions[i]);

  const evidence = codes.map(c => {
    const ti = table[positions[wi]][c];
    const tj = table[positions[wj]][c];
    return {
      code: c,
      responseBoth: ti.response,
      nextI: ti.next,
      nextJ: tj.next,
      nextClassI: [...byBlock.get(blocks[index.get(ti.next)])].map(i => positions[i]),
      nextClassJ: [...byBlock.get(blocks[index.get(tj.next)])].map(i => positions[i]),
      successorsStillEquivalent: blocks[index.get(ti.next)] === blocks[index.get(tj.next)],
    };
  });

  const allEquivalentPairs = [];
  for (const members of byBlock.values()) {
    for (let a = 0; a < members.length; a++) {
      for (let b = a + 1; b < members.length; b++) {
        allEquivalentPairs.push(`${positions[members[a]]} / ${positions[members[b]]}`);
      }
    }
  }
  allEquivalentPairs.sort();

  return {
    equivalence: {
      kind: 'class',
      pair: [positions[wi], positions[wj]],
      witnessClass,
      evidence,
      allEquivalentPairs,
    },
  };
}

/**
 * 结构性不可行证明：枚举 BFS 实际可达的全部非空“未分对集合”状态，
 * 展示每个状态在各码下要么发生轨迹重合，要么转移到族内另一状态。
 */
function structuralProof(initial, codes, ctx, edgeLog, parent) {
  const { pairs, positions } = ctx;
  const pairName = k => `${positions[pairs[k][0]]} / ${positions[pairs[k][1]]}`;
  const maskPairs = mask => {
    const out = [];
    for (let k = 0; k < pairs.length; k++) {
      if (mask & (1n << BigInt(k))) out.push(pairName(k));
    }
    out.sort();
    return out;
  };

  // 状态按 BFS 发现顺序编号，初态恒为 #0。
  const order = [initial, ...[...parent.keys()].filter(m => m !== initial)];
  const id = new Map(order.map((m, i) => [m, i]));

  const states = order.map(mask => {
    const row = edgeLog.get(mask);
    const branches = codes.map((code, c) => {
      const e = row[c];
      if (e.kind === 'merge') {
        return { code, outcome: 'merge', mergedPairs: e.merged.map(pairName).sort() };
      }
      return { code, outcome: 'move', targetState: id.get(e.target) ?? null };
    });
    return { state: id.get(mask), unresolvedPairs: maskPairs(mask), branches };
  });

  return {
    equivalence: {
      kind: 'structural',
      explanation:
        '每个位置单独都可被某个码串识别，但不存在同一串固定探测序列同时区分全部初态：' +
        '从初态全对集合出发，施加任何探测码，要么令其中一对的轨迹在该前缀下重合（此后二者永远同回执），' +
        '要么转移到下表中另一个非空状态；该状态族封闭，故任何长度的码串都无法清空未分对集合。',
      states,
    },
  };
}

/**
 * 沿给定码序列复算每个初态的完整回执串（仅用于结果展示/校验，不参与搜索）。
 * @returns {{receipts: Object<string,string[]>, pairwiseDistinct: boolean}}
 */
export function simulateReceipts(model, sequence) {
  const { positions, table } = model;
  const receipts = {};
  for (const p of positions) {
    const list = [];
    let cur = p;
    for (const code of sequence) {
      const t = table[cur][code];
      list.push(t.response);
      cur = t.next;
    }
    receipts[p] = list;
  }
  const seen = new Set();
  let pairwiseDistinct = true;
  for (const p of positions) {
    const key = JSON.stringify(receipts[p]);
    if (seen.has(key)) pairwiseDistinct = false;
    seen.add(key);
  }
  return { receipts, pairwiseDistinct };
}

/** 审计入口：校验 → 码按 ASCII 排序 → BFS。最短优先，并列时码序列字典序唯一。 */
export function audit(raw) {
  const model = validateInput(raw);
  model.codes.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const result = bfsDistinguishingSequence(model);
  if (result.found) {
    const { receipts, pairwiseDistinct } = simulateReceipts(model, result.sequence);
    if (!pairwiseDistinct) {
      // 防御性自检：BFS 给出的序列必须确实使所有初态回执两两不同。
      throw new Error('内部校验失败：所得序列未能区分全部初态');
    }
    result.receipts = receipts;
  }
  return { model, ...result };
}
