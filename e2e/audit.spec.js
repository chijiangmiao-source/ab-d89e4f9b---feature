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
