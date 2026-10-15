import { test, expect, type Page } from '@playwright/test';
import { defaultRules } from '../../src/shared/contracts';
import { mkdir } from 'node:fs/promises';
import type { Progress } from '../../src/shared/contracts';

async function expectScope(page: Page) {
  await expect(page.locator('.analysis-sidebar')).toBeVisible();
}

async function expectAnalysisRules(page: Page) {
  await expect(page.getByRole('group', { name: '整理规则', exact: true })).toBeVisible();
}

test('real local API workflow: configure, natural-language rule, analyze, review, clean and undo', async ({ page }) => {
  await page.goto('/#session=' + 'a'.repeat(64));
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  await page.getByLabel('服务密钥', { exact: true }).fill('ui-test-key');
  await page.getByRole('button', { name: '邮箱设置', exact: true }).click();
  await page.getByLabel('邮箱密码', { exact: true }).fill('ui-test-password');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByText('设置已保存。')).toBeVisible();
  await expect(page.getByLabel('邮箱密码', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: '检查邮箱' }).click();
  await expect(page.locator('.toast').getByText('邮箱连接成功。')).toBeVisible();
  await expect(page.locator('.messages').getByText('邮箱连接成功。')).toHaveCount(0);
  await expect(page.getByText('连接成功', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '分析服务', exact: true }).click();
  await expect(page.getByLabel('服务密钥', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: '检查服务' }).click();
  await expect(page.getByText(/服务可用/)).toBeVisible();
  await page.getByRole('button', { name: '管理规则', exact: true }).click();
  await page.getByRole('button', { name: '添加规则', exact: true }).click();
  await expect(page.getByRole('button', { name: '添加', exact: true })).toBeDisabled();
  await page.getByLabel('规则名称', { exact: true }).fill('旧职位推荐');
  await page.getByLabel('处理条件').fill('清理旧职位推荐，但保留正在沟通的职位。');
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await expect(page.locator('.management-rule').first().getByRole('heading', { name: '旧职位推荐' })).toBeVisible();
  await page.getByRole('button', { name: '返回邮件', exact: true }).click();
  const newRule = page.getByLabel('使用规则：旧职位推荐', { exact: true });
  await expect(page.locator('.rule-selection-item').first()).toContainText('旧职位推荐');
  await newRule.uncheck(); await newRule.check();
  await expectAnalysisRules(page);
  await page.getByLabel('同意向 Jev 发送邮件文字。包括主题、发件人和正文。').check();
  await page.getByRole('button', { name: '开始分析' }).click();
  await expect(page.getByText(/^分析完成，共 .*查看结果，选好邮件后点击「整理」。$/)).toBeVisible();
  await page.getByRole('button', { name: /秋季促销，限时优惠/ }).click();
  await page.getByRole('button', { name: '查看正文', exact: true }).click();
  await expect(page.getByText('这是一封用于界面测试的合成邮件，不含真实个人信息。', { exact: true })).toBeVisible();
  await page.getByLabel('选择本页', { exact: true }).uncheck();
  await page.getByLabel('选择邮件：秋季促销，限时优惠').check();
  await page.locator('.selection-bar .rule-action').click();
  await expect(page.getByRole('heading', { name: '删除？', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认处理' }).click();
  await expect(page.getByText('整理中，已处理 0 / 1 封')).toBeVisible();
  await expect(page.getByRole('button', { name: '核对结果' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '整理', exact: true })).toBeDisabled();
  await page.reload();
  await expect(page.getByText('整理中，已处理 0 / 1 封')).toBeVisible();
  await expect(page.getByText('已将 1 封邮件 移到「Trash」。')).toBeVisible();
  await page.locator('.result-filters').getByRole('button', { name: '全部邮件', exact: true }).click();
  await expect(page.locator('.mail-row').filter({ hasText: '秋季促销，限时优惠' }).getByText('已移到「Trash」', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '核对结果' }).click();
  await expect(page.getByText('整理结果已更新。')).toBeVisible();
  await page.locator('.activity-toggle').click();
  await expect(page.getByText(/更新于/)).toBeVisible();
  await page.reload();
  await expect(page.getByText('已将 1 封邮件 移到「Trash」。')).toBeVisible();
  await expect(page.getByRole('button', { name: '撤销整理' })).toBeEnabled();
  await page.getByRole('button', { name: '撤销整理' }).click();
  await expect(page.getByText('撤销已结束，请查看最近整理。')).toBeVisible();
  await expect(page.getByText('已撤销最近整理，共 1 封邮件。')).toBeVisible();
  await page.locator('.result-filters').getByRole('button', { name: '全部邮件', exact: true }).click();
  await expect(page.getByLabel('选择邮件：订单付款成功，请保留')).toBeEnabled();
  await expect(page.getByLabel('选择邮件：未知结束时间的活动')).toBeEnabled();
  if (!process.env.JEVCLEAN_SKIP_CAPTURES) await page.screenshot({ path: 'docs/images/review-example.png', fullPage: true, animations: 'disabled' });
  await expectAnalysisRules(page);
  await page.getByRole('button', { name: '管理规则', exact: true }).click();
  await page.getByRole('button', { name: '编辑规则：广告推广', exact: true }).click();
  await page.getByLabel('处理条件').fill('只清理超过一年的广告。');
  await page.getByRole('button', { name: '完成编辑' }).click();
  await page.getByRole('button', { name: '返回邮件', exact: true }).click();
  await expect(page.getByText('规则或范围已变，请重新分析。仍可手动处理这些邮件。')).toBeVisible();
  await expect(page.locator('.selection-bar .rule-action')).toBeDisabled();
  await expectAnalysisRules(page);
  await page.getByRole('button', { name: '管理规则', exact: true }).click();
  await page.getByRole('button', { name: '保存修改' }).click();
  await expect(page.getByText('修改已保存，请重新分析。')).toBeVisible();
});
test('narrow viewport, credentials and privacy remain usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/#session=' + 'a'.repeat(64));
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByLabel('服务密钥', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: '邮箱设置', exact: true }).click();
  await expect(page.getByLabel('邮箱密码', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: '隐私记录', exact: true }).click();
  await expect(page.getByText('邮箱密码与服务密钥在本机加密保存。', { exact: true })).toBeVisible();
  await page.getByText('隐私说明', { exact: true }).click();
  await expect(page.getByText(/网页无法读回保存的密钥/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual(['jevclean.session']);
  if (!process.env.JEVCLEAN_SKIP_CAPTURES) await page.screenshot({ path: 'docs/images/narrow-layout.png', fullPage: true, animations: 'disabled' });
});

test('folders are selectable together, persist across reload, and Feishu is last', async ({ page }) => {
  await page.goto('/#session=' + 'a'.repeat(64));
  await expect(page.getByLabel('分析位置：INBOX', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '邮箱设置', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '邮箱服务', exact: true })).toBeVisible();
  const providerOptions = await page.getByRole('combobox', { name: '邮箱服务', exact: true }).locator('option').allTextContents();
  expect(providerOptions.at(-1)).toBe('飞书');
  await page.getByRole('button', { name: '返回邮件', exact: true }).click();
  await page.getByRole('button', { name: '刷新列表', exact: true }).click();
  await expect(page.getByLabel('分析位置：Archive', { exact: true })).toBeVisible();
  await page.getByLabel('分析位置：Archive', { exact: true }).check();
  await expect(page.getByLabel('分析位置：INBOX', { exact: true })).toBeChecked();
  await expect(page.getByText('已选 2 个文件夹')).toBeVisible();
  await expectAnalysisRules(page);
  await page.getByLabel('同意向 Jev 发送邮件文字。包括主题、发件人和正文。').check();
  await page.getByRole('button', { name: '开始分析' }).click();
  await expect(page.getByText(/^分析完成，共 .*查看结果，选好邮件后点击「整理」。$/)).toBeVisible();
  await expect(page.getByRole('button', { name: /存档中的促销邮件/ })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('分析位置：Archive', { exact: true })).toBeChecked();
  await expect(page.getByLabel('分析位置：INBOX', { exact: true })).toBeChecked();
  await page.getByLabel('分析位置：Archive', { exact: true }).uncheck();
  await page.getByLabel('分析位置：INBOX', { exact: true }).uncheck();
  await expect(page.getByText('保存中', { exact: true })).toHaveCount(0);
  await expectAnalysisRules(page);
  await expect(page.getByRole('button', { name: '开始分析' })).toBeDisabled();
  await expect(page.getByText('请至少选择一个文件夹。')).toBeVisible();
});

test('recent count validates, persists and limits the combined folders; all-mail scope is one choice', async ({ page }) => {
  await page.goto('/#session=' + 'a'.repeat(64));
  await page.getByRole('button', { name: '刷新列表', exact: true }).click();
  await page.getByLabel('分析位置：INBOX', { exact: true }).check();
  await page.getByLabel('分析位置：Archive', { exact: true }).check();
  const scope = page.getByRole('group', { name: '邮件范围', exact: true });
  const recent = scope.getByRole('button', { name: '最近邮件', exact: true });
  const all = scope.getByRole('button', { name: '全部邮件', exact: true });
  const count = page.getByRole('spinbutton', { name: '邮件数量', exact: true });
  await expect(recent).toHaveAttribute('aria-pressed', 'true'); await expect(count).toHaveValue('100');
  await expectAnalysisRules(page);
  await page.getByLabel('同意向 Jev 发送邮件文字。包括主题、发件人和正文。').check();
  for (const value of ['0', '', '-1', '1.5']) {
    await count.fill(value);
    await expect(page.getByText('邮件数量请填大于零的整数。', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '开始分析' })).toBeDisabled();
    await expect(page.locator('.analysis-sidebar').getByRole('button', { name: '保存修改' })).toHaveCount(0);
  }
  await count.fill('1'); await expect(page.getByText('保存中', { exact: true })).toHaveCount(0);
  await page.reload(); await expect(count).toHaveValue('1');
  await expectAnalysisRules(page);
  await page.getByLabel('同意向 Jev 发送邮件文字。包括主题、发件人和正文。').check();
  await page.getByRole('button', { name: '开始分析' }).click();
  await expect(page.getByText(/^分析完成，共 .*查看结果，选好邮件后点击「整理」。$/)).toBeVisible();
  await page.locator('.result-filters').getByRole('button', { name: '全部邮件', exact: true }).click();
  await expect(page.locator('.mail-row')).toHaveCount(1);
  await expect(page.getByRole('button', { name: /存档中的促销邮件/ })).toBeVisible();
  await expect(page.locator('.analysis-details')).toHaveCount(0);
  await expect(page.locator('.analysis-meta')).toContainText(/服务用量/);
  await expect(page.locator('.analysis-meta time')).toBeVisible();
  await all.click(); await expect(count).toHaveCount(0);
  await expect(page.getByText('保存中', { exact: true })).toHaveCount(0);
  await page.reload(); await expect(all).toHaveAttribute('aria-pressed', 'true'); await expect(count).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('one action per rule, move target required, and folder choice persists through execution and undo', async ({ page }) => {
  await page.goto('/#session=' + 'a'.repeat(64));
  const bootstrap = (await (await page.request.get('/api/bootstrap', { headers: { 'X-JevClean-Token': 'a'.repeat(64) } })).json()).value;
  await page.request.post('/api/config', { headers: { 'X-JevClean-Token': 'a'.repeat(64) }, data: { settings: { ...bootstrap.config.settings, mailboxes: ['INBOX'], scanLimit: 100, rules: bootstrap.config.settings.rules.map((rule: { id: string }) => ({ ...rule, enabled: rule.id === 'promotions', action: 'delete' })) } } });
  await page.reload();
  await expectAnalysisRules(page);
  await page.getByRole('button', { name: '管理规则', exact: true }).click();
  await page.getByLabel('处理方式：广告推广', { exact: true }).selectOption('move');
  await expect(page.getByLabel('移动位置：广告推广', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存修改', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '刷新列表', exact: true }).first().click();
  await page.getByLabel('移动位置：广告推广', { exact: true }).selectOption('Archive');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await page.reload();
  await expectAnalysisRules(page);
  await page.getByRole('button', { name: '管理规则', exact: true }).click();
  await expect(page.getByLabel('处理方式：广告推广', { exact: true })).toHaveValue('move');
  await expect(page.getByLabel('移动位置：广告推广', { exact: true })).toHaveValue('Archive');
  await page.getByRole('button', { name: '返回邮件', exact: true }).click();
  await expectAnalysisRules(page);
  await page.getByLabel('同意向 Jev 发送邮件文字。包括主题、发件人和正文。').check();
  await page.getByRole('button', { name: '开始分析' }).click();
  const row = page.locator('.mail-row').filter({ hasText: '秋季促销，限时优惠' });
  await expect(row.getByText('移动到「Archive」', { exact: true })).toBeVisible();
  await expect(row.locator('.action-badge')).toHaveText('移动到「Archive」');
  await page.getByLabel('选择邮件：秋季促销，限时优惠').check();
  await page.locator('.selection-bar .rule-action').click();
  await expect(page.locator('.confirmation > ul').getByText('移动到「Archive」', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认处理' }).click();
  await page.locator('.result-filters').getByRole('button', { name: '全部邮件', exact: true }).click();
  await expect(row.getByText('已移到「Archive」', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '撤销整理' }).click();
  await expect(row.getByText('已撤销', { exact: true })).toBeVisible();
});

test('multiple matching rules choose the strictest supported action before organizing', async ({ page }) => {
  const headers = { 'X-JevClean-Token': 'a'.repeat(64) };
  const state = (await (await page.request.get('/api/bootstrap', { headers })).json()).value;
  const primary = defaultRules.find(rule => rule.id === 'promotions')!;
  await page.request.post('/api/config', { headers, data: { settings: { ...state.config.settings, mailboxes: ['INBOX'], scanLimit: 100,
    rules: [{ ...primary, enabled: true, action: 'delete' }, { id: 'also', name: '读完推广', description: '营销群发邮件。', action: 'read', enabled: true }] } } });
  await page.goto('/#session=' + 'a'.repeat(64));
  await page.getByLabel('同意向 Jev 发送邮件文字。包括主题、发件人和正文。').check();
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  await expect(page.getByText(/^分析完成，共 .*查看结果，选好邮件后点击「整理」。$/)).toBeVisible();
  const row = page.locator('.mail-row').filter({ hasText: '秋季促销，限时优惠' });
  await expect(row.locator('.action-badge')).toHaveText('删除');
  await expect(row.getByRole('checkbox')).toBeChecked();
  await expect(row.getByLabel('处理方式：秋季促销，限时优惠')).toHaveCount(0);
  const after = (await (await page.request.get('/api/bootstrap', { headers })).json()).value;
  const record = after.report.records.find((item: { subject: string }) => item.subject === '秋季促销，限时优惠');
  expect(record.action).toBe('delete'); expect(record.category).toBe('clean');
  expect(record.verdicts.filter((verdict: { decision: string }) => verdict.decision === 'match')).toHaveLength(2);
  expect(record.matchedRules).toEqual(['promotions']); expect(record.status).toBe('pending');
  await expect(row).toContainText('多条规则符合，优先采用删除。');
});

test('equally ranked conflicting flags require choosing one; read action has progress, verification and reversible flags', async ({ page }) => {
  await page.goto('/#session=' + 'a'.repeat(64));
  const bootstrap = (await (await page.request.get('/api/bootstrap', { headers: { 'X-JevClean-Token': 'a'.repeat(64) } })).json()).value;
  const primary = bootstrap.config.settings.rules.find((rule: { id: string }) => rule.id === 'promotions');
  const saved = await page.request.post('/api/config', { headers: { 'X-JevClean-Token': 'a'.repeat(64) }, data: { settings: { ...bootstrap.config.settings, mailboxes: ['INBOX'], scanLimit: 100, rules: [{ ...primary, enabled: true, action: 'unread', targetMailbox: undefined }, { id: 'also', name: '读完推广', description: '营销群发邮件。', action: 'read', enabled: true }] }, imapPassword: 'synthetic-only', jevApiKey: 'synthetic-key' } });
  expect(saved.ok()).toBe(true); await page.reload();
  await expectAnalysisRules(page);
  await page.getByLabel('同意向 Jev 发送邮件文字。包括主题、发件人和正文。').check();
  await page.getByRole('button', { name: '开始分析' }).click();
  const row = page.locator('.mail-row').filter({ hasText: '秋季促销，限时优惠' });
  await page.getByRole('button', { name: '待查看', exact: true }).click();
  await expect(row.getByText('选择方式', { exact: true })).toBeVisible();
  await expect(page.getByLabel('选择邮件：秋季促销，限时优惠')).toBeEnabled();
  await page.getByLabel('处理方式：秋季促销，限时优惠').selectOption('also');
  await expect(row.locator('.action-badge').getByText('标为已读', { exact: true })).toBeVisible();
  await expect(page.getByLabel('选择邮件：秋季促销，限时优惠')).toBeChecked();
  await expect(page.getByRole('button', { name: '整理', exact: true })).toBeEnabled();
  await page.reload();
  await expect(page.getByLabel('处理方式：秋季促销，限时优惠')).toHaveValue('also');
  await page.getByLabel('选择邮件：秋季促销，限时优惠').check();
  await page.locator('.selection-bar .rule-action').click();
  await expect(page.locator('.confirmation > ul').getByText('标为已读', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认处理' }).click();
  await page.locator('.result-filters').getByRole('button', { name: '全部邮件', exact: true }).click();
  await expect(row.getByText('已读', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '核对结果' }).click();
  await expect(page.getByText('整理结果已更新。')).toBeVisible();
  await page.getByRole('button', { name: '撤销整理' }).click();
  await expect(row.getByText('已恢复之前的标记。', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('side analysis keeps setup in settings, preserves edits, and folder selection supports the keyboard', async ({ page }) => {
  await page.goto('/#session=' + 'a'.repeat(64));
  await expect(page.getByRole('heading', { name: '分析设置', exact: true })).toHaveCount(0);
  await expect(page.getByText('本次范围', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('服务密钥', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('分析位置：INBOX', { exact: true })).toBeVisible();
  const inbox = page.getByLabel('分析位置：INBOX', { exact: true });
  await inbox.focus(); await expect(inbox).toBeFocused();
  await page.keyboard.press('Space'); await expect(inbox).not.toBeChecked();
  await page.keyboard.press('Space'); await expect(inbox).toBeChecked();
  await expectAnalysisRules(page);
  await page.getByRole('button', { name: '管理规则', exact: true }).click();
  await page.getByRole('button', { name: '编辑规则：广告推广', exact: true }).click();
  const description = '用于界面测试的自然语言条件，保留需要处理的邮件。';
  await page.getByLabel('处理条件', { exact: true }).fill(description);
  await page.getByRole('button', { name: '返回邮件', exact: true }).click();
  await expect(page.locator('.selection-bar .rule-action')).toBeDisabled();
  await expectAnalysisRules(page);
  await page.getByRole('button', { name: '管理规则', exact: true }).click();
  await page.getByRole('button', { name: '编辑规则：广告推广', exact: true }).click();
  await expect(page.getByLabel('处理条件', { exact: true })).toHaveValue(description);
  await page.getByRole('button', { name: '完成编辑', exact: true }).click();
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await page.reload();
  await expectAnalysisRules(page);
  await page.getByRole('button', { name: '管理规则', exact: true }).click();
  await page.getByRole('button', { name: '编辑规则：广告推广', exact: true }).click();
  await expect(page.getByLabel('处理条件', { exact: true })).toHaveValue(description);
});

test('side analysis layout, batch selection, result filters and responsive design captures', async ({ page }) => {
  test.setTimeout(60000);
  await page.goto('/#session=' + 'a'.repeat(64));
  const headers = { 'X-JevClean-Token': 'a'.repeat(64) };
  const bootstrap = (await (await page.request.get('/api/bootstrap', { headers })).json()).value;
  await page.request.post('/api/config', { headers, data: { settings: { ...bootstrap.config.settings, rules: defaultRules, mailboxes: ['INBOX', 'Archive'], scanLimit: 100 } } });
  await page.reload();
  const layout = await page.evaluate(() => {
    const rail = document.querySelector('.analysis-sidebar')!.getBoundingClientRect();
    const results = document.querySelector('.mail-results-workspace')!.getBoundingClientRect();
    return { sideBySide: rail.right <= results.left, resultsWider: results.width > rail.width };
  });
  expect(layout).toEqual({ sideBySide: true, resultsWider: true });
  await expectAnalysisRules(page);
  await page.getByLabel('同意向 Jev 发送邮件文字。包括主题、发件人和正文。').check();
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  await expect(page.getByText(/^分析完成，共 .*查看结果，选好邮件后点击「整理」。$/)).toBeVisible();
  await page.getByRole('button', { name: '待查看', exact: true }).click();
  await expect(page.getByRole('button', { name: /未知结束时间的活动/ })).toBeVisible();
  await expect(page.getByLabel('选择本页', { exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '暂不整理', exact: true }).click();
  await expect(page.getByRole('button', { name: /订单付款成功，请保留/ })).toBeVisible();
  await page.getByRole('button', { name: '符合规则', exact: true }).click();
  await page.getByLabel('选择本页', { exact: true }).check();
  await expect(page.getByText('已选 3 封邮件', { exact: true })).toBeVisible();
  await page.locator('.selection-bar .rule-action').click();
  await page.getByRole('button', { name: '确认处理', exact: true }).click();
  await expect(page.getByText('整理完成，共处理 3 封邮件。', { exact: true })).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: '关闭提示', exact: true }).click();
  await page.locator('.result-filters').getByRole('button', { name: '全部邮件', exact: true }).click();

  const labelSynthetic = async () => page.evaluate(() => {
    document.querySelector('[data-synthetic-label]')?.remove();
    const label = document.createElement('span'); label.dataset.syntheticLabel = 'true'; label.textContent = '合成邮件示例';
    document.querySelector('.account-label')?.prepend(label);
  });
  await labelSynthetic();
  for (const [width, height, name, fullPage] of [
    [1505, 1045, 'hero-repro', false], [1440, 1000, 'desktop', true], [1320, 1000, 'user-1320', true], [390, 844, 'mobile', true],
  ] as const) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (!process.env.JEVCLEAN_SKIP_CAPTURES) await page.screenshot({ path: '.impeccable/review/' + name + '.png', fullPage, animations: 'disabled' });
  }
  await expectAnalysisRules(page);
  await page.getByRole('button', { name: '管理规则', exact: true }).click();
  await page.getByRole('button', { name: '编辑规则：验证码', exact: true }).click();
  await labelSynthetic();
  for (const [width, height, name] of [[1440, 1000, 'settings-desktop'], [390, 844, 'settings-mobile']] as const) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (!process.env.JEVCLEAN_SKIP_CAPTURES) await page.screenshot({ path: '.impeccable/review/' + name + '.png', fullPage: true, animations: 'disabled' });
  }
  await page.getByRole('button', { name: '完成编辑', exact: true }).click();
  await page.getByRole('button', { name: '返回邮件', exact: true }).click();
  await page.getByRole('button', { name: '撤销整理', exact: true }).click();
  await expect(page.getByText('撤销已结束，请查看最近整理。', { exact: true })).toBeVisible({ timeout: 20000 });

  // Stress only the rendered data boundary; never submit these synthetic IDs for execution.
  const finalState = (await (await page.request.get('/api/bootstrap', { headers })).json()).value;
  const source = finalState.report.records[0];
  const records = Array.from({ length: 1500 }, (_, i) => ({ ...source, id: 'layout_' + i, subject: '很长的邮件主题'.repeat(15) + i,
    sender: 'long-address'.repeat(15) + '@example.com', mailbox: '很长的文件夹路径'.repeat(18), reason: '一段很长的判断原因。'.repeat(30),
    status: 'pending', category: 'review', eligible: false, conflicts: undefined }));
  await page.route('**/api/bootstrap', route => route.fulfill({ json: { ok: true, value: { ...finalState, report: { ...finalState.report, records } } } }));
  await page.reload(); await page.locator('.result-filters').getByRole('button', { name: '全部邮件', exact: true }).click();
  await expect(page.locator('.mail-row')).toHaveCount(1500);
  for (const width of [390, 800, 1024, 1100, 1101, 1200, 1320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  await page.unroute('**/api/bootstrap');
});

test('connection toast expires, status survives reload, rule selection moves to the analysis area, and bounded folder lists remain keyboard-accessible', async ({ page }) => {
  await page.goto('/#session=' + 'a'.repeat(64));
  await page.getByRole('button', { name: '刷新列表', exact: true }).click();
  await expect(page.locator('.toast')).toBeVisible();
  await expect(page.locator('.header-actions').getByText('连接成功', { exact: true })).toBeVisible();
  await expect(page.locator('.messages').getByText('邮箱连接成功。')).toHaveCount(0);
  await expect(page.locator('.toast')).toHaveCount(0, { timeout: 7000 });
  await page.setViewportSize({ width: 390, height: 844 });
  await expectScope(page);
  const geometry = await page.locator('.folder-list').evaluate(element => {
    const styles = getComputedStyle(element); const row = element.querySelector('label')!;
    return { rows: (element.clientHeight - parseFloat(styles.paddingTop) - parseFloat(styles.paddingBottom)) / row.getBoundingClientRect().height,
      scrollable: element.scrollHeight > element.clientHeight, overflow: styles.overflowY };
  });
  expect(geometry.rows).toBeGreaterThanOrEqual(3);
  expect(geometry.overflow).toBe('auto');
  await page.getByLabel('分析位置：Junk', { exact: true }).focus();
  await expect(page.getByLabel('分析位置：Junk', { exact: true })).toBeInViewport();
  await expectAnalysisRules(page);
  const selection = page.getByRole('group', { name: '整理规则', exact: true });
  await expect(selection.getByRole('checkbox')).toHaveCount(defaultRules.length);
  for (const checkbox of await selection.getByRole('checkbox').all()) await checkbox.uncheck();
  await expect(page.getByRole('button', { name: '开始分析', exact: true })).toBeDisabled();
  await selection.getByLabel('使用规则：广告推广', { exact: true }).check();
  await expect(page.getByText('保存中', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('连接成功', { exact: true })).toBeVisible();
  await expectAnalysisRules(page);
  await expect(selection.getByLabel('使用规则：广告推广', { exact: true })).toBeChecked();
  await expect(selection.getByLabel('使用规则：验证码', { exact: true })).not.toBeChecked();
  await expectAnalysisRules(page);
  await page.getByRole('button', { name: '管理规则', exact: true }).click();
  await expect(page.locator('.rules-section').getByRole('checkbox')).toHaveCount(0);
});

test('English UI persists without changing rules, mail, credentials or candidate policy', async ({ page }) => {
  await page.goto('/#session=' + 'a'.repeat(64));
  const headers = { 'X-JevClean-Token': 'a'.repeat(64) };
  const before = (await (await page.request.get('/api/bootstrap', { headers })).json()).value;
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByLabel('服务密钥', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: '邮箱设置', exact: true }).click();
  await expect(page.getByLabel('邮箱地址', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '显示语言', exact: true }).click();
  await page.getByRole('combobox', { name: '显示语言', exact: true }).selectOption('en');
  await expect(page.locator('.settings-tabs').getByRole('button', { name: 'Display language', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  const after = (await (await page.request.get('/api/bootstrap', { headers })).json()).value;
  expect(after.config.settings.language).toBe('en');
  expect(after.config.policyHash).toBe(before.config.policyHash);
  expect(after.config.settings.rules).toEqual(before.config.settings.rules);
  expect(after.config.hasImapPassword).toBe(true); expect(after.config.hasJevApiKey).toBe(true);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { name: 'Analysis setup', exact: true })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Organization rules', exact: true })).toBeVisible();
  await page.locator('.result-filters').getByRole('button', { name: 'All mail', exact: true }).click();
  await expect(page.getByRole('button', { name: /秋季促销，限时优惠/ })).toBeVisible();
  await expect(page.locator('.mail-columns')).toContainText('Analysis judgment');
  await expect(page.locator('.mail-columns')).toContainText('Action result');
  await expect(page.locator('.mail-row').first().locator('.mail-verdict')).not.toContainText('未处理');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.settings-tabs').getByRole('button', { name: 'Display language', exact: true }).click();
  await page.getByRole('combobox', { name: 'Display language', exact: true }).selectOption('zh-CN');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  // Capture the requested controls in both languages and viewport classes, with synthetic data only.
  const labelled = async () => page.evaluate(() => {
    const label = document.createElement('span'); label.textContent = '合成邮件示例'; document.querySelector('.account-label')?.prepend(label);
  });
  await labelled();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (!process.env.JEVCLEAN_SKIP_CAPTURES) await page.screenshot({ path: '.impeccable/review/copy-controls-zh-' + width + '.png', fullPage: true, animations: 'disabled' });
  }
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '显示语言', exact: true }).click();
  await page.getByRole('combobox', { name: '显示语言', exact: true }).selectOption('en');
  await page.getByRole('button', { name: 'Back to mail', exact: true }).click();
  await page.locator('.result-filters').getByRole('button', { name: 'All mail', exact: true }).click();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (!process.env.JEVCLEAN_SKIP_CAPTURES) await page.screenshot({ path: '.impeccable/review/copy-controls-en-' + width + '.png', fullPage: true, animations: 'disabled' });
  }
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.settings-tabs').getByRole('button', { name: 'Display language', exact: true }).click();
  await page.getByRole('combobox', { name: 'Display language', exact: true }).selectOption('zh-CN');
  await page.getByRole('button', { name: '返回邮件', exact: true }).click();
});

test('header stop calls authenticated shutdown and shows the closed state', async ({ page }) => {
  await page.goto('/#session=' + 'a'.repeat(64));
  let called = false;
  await page.route('**/api/shutdown', async route => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['x-jevclean-token']).toBe('a'.repeat(64));
    called = true; await route.fulfill({ json: { ok: true, value: null } });
  });
  await page.getByLabel('应用菜单', { exact: true }).click();
  await page.getByRole('button', { name: '退出应用', exact: true }).click();
  await expect(page.getByRole('heading', { name: '已退出', exact: true })).toBeVisible();
  expect(called).toBe(true);
});

test('missing action destination stops before analysis and opens its folder repair in settings', async ({ page }) => {
  const headers = { 'X-JevClean-Token': 'a'.repeat(64) };
  await page.goto('/#session=' + 'a'.repeat(64));
  const current = (await (await page.request.get('/api/bootstrap', { headers })).json()).value;
  await page.request.post('/api/delete-reports', { headers, data: {} });
  await page.request.post('/api/config', { headers, data: { settings: { ...current.config.settings, host: 'missing-target.example.com', rules: defaultRules, mailboxes: ['INBOX'], scanLimit: 100, actionFolders: {}, language: 'zh-CN' }, imapPassword: 'ui-test-password', jevApiKey: 'ui-test-key' } });
  await page.reload();
  let scanRequests = 0; page.on('request', request => { if (new URL(request.url()).pathname === '/api/scan') scanRequests++; });
  await expectAnalysisRules(page);
  await page.getByLabel('同意向 Jev 发送邮件文字。包括主题、发件人和正文。').check();
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  await expect(page.getByRole('heading', { name: '请选择存放位置或更改处理方式。', exact: true })).toBeVisible();
  await expect(page.getByText('请先解决设置问题，未调用 Jev。', { exact: true })).toBeVisible();
  await expect(page.locator('.settings-workspace #action-setup')).toBeVisible();
  const target = page.getByLabel('删除去向', { exact: true }); await expect(target).toBeVisible();
  expect(scanRequests).toBe(0);
  expect((await (await page.request.get('/api/bootstrap', { headers })).json()).value.report).toBeNull();
  await mkdir('.impeccable/review', { recursive: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('.analysis-sidebar')?.scrollTo(0, 0); });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (!process.env.JEVCLEAN_SKIP_CAPTURES) await page.screenshot({ path: '.impeccable/review/copy-action-config-zh-' + width + '.png', fullPage: true, animations: 'disabled' });
  }
  await target.selectOption('Trash');
  await page.getByRole('button', { name: '保存检查', exact: true }).click();
  await expect(page.locator('.action-setup.ready').getByText('删除后移到「Trash」', { exact: true })).toBeVisible();
  await expect(page.getByText('检查完成，可开始分析，未调用 Jev。', { exact: true })).toBeVisible();
  await expect(page.getByText('检查完成，可继续处理原分析中的邮件。', { exact: true })).toHaveCount(0);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('.analysis-sidebar')?.scrollTo(0, 0); });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (!process.env.JEVCLEAN_SKIP_CAPTURES) await page.screenshot({ path: '.impeccable/review/copy-action-first-ready-zh-' + width + '.png', fullPage: true, animations: 'disabled' });
  }
  expect(scanRequests).toBe(0);
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  await expect(page.getByText(/^分析完成，共 .*查看结果，选好邮件后点击「整理」。$/)).toBeVisible();
  expect(scanRequests).toBe(1);
  await expect(page.getByLabel('选择邮件：秋季促销，限时优惠')).toBeEnabled();
});

test('a saved blocked report without cached preflight opens repair and reuses the original paid judgments', async ({ page }) => {
  const headers = { 'X-JevClean-Token': 'a'.repeat(64) };
  await page.goto('/#session=' + 'a'.repeat(64));
  const initial = (await (await page.request.get('/api/bootstrap', { headers })).json()).value;
  await page.request.post('/api/config', { headers, data: { settings: { ...initial.config.settings, email: 'synthetic@example.com', host: 'missing-target.example.com', rules: defaultRules, mailboxes: ['INBOX', 'Archive'], scanLimit: 100, actionFolders: { trash: 'Trash' }, language: 'zh-CN' }, imapPassword: 'synthetic-only', jevApiKey: 'synthetic-only' } });
  await page.request.post('/api/scan', { headers, data: { consent: true } });
  const before = (await (await page.request.get('/api/bootstrap', { headers })).json()).value;
  const ai = JSON.stringify(before.report.records.map((record: { verdicts: unknown }) => record.verdicts));
  await page.request.post('/api/config', { headers, data: { settings: { ...before.config.settings, actionFolders: {} } } });
  await page.request.post('/api/check-actions', { headers, data: {} });
  // Preflight is process-local; a saved blocked report can outlive that cached check.
  let omitCachedPreflight = true;
  let additionalScans = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/scan') additionalScans++; });
  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch();
    const payload = await response.json();
    if (omitCachedPreflight) payload.value.preflight = null;
    await route.fulfill({ response, json: payload });
  });
  await page.reload();
  const checkbox = page.getByLabel('选择邮件：秋季促销，限时优惠'); await expect(checkbox).toBeEnabled();
  await expect(checkbox.locator('..')).toHaveAttribute('title', '选择邮件');
  await checkbox.check();
  await expect(page.locator('.selection-bar .rule-action')).toBeDisabled();
  await expect(page.locator('.manual-toolbar').getByRole('button', { name: '归档', exact: true })).toBeEnabled();
  const row = page.locator('.mail-row').filter({ hasText: '秋季促销，限时优惠' });
  await expect(row.getByText('删除', { exact: true })).toBeVisible();
  await expect(row.getByText('待选位置', { exact: true })).toBeVisible();
  await expect(row.getByText('选择方式', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '待查看', exact: true }).click();
  await expect(page.getByRole('button', { name: /未知结束时间的活动/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /秋季促销，限时优惠/ })).toHaveCount(0);
  await page.getByRole('button', { name: '符合规则', exact: true }).click();
  await page.evaluate(() => { const account = document.querySelector('.account-label'); if (account) account.append(' · Synthetic mail example / 合成邮件示例'); });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('.analysis-sidebar')?.scrollTo(0, 0); });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (!process.env.JEVCLEAN_SKIP_CAPTURES) await page.screenshot({ path: '.impeccable/review/copy-action-blocked-zh-' + width + '.png', fullPage: true, animations: 'disabled' });
  }
  await row.getByRole('button', { name: '存放位置', exact: true }).click();
  const repair = page.locator('.settings-workspace #action-setup');
  await expect(repair).toBeVisible();
  const recheck = repair.getByRole('button', { name: '检查邮箱', exact: true });
  await expect(recheck).toBeFocused();
  await expect(repair.getByLabel('删除去向', { exact: true })).toHaveCount(0);
  omitCachedPreflight = false;
  await recheck.click();
  await expect(repair.getByLabel('删除去向', { exact: true })).toBeVisible();
  await repair.getByLabel('删除去向', { exact: true }).selectOption('Trash');
  await page.getByRole('button', { name: '保存检查', exact: true }).click();
  await expect(page.getByText('检查完成，可继续处理原分析中的邮件。', { exact: true })).toBeVisible();
  await expect(checkbox).toBeEnabled();
  const repaired = (await (await page.request.get('/api/bootstrap', { headers })).json()).value;
  expect(repaired.report.id).toBe(before.report.id); expect(repaired.report.apiCalls).toBe(before.report.apiCalls);
  expect(JSON.stringify(repaired.report.records.map((record: { verdicts: unknown }) => record.verdicts))).toBe(ai);
  expect(additionalScans).toBe(0);
  for (const language of ['zh-CN', 'en']) {
    const current = (await (await page.request.get('/api/bootstrap', { headers })).json()).value;
    await page.request.post('/api/config', { headers, data: { settings: { ...current.config.settings, language } } });
    await page.reload();
    await expect(page.locator('.action-setup.ready').getByText(language === 'en' ? 'Move deleted mail to “Trash”' : '删除后移到「Trash」', { exact: true })).toBeVisible();
    await expect(page.locator('.action-setup.ready').getByRole('button')).toHaveCount(0);
    await expect(page.locator('.action-setup.ready').locator('summary, details')).toHaveCount(0);
    await page.evaluate(() => { const account = document.querySelector('.account-label'); if (account) account.append(' · Synthetic mail example / 合成邮件示例'); });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('.analysis-sidebar')?.scrollTo(0, 0); });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (!process.env.JEVCLEAN_SKIP_CAPTURES) await page.screenshot({ path: '.impeccable/review/copy-action-results-' + language + '-' + width + '.png', fullPage: true, animations: 'disabled' });
    }
  }
  // Restore the synthetic provider and Chinese settings for any subsequent UI work.
  await page.request.post('/api/config', { headers, data: { settings: { ...repaired.config.settings, host: 'imap.example.com', language: 'zh-CN', actionFolders: {} }, imapPassword: 'ui-test-password' } });
});

test('plain copy distinguishes blocked actions, model ambiguity, analysis failure and unknown operation outcomes', async ({ page }) => {
  await page.goto('/#session=' + 'a'.repeat(64));
  const headers = { 'X-JevClean-Token': 'a'.repeat(64) };
  const before = (await (await page.request.get('/api/bootstrap', { headers })).json()).value;
  const base = { ...before.report.records.find((r: { category: string }) => r.category === 'clean'), action: 'delete' };
  const records = [
    { ...base, id: 'copy-blocked', subject: '缺少存放位置', status: 'pending', category: 'clean', eligible: true, conflicts: undefined, execution: { state: 'blocked', code: 'missing_destination' } },
    { ...base, id: 'copy-unknown', subject: '结果尚未确认的邮件', status: 'uncertain', category: 'clean', eligible: true, conflicts: undefined },
    { ...base, id: 'copy-complete', subject: '已经整理的邮件', status: 'moved', category: 'clean', eligible: true, destinationPath: '已删除', conflicts: undefined },
    { ...base, id: 'copy-review', subject: '无法确定时间的邮件', status: 'pending', category: 'review', eligible: false, reason: '缺少可确认的时间依据。', conflicts: undefined },
    { ...base, id: 'copy-failed', subject: '未分析成功的邮件', status: 'pending', category: 'review', eligible: false, verdicts: [], reason: '判断请求未完成，这封邮件保留。', conflicts: undefined },
  ];
  const value = { ...before, report: { ...before.report, accountIdentity: before.config.accountIdentity, policyHash: before.config.policyHash, judgmentHash: before.config.judgmentHash, records }, cleanup: { reportId: before.report.id, total: 3, moved: 1, restored: 0, failed: 1, uncertain: 1 }, canUndo: true,
    progress: { phase: 'idle', processed: 0, total: 0 }, preflight: { ...before.preflight, ready: false, checks: [{ action: 'delete', state: 'blocked', code: 'missing_destination', ruleNames: ['广告推广'] }] } };
  let executions = 0; let scans = 0; let refreshes = 0;
  page.on('request', request => { const path = new URL(request.url()).pathname; if (path === '/api/execute') executions++; if (path === '/api/scan') scans++; });
  await page.route('**/api/bootstrap', route => route.fulfill({ json: { ok: true, value } }));
  await page.route('**/api/refresh-actions', route => { refreshes++; return route.fulfill({ json: { ok: true, value: { report: value.report, cleanup: value.cleanup, canUndo: true, moved: 1, failed: 1, uncertain: 1 } } }); });
  await page.reload();
  await expect(page.locator('.mail-row')).toHaveCount(3);
  const blocked = page.locator('.mail-row').filter({ hasText: '缺少存放位置' });
  await expect(blocked.getByText('删除', { exact: true })).toBeVisible();
  await expect(blocked.getByText('待选位置', { exact: true })).toBeVisible();
  await expect(blocked.getByRole('checkbox')).toBeEnabled();
  await blocked.getByRole('button', { name: '存放位置', exact: true }).click();
  await expect(page.getByLabel('删除去向', { exact: true })).toBeFocused();
  await page.getByRole('button', { name: '返回邮件', exact: true }).click();
  await page.getByRole('button', { name: '待查看', exact: true }).click();
  const review = page.locator('.mail-row').filter({ hasText: '无法确定时间的邮件' });
  await expect(review.getByText('时间要求是否满足不明确，请查看邮件。', { exact: true })).toBeVisible();
  await expect(page.locator('.mail-row').filter({ hasText: '未分析成功的邮件' }).getByText('未获结果', { exact: true })).toBeVisible();
  await page.locator('.result-filters').getByRole('button', { name: '全部邮件', exact: true }).click();
  const unknown = page.locator('.mail-row').filter({ hasText: '结果尚未确认的邮件' });
  await expect(unknown.getByRole('checkbox')).toBeDisabled();
  await expect(unknown.getByText('处理结果未确认，请先核对结果。确认前不要重复处理。', { exact: true })).toBeVisible();
  await unknown.getByRole('button', { name: '核对结果', exact: true }).click();
  await expect(page.getByText('仍有 1 封邮件 结果待核对。请在原邮箱应用中检查。', { exact: true })).toBeVisible();
  expect(refreshes).toBe(1); expect(executions).toBe(0); expect(scans).toBe(0);
  await expect(page.locator('.cleanup-result')).not.toContainText('已撤销 0');
  await expect(page.locator('.mail-row').filter({ hasText: '已经整理的邮件' }).getByText('已移到「已删除」', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('technical details are opt-in, folder names remain literal, and English action confirmations identify the consequence', async ({ page }) => {
  await page.goto('/#session=' + 'a'.repeat(64));
  const headers = { 'X-JevClean-Token': 'a'.repeat(64) };
  const before = (await (await page.request.get('/api/bootstrap', { headers })).json()).value;
  const base = { ...before.report.records.find((r: { category: string }) => r.category === 'clean'), action: 'delete' };
  const record = { ...base, id: 'copy-english', subject: '合成邮件 / unchanged', status: 'pending', category: 'clean', action: 'delete', eligible: true, targetMailbox: '已删除', conflicts: undefined, execution: { state: 'ready' } };
  const value = { ...before, config: { ...before.config, settings: { ...before.config.settings, language: 'en' } }, report: { ...before.report, accountIdentity: before.config.accountIdentity, policyHash: before.config.policyHash, judgmentHash: before.config.judgmentHash, records: [record] }, cleanup: null, canUndo: false, progress: { phase: 'idle', processed: 0, total: 0 }, preflight: { ...before.preflight, ready: true, checks: [{ action: 'delete', state: 'ready', targetMailbox: '已删除', ruleNames: ['广告推广'] }] } };
  await page.route('**/api/bootstrap', route => route.fulfill({ json: { ok: true, value } }));
  await page.route('**/api/preview', route => route.fulfill({ json: { ok: true, value: { subject: record.subject, originalText: 'Synthetic text only.', sentToJev: '{"synthetic":true}', usesCurrentRules: true } } }));
  await page.reload();
  await expect(page.locator('.action-setup.ready')).toContainText('Move deleted mail to “已删除”');
  await expect(page.locator('.action-setup.ready').locator('summary, details, button')).toHaveCount(0);
  await page.getByRole('button', { name: /合成邮件 \/ unchanged/ }).click();
  await expect(page.getByText('Synthetic text only.', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Read text', exact: true }).click();
  await expect(page.getByText('Synthetic text only.', { exact: true })).toBeVisible();
  await expect(page.locator('.technical-details')).not.toHaveAttribute('open');
  await expect(page.getByText('This preview is reconstructed from current content and may differ from what was sent to Jev at the time.')).not.toBeVisible();
  await page.locator('.technical-details > summary').click();
  await expect(page.getByText('This preview is reconstructed from current content and may differ from what was sent to Jev at the time.')).toBeVisible();
  await page.getByLabel('Select email: 合成邮件 / unchanged').check();
  await page.getByRole('button', { name: 'Organize', exact: true }).click();
  await expect(page.locator('.confirmation').getByRole('heading', { name: 'Delete?', exact: true })).toBeVisible();
  await expect(page.locator('.confirmation')).toContainText('Move deleted mail to “已删除”');
  await expect(page.locator('.confirmation')).toContainText('does not permanently delete');
  await page.setViewportSize({ width: 800, height: 900 });
  // Equivalent to an 800px display at 200%: 400 CSS pixels, 2 device pixels per CSS pixel.
  const display = await page.context().newCDPSession(page);
  await display.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 450, deviceScaleFactor: 2, mobile: false });
  expect(await page.evaluate(() => innerWidth)).toBe(400);
  // Let Chromium apply the media-query layout after the CDP viewport override.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('analysis preferences autosave, survive rapid toggles and reload, and preserve unrelated drafts after retry', async ({ page }) => {
  await page.goto('/#session=' + 'a'.repeat(64));
  const headers = { 'X-JevClean-Token': 'a'.repeat(64) };
  const initial = (await (await page.request.get('/api/bootstrap', { headers })).json()).value;
  await expectAnalysisRules(page);
  await page.getByLabel('同意向 Jev 发送邮件文字。包括主题、发件人和正文。').check();
  await expect(page.getByText('保存中', { exact: true })).toHaveCount(0);
  let sent = 0; let rejected = false;
  await page.route('**/api/analysis-settings', async route => {
    sent++;
    if (!rejected) { rejected = true; await route.fulfill({ status: 503, json: { ok: false, error: '合成保存失败' } }); }
    else await route.continue();
  });
  await expectAnalysisRules(page);
  await page.getByLabel('同意向 Jev 发送邮件文字。包括主题、发件人和正文。').uncheck();
  await expect(page.getByText('修改未保存，请重试。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '开始分析', exact: true })).toBeDisabled();
  await expect(page.locator('.analysis-sidebar').getByRole('button', { name: '保存修改', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '重新保存', exact: true }).click();
  await expect(page.getByText('修改未保存，请重试。', { exact: true })).toHaveCount(0);
  await expect(page.getByText('保存中', { exact: true })).toHaveCount(0);
  await page.reload();
  await expectAnalysisRules(page);
  await expect(page.getByLabel('同意向 Jev 发送邮件文字。包括主题、发件人和正文。')).not.toBeChecked();
  await expectAnalysisRules(page);
  await page.getByRole('button', { name: '管理规则', exact: true }).click();
  await page.getByRole('button', { name: '编辑规则：广告推广', exact: true }).click();
  await page.getByLabel('处理条件', { exact: true }).fill('未保存的规则草稿，必须保持在编辑区');
  await page.getByRole('button', { name: '返回邮件', exact: true }).click();
  const selection = page.getByLabel('使用规则：广告推广', { exact: true });
  await selection.uncheck(); await selection.check(); await selection.uncheck();
  await expect(page.getByText('保存中', { exact: true })).toHaveCount(0);
  const latest = (await (await page.request.get('/api/bootstrap', { headers })).json()).value;
  expect(latest.config.settings.rules.find((r: { id: string }) => r.id === 'promotions').enabled).toBe(false);
  expect(latest.config.settings.rules.map((r: { description: string }) => r.description)).toEqual(initial.config.settings.rules.map((r: { description: string }) => r.description));
  expect(latest.config.hasImapPassword).toBe(initial.config.hasImapPassword); expect(latest.config.hasJevApiKey).toBe(initial.config.hasJevApiKey);
  expect(latest.report.apiCalls).toBe(initial.report.apiCalls); expect(sent).toBeGreaterThanOrEqual(2);
  await expectAnalysisRules(page);
  await page.getByRole('button', { name: '管理规则', exact: true }).click();
  await page.getByRole('button', { name: '编辑规则：广告推广', exact: true }).click();
  await expect(page.getByLabel('处理条件', { exact: true })).toHaveValue('未保存的规则草稿，必须保持在编辑区');
  await page.reload();
  await expectAnalysisRules(page);
  await expect(page.getByLabel('使用规则：广告推广', { exact: true })).not.toBeChecked();
  expect(Object.keys(await page.evaluate(() => Object.fromEntries(Object.entries(localStorage))))).toEqual([]);
});

test('automatic verification uses the actual stage and separates nine organized emails from 1497 folder entries in both languages', async ({ page }) => {
  const headers = { 'X-JevClean-Token': 'a'.repeat(64) };
  const initial = (await (await page.request.get('/api/bootstrap', { headers })).json()).value;
  await page.request.post('/api/config', { headers, data: { settings: { ...initial.config.settings, email: 'ui@example.com', host: 'imap.example.com', language: 'zh-CN', mailboxes: ['INBOX'], scanLimit: 100, actionFolders: {}, rules: defaultRules }, imapPassword: 'ui-test-password', jevApiKey: 'ui-test-key' } });
  await page.request.post('/api/scan', { headers, data: { consent: true } });
  const before = (await (await page.request.get('/api/bootstrap', { headers })).json()).value;
  const base = before.report.records[0];
  const records = Array.from({ length: 9 }, (_, index) => ({ ...base, id: 'progress-' + index, subject: '合成进度邮件 ' + index, status: index < 7 ? 'moved' : 'uncertain', lastOperation: 'move', error: index < 7 ? undefined : '移动结果尚未确认，可点击“核对操作结果”查询。请勿重复执行。', category: 'clean', eligible: true, action: 'delete', conflicts: undefined, destinationPath: 'Trash' }));
  let progress: Progress;
  let value: typeof before;
  let executions = 0;
  await page.route('**/api/bootstrap', route => route.fulfill({ json: { ok: true, value } }));
  await page.route('**/api/status', route => route.fulfill({ json: { ok: true, value: progress } }));
  await page.route('**/api/execute', route => { executions++; return route.fulfill({ status: 400, json: { ok: false, error: 'Unexpected execution' } }); });
  for (const language of ['zh-CN', 'en']) {
    value = { ...before, config: { ...before.config, settings: { ...before.config.settings, language } }, report: { ...before.report, total: 100, processed: 100, scanLimit: 100, records },
      cleanup: { total: 9, moved: 7, restored: 0, failed: 0, uncertain: 2 }, canUndo: true,
      progress: { phase: 'moving', processed: 9, total: 9, operationIds: records.map(record => record.id) } };
    progress = { phase: 'checking', processed: 0, total: 2, operationTotal: 9, operationIds: records.map(record => record.id), folderCheck: { mailbox: 'INBOX', processed: 200, total: 1497 } };
    await page.goto('/#session=' + 'a'.repeat(64));
    // A hash-only visit to the same address does not reload the app for the next language fixture.
    await page.reload();
    const panel = page.locator('.cleanup-result');
    const heading = language === 'en' ? 'Checking results' : '核对中';
    const main = language === 'en' ? 'Checking the organization results for 9 emails' : '正在核对 9 封邮件 的结果';
    const entry = language === 'en' ? 'Checking the email list in “INBOX”: 200 / 1497 entries' : '检查「INBOX」：200 / 1497 条';
    await expect(panel.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await expect(panel).toHaveClass(/is-active/);
    await expect(panel).not.toHaveClass(/needs-attention/);
    await expect(panel.getByText(main, { exact: true })).toBeVisible();
    await expect(panel.getByText(entry, { exact: true })).toBeVisible();
    await expect(panel.getByRole('progressbar')).toHaveAttribute('aria-label', entry);
    await expect(panel.getByRole('button', { name: language === 'en' ? 'Check results' : '核对结果', exact: true })).toHaveCount(0);
    await expect(panel.locator('.operation-issues')).toHaveCount(0);
    const checkingRow = page.locator('.mail-row').filter({ hasText: '合成进度邮件 7' });
    await expect(checkingRow.locator('.execution-state')).toHaveText(language === 'en' ? 'Checking results' : '核对中');
    await expect(checkingRow.locator('.execution-state')).toHaveClass(/status-checking/);
    await expect(checkingRow.getByRole('button', { name: language === 'en' ? 'Check results' : '核对结果', exact: true })).toHaveCount(0);
    await expect(checkingRow).not.toContainText(language === 'en' ? 'not confirmed' : '结果待查');
    await expect(page.locator('.mail-row').filter({ hasText: '合成进度邮件 0' }).locator('.execution-state')).toHaveText(language === 'en' ? 'Moved to “Trash”' : '已移到「Trash」');
    await expect(panel).not.toContainText(language === 'en' ? '200 / 1497 processed' : '已处理 200 / 1497 封');
    await page.reload();
    await expect(panel.getByText(main, { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    progress.folderCheck = { mailbox: '归档/必须保留的原始文件夹名称', processed: 0, total: 17 };
    await expect(panel).toContainText('归档/必须保留的原始文件夹名称');
    await expect(panel).toContainText('0 / 17');
    await expect(panel.getByText(main, { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    progress = { phase: 'checking', processed: 1, total: 2, operationTotal: 9, operationIds: records.map(record => record.id) };
    await expect(panel.getByText(language === 'en' ? 'Checked 1 / 2 emails' : '已核对 1 / 2 封', { exact: true })).toBeVisible();
    progress = { phase: 'complete', processed: 9, total: 9 }; value.progress = progress;
    await expect(panel.getByRole('heading', { name: language === 'en' ? 'Latest organization' : '最近整理', exact: true })).toBeVisible();
    await expect(panel).toHaveClass(/needs-attention/);
    await expect(panel).not.toHaveClass(/is-active/);
    await expect(page.locator('.messages [role="status"]')).toContainText(language === 'en' ? 'Organizing finished.' : '整理已结束。');
    await expect(page.locator('.messages [role="status"]')).not.toContainText(language === 'en' ? 'Organization complete' : '整理完成');
    await expect(panel).toContainText(language === 'en' ? '7 emails' : '7 封邮件');
    await expect(panel).toContainText(language === 'en' ? '2 emails' : '2 封邮件');
    await expect(panel).toContainText(language === 'en' ? 'not confirmed' : '结果待查');
    await expect(checkingRow.locator('.execution-state')).toHaveText(language === 'en' ? 'Result unconfirmed' : '结果待查');
    await expect(checkingRow.getByRole('button', { name: language === 'en' ? 'Check results' : '核对结果', exact: true })).toBeEnabled();
    await expect(checkingRow.getByRole('checkbox')).toBeDisabled();
  }
  expect(executions).toBe(0);
});
