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
  /** 填满当前网格：每个位置对每个码回执 0、下一位置指向自身。 */
  async function fillAllLoops(page, { response = '0' } = {}) {
    const rows = await page.locator('#gridBody tr').count();
    const codeCount = await page.locator('.code-input input').count();
    const codes = [];
    for (let i = 0; i < codeCount; i++) {
      codes.push(await page.locator('.code-input input').nth(i).inputValue());
    }
    for (let r = 0; r < rows; r++) {
      const pos = await page.locator('td.pos-col input.cell').nth(r).inputValue();
      for (const code of codes) {
        await fillCell(page, r, code, 'response', response);
        await fillCell(page, r, code, 'next', pos);
      }
    }
  }

  test('成功场景：换位机型 → 最短串 AA，逐轮映射换位后归位、终局全部复位', async ({ page }) => {
    await page.goto('/');
    await page.click('#clearAll');
    await fillMachine(page, {
      positions: ['s0', 's1'],
      codes: ['A', 'B'],
      rows: {
        s0: { A: ['0', 's1'], B: ['0', 's0'] },
        s1: { A: ['1', 's0'], B: ['0', 's0'] },
      },
    });
    await page.click('#niReviewBtn');

    const box = page.locator('#niResult');
    await expect(box).toBeVisible();
    await expect(box).toHaveAttribute('data-outcome', 'success');
    await expect(box).toContainText('存在非侵入规范探测串');
    await expect(box).toContainText('长度 2');
    const chips = box.locator('[data-testid="ni-sequence"] .seq-chip');
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(0)).toHaveText('"A"');
    await expect(chips.nth(1)).toHaveText('"A"');

    // 逐轮映射：第一轮后换位（非恒等），第二轮后归位
    await expect(box).toContainText('逐轮');
    await expect(box).toContainText('s0→s1');
    await expect(box).toContainText('s1→s0');
    await expect(box).toContainText('已恒等');
    await expect(box).toContainText('无未分对');
    // 终局全部回到自身
    await expect(box).toContainText('回到自身');
    await expect(page.locator('#niErrors')).toBeHidden();
  });

  test('无解场景：两初态恒同 → 闭合搜索范围、重合边与未满足的终态条件', async ({ page }) => {
    await page.goto('/');
    await page.click('#clearAll');
    await fillMachine(page, {
      positions: ['s0', 's1'],
      codes: ['A', 'B'],
      rows: {
        s0: { A: ['0', 's0'], B: ['0', 's0'] },
        s1: { A: ['0', 's0'], B: ['0', 's0'] },
      },
    });
    await page.click('#niReviewBtn');

    const box = page.locator('#niResult');
    await expect(box).toBeVisible();
    await expect(box).toHaveAttribute('data-outcome', 'impossible');
    await expect(box).toContainText('不存在满足非侵入约束');
    await expect(box).toContainText('闭合搜索范围');
    await expect(box).toContainText('轨迹重合');
    await expect(box).toContainText('仍有未分对');
    await expect(box).toContainText('s0 / s1');
    // 终态条件说明
    await expect(box).toContainText('恒等');
  });

  test('超限场景：8 个位置 → 复核被拒（错误面板给出上限与当前数量）', async ({ page }) => {
    await page.goto('/');
    await page.click('#clearAll'); // 2 行
    for (let i = 0; i < 6; i++) await page.click('#addPos'); // 共 8 个位置
    await expect.poll(async () => page.locator('#gridBody tr').count()).toBe(8);
    // 位置改名为 q0..q7 并填满自环转移（输入本身合法，仅超出复核受理上限）
    for (let i = 0; i < 8; i++) {
      await page.locator('td.pos-col input.cell').nth(i).fill(`q${i}`);
    }
    await fillAllLoops(page);

    await page.click('#niReviewBtn');
    const niErrors = page.locator('#niErrors');
    await expect(niErrors).toBeVisible();
    await expect(niErrors).toHaveAttribute('data-outcome', 'error');
    await expect(niErrors).toContainText('只受理不超过 7 个位置');
    await expect(niErrors).toContainText('当前为 8 个');
    await expect(page.locator('#niResult')).toBeHidden();
  });

  test('复核结论与普通审计并存，修改定义后复核结论立即失效而普通结论保留', async ({ page }) => {
    await page.goto('/');
    await page.click('#loadDemo');

    // 先做普通审计
    await page.click('#auditBtn');
    await expect(page.locator('#result')).toHaveAttribute('data-outcome', 'success');

    // 再发起非侵入复核：普通结论不被清除
    await page.click('#niReviewBtn');
    await expect(page.locator('#niResult')).toBeVisible();
    await expect(page.locator('#result')).toBeVisible();
    await expect(page.locator('#result')).toHaveAttribute('data-outcome', 'success');

    // 修改任一位置的定义 → 非侵入结论立即失效（隐藏），普通结论仍保留
    await fillCell(page, 0, 'A', 'response', '1');
    await expect(page.locator('#niResult')).toBeHidden();
    await expect(page.locator('#result')).toBeVisible();
    await expect(page.locator('#result')).toHaveAttribute('data-outcome', 'success');
  });
});
