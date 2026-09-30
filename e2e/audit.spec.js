import { test, expect } from '@playwright/test';

/** 通过 UI 输入格子：row 为位置行号（0 起），code 为探测码文本。 */
async function fillCell(page, row, code, field, value) {
  await page.locator(`input[data-row="${row}"][data-code="${code}"][data-field="${field}"]`).fill(value);
}

async function fillMachine(page, { positions, codes, rows }) {
  // 位置名
  for (let i = 0; i < positions.length; i++) {
    await page.locator(`td.pos-col input.cell`).nth(i).fill(positions[i]);
  }
  // 探测码（默认已有 2 个）
  for (let i = 0; i < codes.length; i++) {
    await page.locator('.code-input input').nth(i).fill(codes[i]);
  }
  // 转移表
  for (let r = 0; r < positions.length; r++) {
    for (const code of codes) {
      const [resp, next] = rows[positions[r]][code];
      await fillCell(page, r, code, 'response', resp);
      await fillCell(page, r, code, 'next', next);
    }
  }
}

test.describe('规范探测串审计（浏览器）', () => {
  test('可区分模型：载入示例 → 审计 → 最短规范串 AB 与逐轮明细', async ({ page }) => {
    await page.goto('/');
    await page.click('#loadDemo');
    await page.click('#auditBtn');

    const result = page.locator('#result');
    await expect(result).toBeVisible();
    await expect(result).toHaveAttribute('data-outcome', 'success');
    await expect(result).toContainText('存在规范探测串');
    await expect(result).toContainText('长度 2');

    // 规范序列：A 然后 B
    const chips = result.locator('[data-testid="sequence"] .seq-chip');
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(0)).toHaveText('"A"');
    await expect(chips.nth(1)).toHaveText('"B"');

    // 逐轮仍未分开的初态对
    await expect(result).toContainText('每轮仍未分开的初态对');
    await expect(result).toContainText('P1 / P2');
    await expect(result).toContainText('全部初态已分开');

    // 复算回执两两不同
    await expect(result).toContainText('完整回执串');
    await expect(page.locator('#errors')).toBeHidden();
  });

  test('等价反例：两行完全相同 → 最小化等价类证明', async ({ page }) => {
    await page.goto('/');
    // 删掉第三个位置：直接清空前先录入两行完全相同的机型
    await page.click('#clearAll'); // 回到 P1/P2 两行空表
    await fillMachine(page, {
      positions: ['P1', 'P2'],
      codes: ['A', 'B'],
      rows: {
        P1: { A: ['0', 'P2'], B: ['x', 'P1'] },
        P2: { A: ['0', 'P2'], B: ['x', 'P1'] },
      },
    });
    await page.click('#auditBtn');

    const result = page.locator('#result');
    await expect(result).toBeVisible();
    await expect(result).toHaveAttribute('data-outcome', 'impossible');
    await expect(result).toContainText('不存在任何区分序列');
    await expect(result).toContainText('最小化等价类反例');
    await expect(result).toContainText('P1');
    await expect(result).toContainText('P2');
    await expect(result).toContainText('后继仍在同一等价类');
    await expect(page.locator('#errors')).toBeHidden();
  });

  test('结构性反例：自适应可分但无固定串 → 封闭状态族证明', async ({ page }) => {
    await page.goto('/');
    await fillMachine(page, {
      positions: ['P1', 'P2', 'P3'],
      codes: ['A', 'B'],
      rows: {
        P1: { A: ['0', 'P1'], B: ['0', 'P3'] },
        P2: { A: ['0', 'P1'], B: ['1', 'P3'] },
        P3: { A: ['1', 'P1'], B: ['0', 'P3'] },
      },
    });
    await page.click('#auditBtn');

    const result = page.locator('#result');
    await expect(result).toBeVisible();
    await expect(result).toHaveAttribute('data-outcome', 'impossible');
    await expect(result).toContainText('不存在任何区分序列');
    await expect(result).toContainText('轨迹重合');
    await expect(result).toContainText('状态族封闭');
  });

  test('非法输入：缺失转移 + 重复位置合并显示，且清除旧结论', async ({ page }) => {
    await page.goto('/');
    // 先做一次成功审计，产生旧结论
    await page.click('#loadDemo');
    await page.click('#auditBtn');
    await expect(page.locator('#result')).toHaveAttribute('data-outcome', 'success');

    // 制造非法输入：位置名重复 + 某格回执清空（缺失回执）
    await page.locator('td.pos-col input.cell').nth(1).fill('P1');
    await fillCell(page, 2, 'A', 'response', '');
    await page.click('#auditBtn');

    const errors = page.locator('#errors');
    await expect(errors).toBeVisible();
    await expect(errors).toContainText('位置名重复');
    await expect(errors).toContainText('缺失回执');
    // 旧结论已清除
    await expect(page.locator('#result')).toBeHidden();
    await expect(page.locator('#result')).toBeEmpty();
  });

  test('非法输入：空码表与非 ASCII 码', async ({ page }) => {
    await page.goto('/');
    // 清空两个码 → 空码表
    await page.locator('.code-input input').nth(0).fill('');
    await page.locator('.code-input input').nth(1).fill('');
    await page.click('#auditBtn');
    const errors = page.locator('#errors');
    await expect(errors).toBeVisible();
    await expect(errors).toContainText('空探测码');
    await expect(errors).toContainText('探测码表为空');

    // 非 ASCII 码
    await page.locator('.code-input input').nth(0).fill('码');
    await page.locator('.code-input input').nth(1).fill('B');
    await page.click('#auditBtn');
    await expect(errors).toContainText('不是纯 ASCII');
  });
});

test.describe('非侵入辨识复核（浏览器）', () => {
  test('成功：三位置机型给出 AA，逐轮列出位置映射，终态恒等且回执两两不同', async ({ page }) => {
    await page.goto('/');
    await page.click('#clearAll');
    await page.click('#addPos'); // 三行 P1/P2/P3
    await fillMachine(page, {
      positions: ['P1', 'P2', 'P3'],
      codes: ['A', 'B'],
      rows: {
        // A：P1/P2 互换、P3 不动；首轮 A 分出 P1，次轮 A 再分 P2/P3 并全体归位
        P1: { A: ['0', 'P2'], B: ['0', 'P1'] },
        P2: { A: ['1', 'P1'], B: ['1', 'P2'] },
        P3: { A: ['1', 'P3'], B: ['0', 'P3'] },
      },
    });
    await page.click('#nonIntrusiveBtn');

    const box = page.locator('#nonIntrusiveResult');
    await expect(box).toBeVisible();
    await expect(box).toHaveAttribute('data-outcome', 'success');
    await expect(box).toContainText('非侵入规范探测串');
    await expect(box).toContainText('长度 2');
    await expect(box).toContainText('恰好回到自身');

    const chips = box.locator('[data-testid="ni-sequence"] .seq-chip');
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(0)).toHaveText('"A"');
    await expect(chips.nth(1)).toHaveText('"A"');

    // 逐轮位置映射：第 1 轮 P1→P2、P2→P1（非恒等）；第 2 轮归位（恒等）
    await expect(box).toContainText('逐轮位置映射');
    await expect(box).toContainText('P1 → P2');
    await expect(box).toContainText('P2 → P1');
    await expect(box).toContainText('全部初态已分开');

    // 复算回执两两不同
    await expect(box).toContainText('完整回执串');
    // 普通审计区无结论（未发起）
    await expect(page.locator('#result')).toBeHidden();
  });

  test('无解：标准审计有解 B 但非侵入复核封闭族无终态，并列出未满足条件', async ({ page }) => {
    await page.goto('/');
    await page.click('#clearAll');
    await fillMachine(page, {
      positions: ['P1', 'P2'],
      codes: ['A', 'B'],
      rows: {
        P1: { A: ['1', 'P2'], B: ['1', 'P1'] },
        P2: { A: ['1', 'P1'], B: ['0', 'P1'] },
      },
    });

    // 普通审计与非侵入复核各自发起，结论并存
    await page.click('#auditBtn');
    const std = page.locator('#result');
    await expect(std).toHaveAttribute('data-outcome', 'success');
    await expect(std.locator('[data-testid="sequence"] .seq-chip')).toHaveText(['"B"']);

    await page.click('#nonIntrusiveBtn');
    const ni = page.locator('#nonIntrusiveResult');
    await expect(ni).toBeVisible();
    await expect(ni).toHaveAttribute('data-outcome', 'impossible');
    await expect(ni).toContainText('不存在满足非侵入约束的探测串');
    await expect(ni).toContainText('封闭');
    // 两个终态条件分别落空的说明
    await expect(ni.locator('[data-testid="ni-unmet"]')).toContainText('映射为恒等');
    await expect(ni.locator('[data-testid="ni-unmet"]')).toContainText('未分对');
    // 闭合状态族表：初态恒等，且存在“空对但非恒等”状态
    await expect(ni).toContainText('复合状态');

    // 修改任一转移定义：非侵入结论立即失效；普通结论保留
    await fillCell(page, 0, 'B', 'response', '0');
    await expect(ni).toBeHidden();
    await expect(std).toBeVisible();
    await expect(std).toHaveAttribute('data-outcome', 'success');

    // 恢复定义后重新发起，仍为无解（结论可重新操作获得）
    await fillCell(page, 0, 'B', 'response', '1');
    await page.click('#nonIntrusiveBtn');
    await expect(ni).toBeVisible();
    await expect(ni).toHaveAttribute('data-outcome', 'impossible');
  });

  test('超限：8 个位置不受理非侵入复核（给出说明），普通审计仍可操作', async ({ page }) => {
    await page.goto('/');
    await page.click('#clearAll');
    for (let i = 0; i < 6; i++) await page.click('#addPos'); // 2 + 6 = 8 行
    const positions = Array.from({ length: 8 }, (_, i) => `P${i + 1}`);
    const rows = {};
    for (let i = 0; i < 8; i++) {
      const p = positions[i];
      rows[p] = { A: [`r${i}`, p], B: [`s${i}`, p] }; // 自环，每位置回执互异
    }
    await fillMachine(page, { positions, codes: ['A', 'B'], rows });

    // 限制提示
    await expect(page.locator('#niLimitHint')).toContainText('超过非侵入复核上限 7');

    await page.click('#nonIntrusiveBtn');
    const ni = page.locator('#nonIntrusiveResult');
    await expect(ni).toBeVisible();
    await expect(ni).toHaveAttribute('data-outcome', 'exceeded');
    await expect(ni).toContainText('8 个位置');
    await expect(ni).toContainText('7 个上限');

    // 普通审计不受上限影响，仍可成功（码 A 单轮即区分）
    await page.click('#auditBtn');
    const std = page.locator('#result');
    await expect(std).toBeVisible();
    await expect(std).toHaveAttribute('data-outcome', 'success');
    await expect(std).toContainText('长度 1');
    await expect(ni).toBeVisible(); // 超限结论不受普通审计影响

    // 清空回到 2 行后，非侵入复核恢复受理（超限提示消失）
    await page.click('#clearAll');
    await expect(ni).toBeHidden();
    await expect(page.locator('#niLimitHint')).toContainText('当前 2 个');
  });
});
