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

// ---------------------------------------------------------------------------
// 非侵入辨识复核：
//   现场校准则要求诊断结束后任何上电位置都不能停留在别处，因此除“回执两两不同”
//   外还要求整串执行后每个初态恰好回到自身（位置映射为恒等）。
//
//   搜索状态是复合状态 (mapping, pairMask)：
//     mapping  —— 每个“初态”当前所在位置（按下标的完整映射，不要求是排列）；
//     pairMask —— 截至当前前缀，完整回执串仍未分开的“初态对”位掩码
//                 （位下标沿用 buildPairs；对的身份是初态对，不随后继重映射）。
//   初始态 = (恒等映射, 全部初态对)；目标态 = (恒等映射, 空对集)，二者缺一不可。
//
//   仅受理位置数不超过 NON_INTRUSIVE_LIMIT 的机型。
// ---------------------------------------------------------------------------

export const NON_INTRUSIVE_LIMIT = 7;

function isIdentityMap(mapArr) {
  for (let i = 0; i < mapArr.length; i++) if (mapArr[i] !== i) return false;
  return true;
}

/** 映射编码：n 进制数（n<=7、长度<=7，至多 7^7-1，普通 number 足够）。 */
function mapKeyOf(mapArr, radix) {
  let k = 0;
  for (const v of mapArr) k = k * radix + v;
  return k;
}

/** 复合状态键：映射编码 + 初态对掩码。 */
function compositeKey(mapArr, mask, n) {
  return `${mapKeyOf(mapArr, n)}:${mask.toString()}`;
}

/**
 * 非侵入复合状态在单个探测码下的确定性推进：
 *  - 映射：各初态整体前进一步，nextMap[i] = 码 c 在 map[i] 处的后继；
 *  - 未分对：本轮回执不同 -> 剔除（已分开）；回执相同且后继位置重合 ->
 *    两条轨迹并入同一位置，此后回执恒同且不可能各自归位，dead 剪枝；
 *    回执相同、后继仍不同 -> 该初态对保留。
 */
export function stepNonIntrusive(mapArr, mask, codeIdx, ctx) {
  const { pairs, trans, n } = ctx;
  const tr = trans[codeIdx];
  const nextMap = new Array(n);
  for (let i = 0; i < n; i++) nextMap[i] = tr[mapArr[i]].ni;

  let nextMask = 0n;
  const split = [];
  const merged = [];
  for (let k = 0; k < pairs.length; k++) {
    if (!(mask & (1n << BigInt(k)))) continue;
    const [i, j] = pairs[k]; // 初态对身份保持为 (i,j)
    const a = tr[mapArr[i]];
    const b = tr[mapArr[j]];
    if (a.r !== b.r) {
      split.push(k);
    } else if (nextMap[i] === nextMap[j]) {
      merged.push(k);
    } else {
      nextMask |= 1n << BigInt(k);
    }
  }
  return { nextMap, nextMask, split, merged, dead: merged.length > 0 };
}

/**
 * 非侵入辨识复核的精确 BFS。
 * 成功条件严格为 nextMap 恒等且 nextMask 为空；codes 已按 ASCII 排序，
 * 故首个被发现的目标态给出最短且同长度下字典序最小的唯一规范串。
 */
export function bfsNonIntrusiveSequence(model) {
  const { positions, codes } = model;
  const n = positions.length;
  const ctx = { ...precompute(model), positions, n };
  const { pairs } = ctx;

  const initMap = Array.from({ length: n }, (_, i) => i);
  const initMask = pairs.length ? (1n << BigInt(pairs.length)) - 1n : 0n;
  const initKey = compositeKey(initMap, initMask, n);

  const pairName = k => `${positions[pairs[k][0]]} / ${positions[pairs[k][1]]}`;
  const mappingView = mapArr =>
    mapArr.map((v, i) => ({ initial: positions[i], current: positions[v] }));
  const pairsOf = mask => {
    const out = [];
    for (let k = 0; k < pairs.length; k++) if (mask & (1n << BigInt(k))) out.push(pairName(k));
    out.sort();
    return out;
  };

  // 零长度串：单位置机型初态即（恒等，空对）。
  if (isIdentityMap(initMap) && initMask === 0n) {
    return {
      found: true,
      sequence: [],
      finalMap: initMap.slice(),
      trace: [
        {
          round: 0,
          code: null,
          mapping: mappingView(initMap),
          identity: true,
          unresolvedBefore: [],
          splitThisRound: [],
          unresolvedAfter: [],
        },
      ],
    };
  }

  const nodes = new Map(); // key -> { map, mask }
  nodes.set(initKey, { map: initMap, mask: initMask });
  const parent = new Map(); // key -> { code, parent }，初态为 null
  parent.set(initKey, null);
  const queue = [initKey]; // 队列顺序即复合状态发现顺序，无解时恰为闭合族
  const edgeLog = new Map();
  let head = 0;
  let goalKey = null;

  while (head < queue.length && goalKey === null) {
    const key = queue[head++];
    const { map, mask } = nodes.get(key);
    const logRow = new Array(codes.length);
    for (let c = 0; c < codes.length; c++) {
      const res = stepNonIntrusive(map, mask, c, ctx);
      if (res.dead) {
        logRow[c] = { kind: 'merge', merged: res.merged };
        continue;
      }
      const nxtKey = compositeKey(res.nextMap, res.nextMask, n);
      logRow[c] = { kind: 'move', target: nxtKey };
      if (parent.has(nxtKey)) continue;
      parent.set(nxtKey, { code: c, parent: key });
      nodes.set(nxtKey, { map: res.nextMap, mask: res.nextMask });
      queue.push(nxtKey);
      if (isIdentityMap(res.nextMap) && res.nextMask === 0n) {
        goalKey = nxtKey;
        break;
      }
    }
    edgeLog.set(key, logRow);
  }

  if (goalKey === null) {
    return {
      found: false,
      ...nonIntrusiveClosure(codes, queue, nodes, edgeLog, mappingView, pairsOf, pairName),
    };
  }

  // 回溯码下标序列。
  const rev = [];
  let cur = goalKey;
  while (parent.get(cur) !== null) {
    const edge = parent.get(cur);
    rev.push(edge.code);
    cur = edge.parent;
  }
  const sequenceIdx = rev.reverse();
  const sequence = sequenceIdx.map(c => codes[c]);

  // 正向逐步复算：逐轮列出位置映射与仍未分开的初态对（round 0 为初始态）。
  const trace = [
    {
      round: 0,
      code: null,
      mapping: mappingView(initMap),
      identity: true,
      unresolvedBefore: [],
      splitThisRound: [],
      unresolvedAfter: pairsOf(initMask),
    },
  ];
  let map = initMap;
  let mask = initMask;
  for (let round = 0; round < sequenceIdx.length; round++) {
    const c = sequenceIdx[round];
    const before = pairsOf(mask);
    const res = stepNonIntrusive(map, mask, c, ctx);
    trace.push({
      round: round + 1,
      code: codes[c],
      mapping: mappingView(res.nextMap),
      identity: isIdentityMap(res.nextMap),
      unresolvedBefore: before,
      splitThisRound: res.split.map(pairName).sort(),
      unresolvedAfter: pairsOf(res.nextMask),
    });
    map = res.nextMap;
    mask = res.nextMask;
  }

  return { found: true, sequence, finalMap: map, trace };
}

/**
 * 无解反例：BFS 耗尽的可达复合状态族对（非死）转移封闭；
 * 同时逐条核对终态的两个必要条件——映射恒等、未分对为空——在族内的满足情况。
 */
function nonIntrusiveClosure(codes, queue, nodes, edgeLog, mappingView, pairsOf, pairName) {
  const id = new Map(queue.map((key, i) => [key, i]));

  const states = queue.map(key => {
    const { map, mask } = nodes.get(key);
    const branches = codes.map((code, c) => {
      const e = edgeLog.get(key)[c];
      if (e.kind === 'merge') {
        return { code, outcome: 'merge', mergedPairs: e.merged.map(pairName).sort() };
      }
      return { code, outcome: 'move', targetState: id.get(e.target) ?? null };
    });
    return {
      state: id.get(key),
      mapping: mappingView(map),
      identity: isIdentityMap(map),
      unresolvedPairs: pairsOf(mask),
      emptyPairs: mask === 0n,
      branches,
    };
  });

  // 终态要求“恒等映射”与“未分对为空”同时成立；封闭族内不存在这样的状态。
  // 分别列出两个条件在族内何处成立，指出缺失的合取。
  const identityStates = states.filter(s => s.identity).map(s => s.state);
  const emptyStates = states.filter(s => s.emptyPairs).map(s => s.state);
  const unmetConditions = [];
  if (identityStates.length === 0) {
    unmetConditions.push(
      '可达复合状态族中没有任何状态满足“位置映射为恒等”——任何不作废的码串都无法让每个初态同时回到自身',
    );
  } else if (!states.some(s => s.identity && s.emptyPairs)) {
    unmetConditions.push(
      `映射为恒等的状态（#${identityStates.join('、#')}）其未分对均非空，回执尚未两两不同`,
    );
  }
  if (emptyStates.length === 0) {
    unmetConditions.push(
      '可达复合状态族中没有任何状态满足“未分对为空”——回执两两不同与轨迹归位无法在同一串上同时达成',
    );
  } else if (!states.some(s => s.identity && s.emptyPairs)) {
    unmetConditions.push(
      `未分对为空的状态（#${emptyStates.join('、#')}）其位置映射均非恒等，仍有初态停留在别处`,
    );
  }

  return {
    closed: {
      explanation:
        '从初态（恒等映射，全部初态对未分）出发，施加任何探测码：要么令某对轨迹在同一位置重合' +
        '（此后二者回执恒同且不可能各自归位，该前缀作废），要么转入下表中的另一个可达复合状态。' +
        '该可达复合状态族对所有非作废转移封闭，而族内不存在同时满足两个终态条件的状态，' +
        '故任何长度的探测码串都无法同时做到“回执两两不同”与“整串后各初态归位”。',
      states,
      unmetConditions,
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
  return { mode: 'standard', model, ...result };
}

/**
 * 非侵入辨识复核入口：与普通审计同一套输入校验，但该模式只受理不超过
 * NON_INTRUSIVE_LIMIT 个位置的当前机型；超限直接退回（declined），由调用方呈现。
 * 成功时额外自检：回执两两不同，且串后每个初态恰好回到自身。
 */
export function nonIntrusiveAudit(raw) {
  // 超限优先：该模式只受理不超过 7 个位置的当前机型，超出时直接退回、不做校验与搜索。
  const rawCount = Array.isArray(raw?.positions) ? raw.positions.length : 0;
  if (rawCount > NON_INTRUSIVE_LIMIT) {
    return {
      mode: 'nonIntrusive',
      declined: true,
      reason: 'too-many-positions',
      positionCount: rawCount,
      limit: NON_INTRUSIVE_LIMIT,
    };
  }
  const model = validateInput(raw);
  model.codes.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const result = bfsNonIntrusiveSequence(model);
  if (result.found) {
    const { receipts, pairwiseDistinct } = simulateReceipts(model, result.sequence);
    if (!pairwiseDistinct) {
      throw new Error('内部校验失败：所得序列未能使全部初态回执两两不同');
    }
    const { positions } = model;
    const allReturned = result.finalMap.every(
      (v, i) => positions[v] === positions[i],
    );
    if (!allReturned) {
      throw new Error('内部校验失败：所得序列未能让每个初态回到自身');
    }
    result.receipts = receipts;
    result.returnMapping = result.finalMap.map((v, i) => ({
      initial: positions[i],
      current: positions[v],
    }));
  }
  return { mode: 'nonIntrusive', model, ...result };
}
