import { test as base, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { MailService } from '../../src/core/service';
import { accountIdentity } from '../../src/core/mailbox';
import type { Evaluate } from '../../src/core/jev';
import { startLocalServer } from '../../src/local/server';
import { LocalLogger } from '../../src/local/logger';
import { defaultRules, type Bootstrap, type ScanReport } from '../../src/shared/contracts';
import { fixture } from '../fixture';
import { email, evaluator, now } from '../helpers';

const headers = { 'X-JevClean-Token': 'b'.repeat(64) };
const subjects = ['秋季促销，限时优惠', '验证码已经失效', '订单付款成功，请保留', '未知结束时间的活动'];
const body = '这是一封用于界面测试的合成邮件，不含真实个人信息。';
type MailFixture = Awaited<ReturnType<typeof fixture>>;
type LocalServer = Awaited<ReturnType<typeof startLocalServer>>;
interface Harness { fixture: MailFixture; server: LocalServer; service: MailService; modelCalls: () => number }

// Each test owns a fresh encrypted store and synthetic mailbox. No previous spec's state is reused.
const test = base.extend<{ harness: Harness }>({
  harness: async ({ page }, use) => {
    let modelCalls = 0;
    const evaluate: Evaluate = (request, signal) => {
      modelCalls++;
      const subject = (request.state as { email: { subject: string } }).email.subject;
      const decisions = subject.includes('订单') ? { promotions: 'not_match', verification: 'not_match', events: 'not_match' }
        : subject.includes('未知') ? { promotions: 'not_match', verification: 'not_match', events: 'uncertain' }
          : subject.includes('验证码') ? { promotions: 'not_match', verification: 'match', events: 'not_match' }
            : { promotions: 'match', verification: 'not_match', events: 'not_match' };
      return evaluator('not_match', { decisions, time: subject.includes('验证码') ? 'received_age' : 'none' })(request, signal);
    };
    const f = await fixture(evaluate);
    await f.store.forgetCredentials();
    f.original.clear();
    for (const [index, subject] of subjects.entries()) {
      f.original.set(42 + index, email({ uid: 42 + index, date: '2026-09-0' + (index + 1) + 'T10:00:00Z',
        messageId: '<redesign-' + index + '@example.com>', subject, text: body }));
    }
    let service!: MailService;
    const server = await startLocalServer({ store: f.store, webDirectory: resolve('dist/web'), logger: new LocalLogger(f.dir), token: 'b'.repeat(64),
      createService: emit => (service = new MailService(f.store, emit, f.connect, () => evaluate, () => now)) });
    try { await use({ fixture: f, server, service, modelCalls: () => modelCalls }); }
    finally { await page.goto('about:blank'); await server.close(); await f.cleanup(); }
  },
});

async function bootstrap(page: Page, harness: Harness): Promise<Bootstrap> {
  const response = await page.request.get(harness.server.origin + '/api/bootstrap', { headers });
  expect(response.ok()).toBe(true);
  return (await response.json()).value;
}

async function configureMailbox(page: Page, harness: Harness, { aiKey = false, consent = false } = {}) {
  const state = await bootstrap(page, harness);
  const configured = await page.request.post(harness.server.origin + '/api/config', { headers, data: {
    settings: { ...state.config.settings, email: 'synthetic@example.com', host: 'imap.example.com', port: 993,
      mailboxes: ['INBOX'], scanLimit: 100, rules: defaultRules, actionFolders: {}, language: 'zh-CN', analysisConsent: consent },
    imapPassword: 'synthetic-only', ...(aiKey ? { jevApiKey: 'synthetic-model-only' } : {}),
  } });
  expect(configured.ok()).toBe(true);
}

async function seed(page: Page, harness: Harness, mode: 'mail' | 'analysis' = 'mail'): Promise<ScanReport> {
  await configureMailbox(page, harness, { aiKey: mode === 'analysis', consent: mode === 'analysis' });
  const response = await page.request.post(harness.server.origin + (mode === 'mail' ? '/api/read-mail' : '/api/scan'), {
    headers, data: mode === 'mail' ? {} : { consent: true },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()).value;
}

test('API, mailbox and language have separate pages that preserve shared drafts until saving', async ({ page, harness }) => {
  const requests: string[] = [];
  page.on('request', request => { if (request.method() === 'POST') requests.push(new URL(request.url()).pathname); });
  await page.goto(harness.server.url);
  const navigation = page.locator('.settings-tabs');
  const capturePage = async (name: 'api' | 'mail' | 'language') => {
    if (!process.env.JEVCLEAN_SETTINGS_CAPTURES) return;
    await mkdir('.impeccable/review', { recursive: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => { const account = document.querySelector('.account-label'); if (account) account.textContent = '合成设置示例 / Synthetic settings'; });
    await page.screenshot({ path: '.impeccable/review/settings-' + name + '-1440.png', fullPage: true, animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const button of await navigation.getByRole('button').all()) {
      await button.focus();
      await expect(button).toBeInViewport();
    }
    await page.setViewportSize({ width: 1320, height: 1000 });
  };
  await expect(navigation.getByRole('button')).toHaveText(['分析服务', '邮箱设置', '显示语言', '管理规则', '隐私记录']);
  await expect(navigation.getByRole('button', { name: '分析服务', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByLabel('服务密钥', { exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '显示语言', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('邮箱地址', { exact: true })).toHaveCount(0);
  expect(await page.locator('.settings-workspace').evaluate(element => getComputedStyle(element).overflowY)).toBe('auto');
  await expect(page.getByRole('button', { name: /读取邮件|连接并读取/ })).toHaveCount(0);
  await page.getByLabel('服务密钥', { exact: true }).fill('synthetic-model-only');
  await capturePage('api');
  await navigation.getByRole('button', { name: '邮箱设置', exact: true }).click();
  await expect(page.getByLabel('服务密钥', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: '显示语言', exact: true })).toHaveCount(0);
  await page.getByLabel('邮箱地址', { exact: true }).fill('synthetic@example.com');
  await page.getByLabel('邮箱密码', { exact: true }).fill('synthetic-only');
  await capturePage('mail');
  await navigation.getByRole('button', { name: '显示语言', exact: true }).click();
  await expect(page.getByLabel('邮箱地址', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('服务密钥', { exact: true })).toHaveCount(0);
  await capturePage('language');
  await page.getByRole('combobox', { name: '显示语言', exact: true }).selectOption('en');
  await expect(navigation.getByRole('button', { name: 'Display language', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('button', { name: 'Back to mail', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start analysis', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(navigation.getByRole('button', { name: 'Analysis service', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByLabel('Service key', { exact: true })).toHaveValue('synthetic-model-only');
  await navigation.getByRole('button', { name: 'Mailbox settings', exact: true }).click();
  await expect(page.getByLabel('Email address', { exact: true })).toHaveValue('synthetic@example.com');
  await expect(page.getByLabel('Mailbox password', { exact: true })).toHaveValue('synthetic-only');
  await navigation.getByRole('button', { name: 'Display language', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Display language', exact: true })).toHaveValue('en');
  expect(requests).not.toContain('/api/config');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await navigation.getByRole('button', { name: 'Analysis service', exact: true }).click();
  await expect(page.getByLabel('Service key', { exact: true })).toHaveValue('');
  await navigation.getByRole('button', { name: 'Mailbox settings', exact: true }).click();
  await expect(page.getByLabel('Mailbox password', { exact: true })).toHaveValue('');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('button', { name: 'Start analysis', exact: true })).toBeDisabled();
  const state = await bootstrap(page, harness);
  expect(state.config.hasJevApiKey).toBe(true);
  expect(state.config.hasImapPassword).toBe(true);
  expect(state.config.settings.language).toBe('en');
  expect(state.config.settings.email).toBe('synthetic@example.com');
  expect(state.config.settings.analysisConsent ?? false).toBe(false);
  expect(state.report).toBeNull();
  expect(requests).not.toContain('/api/read-mail');
  expect(requests).not.toContain('/api/scan');
  expect(harness.modelCalls()).toBe(0);
  expect(harness.fixture.moveCalls + harness.fixture.flagCalls).toBe(0);
});

test('four result tabs isolate selection and Organize is available only for matched rules', async ({ page, harness }) => {
  await seed(page, harness, 'analysis');
  await page.goto(harness.server.url);
  const bar = page.getByRole('region', { name: '处理邮件', exact: true });
  const organize = bar.getByRole('button', { name: '整理', exact: true });
  await expect(page.locator('.results-filterbar .result-filters > button')).toHaveCount(4);
  await expect(page.getByLabel('选择邮件：' + subjects[0], { exact: true })).toBeChecked();
  await expect(page.getByLabel('选择邮件：' + subjects[1], { exact: true })).toBeChecked();
  await expect(organize).toBeEnabled();
  const enabledColor = await organize.evaluate(element => getComputedStyle(element).backgroundColor);
  await page.getByLabel('选择邮件：' + subjects[0], { exact: true }).uncheck();
  await expect(page.getByLabel('选择邮件：' + subjects[0], { exact: true })).not.toBeChecked();
  await expect(bar).toContainText('已选 1 封邮件');
  await page.getByLabel('选择邮件：' + subjects[1], { exact: true }).uncheck();
  await expect(organize).toBeDisabled();
  await expect(bar.getByRole('button', { name: '删除', exact: true })).toBeDisabled();
  await expect(bar).toBeVisible();
  await expect(bar.getByRole('button', { name: /查看已选|清除选择/ })).toHaveCount(0);
  await expect.poll(() => organize.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(enabledColor);
  for (const [tab, subject] of [['暂不整理', subjects[2]], ['待查看', subjects[3]], ['全部邮件', subjects[0]]] as const) {
    await page.locator('.result-filters').getByRole('button', { name: tab, exact: true }).click();
    await expect(page.getByLabel('选择邮件：' + subject, { exact: true })).not.toBeChecked();
    await expect(organize).toBeDisabled();
    await page.getByLabel('选择邮件：' + subject, { exact: true }).check();
    await expect(bar.getByRole('button', { name: '归档', exact: true })).toBeEnabled();
    await expect(organize).toBeDisabled();
  }
  await page.getByRole('button', { name: '符合规则', exact: true }).click();
  await expect(page.getByLabel('选择邮件：' + subjects[0], { exact: true })).toBeChecked();
  await expect(page.getByLabel('选择邮件：' + subjects[1], { exact: true })).toBeChecked();
  const requests: string[] = [];
  const observe = (request: import('@playwright/test').Request) => { if (new URL(request.url()).pathname.startsWith('/api/')) requests.push(request.url()); };
  page.on('request', observe);
  await page.getByRole('searchbox', { name: '搜索主题或发件人', exact: true }).fill('不存在的主题');
  await expect(page.locator('.mail-row')).toHaveCount(0);
  await expect(bar).toContainText('已选 0 封邮件');
  await expect(organize).toBeDisabled();
  await expect(bar.getByRole('button', { name: '删除', exact: true })).toBeDisabled();
  await page.getByRole('searchbox', { name: '搜索主题或发件人', exact: true }).fill('');
  await expect(page.getByLabel('选择邮件：' + subjects[0], { exact: true })).not.toBeChecked();
  await expect(page.getByLabel('选择邮件：' + subjects[1], { exact: true })).not.toBeChecked();
  expect(requests).toEqual([]);
  page.off('request', observe);
  expect(harness.fixture.moveCalls + harness.fixture.flagCalls).toBe(0);
});

test('rules stay exposed and every action stays present before selection, while analysis requires consent', async ({ page, harness }) => {
  await configureMailbox(page, harness, { aiKey: true });
  await page.goto(harness.server.url);
  const sidebar = page.locator('.analysis-sidebar');
  await expect(sidebar).toBeVisible();
  await expect(sidebar.getByText('分析设置', { exact: true })).toHaveCount(0);
  await expect(sidebar.getByText('本次范围', { exact: true })).toHaveCount(0);
  const headingStyles = await Promise.all(['选文件夹', '邮件范围', '整理规则'].map(label => sidebar.getByText(label, { exact: true }).evaluate(element => {
    const style = getComputedStyle(element); return [style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight];
  })));
  expect(headingStyles[1]).toEqual(headingStyles[0]); expect(headingStyles[2]).toEqual(headingStyles[0]);
  await expect(page.locator('footer')).toHaveCount(0);
  const rules = page.getByRole('group', { name: '整理规则', exact: true });
  await expect(rules.getByRole('checkbox')).toHaveCount(defaultRules.length);
  await expect(sidebar.locator('details')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /更改本次邮件范围|收起.*范围|只读取邮件/ })).toHaveCount(0);
  await expect(page.locator('.sidebar-rules').getByRole('button', { name: '添加规则', exact: true })).toHaveCount(0);
  await expect(page.locator('.sidebar-rules').getByRole('button', { name: '管理规则', exact: true })).toBeVisible();
  await expect(rules.locator('.rule-selection-description:visible')).toHaveCount(0);
  const selectedRule = page.getByLabel('使用规则：广告推广', { exact: true });
  await expect(selectedRule).toBeChecked();
  const expandRule = page.getByRole('button', { name: '展开规则：广告推广', exact: true });
  await expandRule.click();
  await expect(page.locator('#rule-details-promotions')).toBeVisible();
  await expect(rules.locator('.rule-selection-description:visible')).toHaveCount(1);
  await expect(selectedRule).toBeChecked();
  const collapseRule = page.getByRole('button', { name: '收起规则：广告推广', exact: true });
  await collapseRule.press('Enter');
  await expect(page.locator('#rule-details-promotions')).toBeHidden();
  await expect(selectedRule).toBeChecked();
  const consent = page.getByLabel('同意向 Jev 发送邮件文字。包括主题、发件人和正文。', { exact: true });
  const analyze = page.getByRole('button', { name: '开始分析', exact: true });
  await expect(consent).toBeVisible(); await expect(analyze).toBeDisabled();
  const bar = page.getByRole('region', { name: '处理邮件', exact: true });
  for (const action of ['整理', '删除', '移动', '归档', '标为垃圾', '标为已读', '标为未读', '添加星标', '取消星标']) {
    await expect(bar.getByRole('button', { name: action, exact: true })).toBeVisible();
    await expect(bar.getByRole('button', { name: action, exact: true })).toBeDisabled();
  }
  await consent.check(); await expect(analyze).toBeEnabled();
  expect(harness.modelCalls()).toBe(0);
  expect(harness.fixture.downloads).toHaveLength(0);
  expect((await bootstrap(page, harness)).report).toBeNull();
});

test('starting AI reads the configured scope once, defaults matches selected, and confirmation alone mutates mail', async ({ page, harness }) => {
  await configureMailbox(page, harness, { aiKey: true, consent: true });
  const originalMessages = structuredClone([...harness.fixture.original]);
  const requests: string[] = [];
  page.on('request', request => { if (request.method() === 'POST') requests.push(new URL(request.url()).pathname); });
  await page.goto(harness.server.url);
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  await expect(page.getByText(/^分析完成，共 .*查看结果，选好邮件后点击「整理」。$/)).toBeVisible();
  const completion = page.locator('.messages [role="status"]');
  await page.waitForTimeout(5500);
  await expect(completion).toContainText('分析完成，共 4 封邮件。');
  const classified = await bootstrap(page, harness);
  expect(classified.report?.kind).toBe('analysis');
  expect(classified.report?.records).toHaveLength(subjects.length);
  const metadata = page.locator('.analysis-meta');
  await expect(metadata.locator('time')).toHaveAttribute('datetime', classified.report!.startedAt);
  await expect(metadata).toContainText((classified.report!.inputTokens + classified.report!.outputTokens).toLocaleString('zh-CN'));
  await expect(metadata.locator('details, button')).toHaveCount(0);
  await expect(metadata).not.toContainText('INBOX');
  await expect(page.getByText('本次分析详情', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/列表快照：|已默认勾选可整理的命中邮件/)).toHaveCount(0);
  const destination = page.locator('.action-setup.ready');
  await expect(destination).toContainText('删除后移到「Trash」');
  await expect(destination.locator('summary, details, button')).toHaveCount(0);
  await expect(page.locator('footer')).toHaveCount(0);
  expect(requests.filter(path => path === '/api/scan')).toHaveLength(1);
  expect(requests).not.toContain('/api/read-mail');
  expect(harness.modelCalls()).toBe(subjects.length);
  expect(harness.fixture.downloads).toHaveLength(subjects.length);
  expect([...harness.fixture.original]).toEqual(originalMessages);
  expect(harness.fixture.moveCalls + harness.fixture.flagCalls).toBe(0);
  await expect(page.getByLabel('选择邮件：' + subjects[0], { exact: true })).toBeChecked();
  await expect(page.getByLabel('选择邮件：' + subjects[1], { exact: true })).toBeChecked();
  if (process.env.JEVCLEAN_WORKSPACE_CAPTURES) {
    await mkdir('.impeccable/review', { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const closeNotice = page.getByRole('button', { name: '关闭提示', exact: true });
      if (await closeNotice.isVisible()) await closeNotice.click();
      await page.evaluate(() => { document.querySelector('.account-label')?.append(' · 合成邮件示例 / Synthetic mail example'); document.querySelector('.mail-results-workspace')?.scrollTo(0, 0); document.querySelector('.analysis-sidebar-content')?.scrollTo(0, 0); });
      await page.mouse.move(0, 0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: width === 1440 ? 'docs/images/review-example.png' : 'docs/images/narrow-layout.png', fullPage: true, animations: 'disabled' });
      await page.screenshot({ path: '.impeccable/review/minimal-workspace-' + width + '.png', fullPage: true, animations: 'disabled' });
    }
    await page.setViewportSize({ width: 1320, height: 1000 });
  }
  await page.getByLabel('选择邮件：' + subjects[1], { exact: true }).uncheck();
  const organize = page.getByRole('button', { name: '整理', exact: true });
  await organize.click();
  const confirmation = page.getByRole('dialog', { name: '确认整理', exact: true });
  await expect(confirmation).toBeVisible();
  await expect(confirmation.locator('.selected-mail-list')).toHaveCount(0);
  await expect(confirmation.getByText(subjects[0], { exact: true })).toHaveCount(0);
  await expect(confirmation).toContainText('删除后移到「Trash」');
  if (process.env.JEVCLEAN_WORKSPACE_CAPTURES) {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.screenshot({ path: '.impeccable/review/confirmation-dialog-' + width + '.png', fullPage: true, animations: 'disabled' });
    }
    await page.setViewportSize({ width: 1320, height: 1000 });
  }
  expect(requests).not.toContain('/api/execute'); expect(requests).not.toContain('/api/manual-execute');
  expect([...harness.fixture.original]).toEqual(originalMessages);
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await expect(organize).toBeFocused();
  await organize.click();
  await confirmation.getByRole('button', { name: '确认处理', exact: true }).click();
  await expect.poll(() => harness.fixture.moveCalls).toBe(1);
  await expect(page.getByRole('button', { name: '撤销整理', exact: true })).toBeEnabled();
  await expect(completion).toHaveText('整理完成，共处理 1 封邮件。');
  await page.waitForTimeout(5500);
  await expect(completion).toBeVisible();
  await completion.getByRole('button', { name: '关闭提示', exact: true }).click();
  await expect(completion).toHaveCount(0);
  expect(requests.filter(path => path === '/api/execute')).toHaveLength(1);
  expect(requests).not.toContain('/api/manual-execute');
  expect(harness.fixture.flagCalls).toBe(0);
  expect(harness.fixture.quarantine.size).toBe(1);
  expect(harness.fixture.original.size).toBe(subjects.length - 1);
  expect(harness.modelCalls()).toBe(subjects.length);
});

test('an existing mail snapshot retains independent manual controls without exposing read-mail UI', async ({ page, harness }) => {
  await seed(page, harness);
  const requests: string[] = [];
  page.on('request', request => { if (request.method() === 'POST') requests.push(new URL(request.url()).pathname); });
  await page.goto(harness.server.url);
  const back = page.getByRole('button', { name: '返回邮件', exact: true });
  if (await back.isVisible()) await back.click();
  await page.locator('.result-filters').getByRole('button', { name: '全部邮件', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始分析', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: /只读取邮件|连接并读取/ })).toHaveCount(0);
  await expect(page.locator('.mail-row')).toHaveCount(subjects.length);
  await page.getByLabel('选择邮件：' + subjects[0], { exact: true }).check();
  const bar = page.getByRole('region', { name: '处理邮件', exact: true });
  await expect(bar.getByRole('button', { name: '归档', exact: true })).toBeEnabled();
  await expect(bar.getByRole('button', { name: '整理', exact: true })).toBeDisabled();
  const state = await bootstrap(page, harness);
  expect(state.config.hasJevApiKey).toBe(false);
  expect(state.report?.apiCalls).toBe(0);
  expect(requests).not.toContain('/api/read-mail'); expect(requests).not.toContain('/api/scan');
  expect(harness.modelCalls()).toBe(0);
  expect(harness.fixture.moveCalls + harness.fixture.flagCalls).toBe(0);
});

test('failed preflight exposes destination repair and preserves existing mail without a model call', async ({ page, harness }) => {
  await seed(page, harness);
  const list = harness.fixture.client.list;
  harness.fixture.client.list = async () => (await list()).map(folder => folder.path === 'Trash' ? { ...folder, name: 'Personal folder', specialUse: undefined } : folder);
  await configureMailbox(page, harness, { aiKey: true, consent: true });
  const requests: string[] = [];
  page.on('request', request => { if (request.method() === 'POST') requests.push(new URL(request.url()).pathname); });
  await page.goto(harness.server.url);
  const originalMessages = structuredClone([...harness.fixture.original]);
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  await expect(page.getByRole('heading', { name: '请选择存放位置或更改处理方式。', exact: true })).toBeVisible();
  await expect(page.getByLabel('删除去向', { exact: true })).toBeVisible();
  await expect(page.locator('.settings-workspace #action-setup')).toBeVisible();
  await page.getByRole('button', { name: '返回邮件', exact: true }).click();
  await page.locator('.result-filters').getByRole('button', { name: '全部邮件', exact: true }).click();
  await expect(page.locator('.mail-row')).toHaveCount(subjects.length);
  await page.getByLabel('选择邮件：' + subjects[2], { exact: true }).check();
  await expect(page.locator('.manual-toolbar').getByRole('button', { name: '归档', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '整理', exact: true })).toBeDisabled();
  expect(requests).not.toContain('/api/scan');
  expect(harness.modelCalls()).toBe(0); expect(harness.fixture.downloads).toHaveLength(0);
  expect([...harness.fixture.original]).toEqual(originalMessages);
  expect(harness.fixture.moveCalls + harness.fixture.flagCalls).toBe(0);
});

test('empty cancelled analysis explains the outcome while its permanent scope controls remain available', async ({ page, harness }) => {
  const saved = await harness.fixture.store.config();
  const config = await harness.fixture.store.saveConfig({ settings: { ...saved.settings, email: 'synthetic@example.com', host: 'imap.example.com', port: 993,
    mailboxes: ['INBOX'], scanLimit: 100, rules: defaultRules, actionFolders: {}, language: 'zh-CN', analysisConsent: true }, imapPassword: 'synthetic-only', jevApiKey: 'synthetic-model-only' });
  await harness.fixture.store.saveReport({ kind: 'analysis', id: randomUUID(), accountIdentity: accountIdentity(config.settings), startedAt: now.toISOString(), completedAt: now.toISOString(), status: 'cancelled',
    mailboxes: config.settings.mailboxes, scanLimit: config.settings.scanLimit, total: subjects.length, processed: 0, inputTokens: 0, outputTokens: 0, apiCalls: 0,
    records: [], model: 'synthetic-model', policyHash: config.policyHash, judgmentHash: config.judgmentHash });
  await page.goto(harness.server.url);
  await expect(page.locator('.empty-results')).toBeVisible();
  await expect(page.getByLabel('分析位置：INBOX', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '开始分析', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '整理', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: /读取邮件|更改本次邮件范围/ })).toHaveCount(0);
  expect(harness.fixture.original.size).toBe(subjects.length); expect(harness.modelCalls()).toBe(0);
});

test('opening a separate reading panel preserves selection and returns focus without calling AI', async ({ page, harness }) => {
  await seed(page, harness, 'analysis');
  await page.goto(harness.server.url);
  await page.locator('.result-filters').getByRole('button', { name: '全部邮件', exact: true }).click();
  await page.getByLabel('选择邮件：' + subjects[2], { exact: true }).check();
  const trigger = page.locator('.mail-row').filter({ hasText: subjects[0] }).getByRole('button', { name: new RegExp(subjects[0]) });
  await trigger.click();
  const reading = page.getByRole('region', { name: '邮件内容', exact: true });
  await expect(reading).toBeVisible(); await expect(reading).not.toContainText(body);
  await reading.getByRole('button', { name: '查看正文', exact: true }).click(); await expect(reading).toContainText(body);
  await expect(page.getByLabel('选择邮件：' + subjects[2], { exact: true })).toBeChecked();
  await expect(page.getByLabel('选择邮件：' + subjects[0], { exact: true })).not.toBeChecked();
  await page.keyboard.press('Escape'); await expect(reading).toHaveCount(0); await expect(trigger).toBeFocused();
  expect(harness.modelCalls()).toBe(subjects.length);
  expect(harness.fixture.moveCalls + harness.fixture.flagCalls).toBe(0);
});

test('manual completion retains the AI review warning and original evidence beside the actual result', async ({ page, harness }) => {
  const report = await seed(page, harness, 'analysis');
  const original = report.records.find(record => record.subject === subjects[3])!;
  const evidence = (record: typeof original) => JSON.stringify([record.category, record.reason, record.probability, record.verdicts, record.matchedRules]);
  await page.goto(harness.server.url);
  await page.getByRole('button', { name: '待查看', exact: true }).click();
  const row = page.locator('.mail-row').filter({ hasText: subjects[3] });
  const badge = row.locator('.action-badge');
  await expect(badge).toHaveText('待查看');
  const warningStyle = await badge.evaluate(element => ({ color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }));
  await row.getByRole('checkbox').check();
  await page.getByRole('region', { name: '处理邮件', exact: true }).getByRole('button', { name: '归档', exact: true }).click();
  await page.getByRole('button', { name: '确认处理', exact: true }).click();
  await expect(row.getByText('已移到「Archive」', { exact: true })).toBeVisible();
  await expect(badge).toHaveText('待查看');
  expect(await badge.evaluate(element => ({ color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }))).toEqual(warningStyle);
  const changed = (await bootstrap(page, harness)).report!.records.find(record => record.id === original.id)!;
  expect(evidence(changed)).toBe(evidence(original)); expect(changed.status).toBe('moved');
  expect(changed.operation).toMatchObject({ source: 'manual', action: 'archive', targetMailbox: 'Archive' });
  expect(harness.fixture.archive.size).toBe(1); expect(harness.modelCalls()).toBe(report.apiCalls);
});

test('a failed manual check is visible inside the modal and can be retried without executing mail', async ({ page, harness }) => {
  await seed(page, harness, 'analysis');
  let checks = 0;
  let executions = 0;
  const failure = '合成邮箱暂时无法连接，请重试。';
  await page.route('**/api/manual-check', route => {
    checks++;
    return checks === 1
      ? route.fulfill({ status: 503, json: { ok: false, error: failure } })
      : route.continue();
  });
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/manual-execute') executions++; });
  await page.goto(harness.server.url);
  await page.getByLabel('选择邮件：' + subjects[1], { exact: true }).uncheck();
  const archive = page.locator('.selection-bar').getByRole('button', { name: '归档', exact: true });
  await archive.click();
  const dialog = page.getByRole('dialog', { name: '确认处理', exact: true });
  await expect(dialog.getByText(failure, { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '确认处理', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: '检查处理', exact: true }).click();
  await expect(dialog.getByText(failure, { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '确认处理', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(archive).toBeFocused();
  expect(checks).toBe(2);
  expect(executions).toBe(0);
  expect(harness.fixture.moveCalls + harness.fixture.flagCalls).toBe(0);
});

for (const width of [390, 1024]) test('permanent panes remain independently scrollable at ' + width + 'px and 200% text', async ({ page, harness }) => {
  await seed(page, harness, 'analysis');
  await page.setViewportSize({ width, height: 900 });
  await page.goto(harness.server.url);
  await expect(page.locator('.analysis-sidebar')).toBeVisible();
  await expect(page.locator('.mail-results-workspace')).toBeVisible();
  await expect(page.getByRole('button', { name: /更改本次邮件范围|收起.*范围/ })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const independent = await page.evaluate(() => {
    const sidebar = document.querySelector<HTMLElement>('.analysis-sidebar-content')!;
    const results = document.querySelector<HTMLElement>('.mail-results-workspace')!;
    const start = sidebar.scrollTop;
    const sidebarTop = sidebar.getBoundingClientRect().top;
    results.scrollTop = results.scrollHeight;
    return { unchanged: sidebar.scrollTop === start && sidebar.getBoundingClientRect().top === sidebarTop,
      sideOverflow: getComputedStyle(sidebar).overflowY, mainOverflow: getComputedStyle(results).overflowY, windowY: window.scrollY };
  });
  expect(independent).toEqual({ unchanged: true, sideOverflow: 'auto', mainOverflow: 'auto', windowY: 0 });
  const firstRow = page.locator('.mail-row').first();
  const initialTextSize = await firstRow.locator('.mail-subject').evaluate(element => parseFloat(getComputedStyle(element).fontSize));
  await page.evaluate(() => { document.documentElement.style.fontSize = parseFloat(getComputedStyle(document.documentElement).fontSize) * 2 + 'px'; });
  const enlarged = await firstRow.locator('.mail-subject').evaluate(element => parseFloat(getComputedStyle(element).fontSize));
  expect(enlarged).toBeCloseTo(initialTextSize * 2, 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('confirmation is modal, traps keyboard focus, and returns to its trigger without changing mail on cancel', async ({ page, harness }) => {
  await page.setViewportSize({ width: 720, height: 450 });
  await seed(page, harness, 'analysis');
  await page.goto(harness.server.url);
  await page.getByLabel('选择邮件：' + subjects[1], { exact: true }).uncheck();
  const organize = page.getByRole('button', { name: '整理', exact: true });
  await organize.focus(); await page.keyboard.press('Enter');
  const rulePanel = page.getByRole('dialog', { name: '确认整理', exact: true });
  const cancel = rulePanel.getByRole('button', { name: '取消', exact: true });
  const confirm = rulePanel.getByRole('button', { name: '确认处理', exact: true });
  await expect(cancel).toBeFocused();
  expect(await rulePanel.evaluate(element => element.matches(':modal'))).toBe(true);
  await expect(rulePanel.locator('.selected-mail-list')).toHaveCount(0);
  await page.keyboard.press('Tab'); await expect(confirm).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(cancel).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(confirm).toBeFocused();
  await page.keyboard.press('Tab'); await expect(cancel).toBeFocused();
  expect(await confirm.evaluate(element => { const box = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)); })).toBe(true);
  await page.keyboard.press('Escape'); await expect(rulePanel).toHaveCount(0); await expect(organize).toBeFocused();
  const archive = page.locator('.selection-bar').getByRole('button', { name: '归档', exact: true });
  await archive.focus(); await page.keyboard.press('Enter');
  const manualDialog = page.getByRole('dialog', { name: '确认处理', exact: true });
  const manualPanel = manualDialog.getByRole('region', { name: '手动处理', exact: true });
  await expect(manualPanel.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  expect(await manualDialog.evaluate(element => element.matches(':modal'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(manualDialog).toHaveCount(0); await expect(archive).toBeFocused();
  expect(harness.fixture.moveCalls + harness.fixture.flagCalls).toBe(0);
});

test('analysis evidence opens without mailbox access and remains readable after account changes', async ({ page, harness }) => {
  const report = await seed(page, harness, 'analysis');
  const config = await harness.fixture.store.config();
  await harness.fixture.store.saveConfig({ settings: { ...config.settings, email: 'another@example.com' } });
  let bodyReads = 0; let traceReads = 0;
  await page.route('**/api/preview', route => { bodyReads++; return route.fulfill({ status: 503, json: { ok: false, error: 'Synthetic mailbox offline' } }); });
  page.on('request', request => { if (request.url().endsWith('/api/analysis-trace')) traceReads++; });
  await page.goto(harness.server.url);
  const back = page.getByRole('button', { name: '返回邮件', exact: true });
  await expect(back).toBeVisible(); await back.click();
  await page.locator('.result-filters').getByRole('button', { name: '全部邮件', exact: true }).click();
  await page.locator('.mail-row').filter({ hasText: subjects[0] }).getByRole('button', { name: new RegExp(subjects[0]) }).click();
  const reading = page.getByRole('region', { name: '邮件内容', exact: true });
  await expect(reading.getByText('整理判断', { exact: true })).toBeVisible(); await expect(reading).toContainText('处理结果');
  expect(bodyReads).toBe(0); expect(traceReads).toBe(0);
  await reading.getByRole('button', { name: '分析记录', exact: true }).click();
  await expect(reading.getByRole('region', { name: '分析记录', exact: true })).toBeVisible();
  await expect(reading.getByText('本次未开启，只能记录开启后的请求。')).toBeVisible();
  await expect(reading.getByRole('button', { name: '查看正文', exact: true })).toBeDisabled();
  await expect(reading.getByText('选项分数').first()).toBeVisible();
  expect(traceReads).toBe(1); expect(bodyReads).toBe(0); expect(harness.modelCalls()).toBe(report.records.length);
});

test('full call history loads only on demand and exports a redacted summary', async ({ page, harness }) => {
  await configureMailbox(page, harness, { aiKey: true, consent: true });
  const config = await harness.fixture.store.config();
  await harness.fixture.store.saveConfig({ settings: { ...config.settings, detailedDiagnostics: true } });
  const response = await page.request.post(harness.server.origin + '/api/scan', { headers, data: { consent: true } });
  expect(response.ok()).toBe(true);
  let traces = 0; let bodies = 0;
  page.on('request', request => { if (request.url().endsWith('/api/analysis-trace')) traces++; if (request.url().endsWith('/api/preview')) bodies++; });
  await page.goto(harness.server.url);
  await page.locator('.mail-row').filter({ hasText: subjects[0] }).getByRole('button', { name: new RegExp(subjects[0]) }).click();
  const reading = page.getByRole('region', { name: '邮件内容', exact: true });
  expect(traces).toBe(0); expect(bodies).toBe(0);
  await reading.getByRole('button', { name: '分析记录', exact: true }).click();
  await reading.getByText('提交内容', { exact: true }).click();
  await expect(reading.locator('.request-preview').filter({ hasText: body })).toBeVisible();
  await expect(reading.getByText('请求 1 次，已知用量 880。', { exact: true })).toBeVisible();
  if (process.env.JEVCLEAN_ANALYSIS_CAPTURES) {
    await mkdir('.runtime-cache', { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await reading.getByText('完整记录', { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: '.runtime-cache/analysis-history-' + width + '.png', animations: 'disabled' });
    }
    await page.setViewportSize({ width: 1320, height: 1000 });
  }

  const download = page.waitForEvent('download');
  await reading.getByRole('button', { name: '导出摘要', exact: true }).click();
  const artifact = await download; const stream = await artifact.createReadStream();
  const chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const summary = Buffer.concat(chunks).toString('utf8');
  expect(summary).toContain('JevClean diagnostic summary');
  for (const privateText of [body, subjects[0], 'offers@example.com', 'INBOX', defaultRules[0].description]) expect(summary).not.toContain(privateText);
  expect(traces).toBe(1); expect(bodies).toBe(0); expect(harness.modelCalls()).toBe(subjects.length);
});

test('current settings start analysis directly without a legacy rule confirmation', async ({ page, harness }) => {
  await configureMailbox(page, harness, { aiKey: true, consent: true });
  await page.goto(harness.server.url);
  await expect(page.getByText('开始分析前，请确认规则的新作用范围。', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '检查规则', exact: true })).toHaveCount(0);
  const start = page.getByRole('button', { name: '开始分析', exact: true });
  await expect(start).toBeEnabled(); await start.click();
  await expect(page.getByText('分析完成，共 4 封邮件。 查看结果，选好邮件后点击「整理」。', { exact: true })).toBeVisible();
  const state = await bootstrap(page, harness);
  expect(state.report?.processed).toBe(subjects.length);
  expect(Object.hasOwn(state.config.settings, 'ruleSemantics')).toBe(false);
  expect(harness.modelCalls()).toBe(subjects.length); expect(harness.fixture.moveCalls).toBe(0);
});

test('retry asks for confirmation and analyzes only the incomplete email', async ({ page, harness }) => {
  await seed(page, harness, 'analysis');
  const report = (await harness.service.loadReport())!;
  const record = report.records.find(record => record.category === 'clean')!;
  record.category = 'review'; record.eligible = false; record.verdicts = []; record.matchedRules = []; record.reason = '判断请求未完成，这封邮件保留。';
  record.analysis!.error = '无法连接 Jev'; record.analysis!.attempts = [{ attempt: 1, startedAt: now.toISOString(), status: 'failed', errorCode: 'network_error' }];
  await harness.fixture.store.saveReport(report);
  await page.goto(harness.server.url);
  await page.getByRole('button', { name: '待查看', exact: true }).click();
  await page.locator('.mail-row').filter({ hasText: record.subject }).getByRole('button', { name: new RegExp(record.subject) }).click();
  await page.getByRole('button', { name: '重试分析', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '重试分析', exact: true });
  await expect(dialog).toContainText('会消耗额度'); expect(harness.modelCalls()).toBe(subjects.length);
  await dialog.getByRole('button', { name: '确认重试', exact: true }).click();
  await expect(page.getByText('重试完成，请查看最新判断。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '分析记录', exact: true }).click();
  await expect(page.getByText('请求 2 次，已知用量 880。', { exact: true })).toBeVisible();
  await expect(page.getByText('1 次未收到用量，消耗未知。', { exact: true })).toBeVisible();
  expect(harness.modelCalls()).toBe(subjects.length + 1); expect(harness.fixture.moveCalls + harness.fixture.flagCalls).toBe(0);
});

test('missing analysis evidence is explained and a failed live body read keeps local evidence open', async ({ page, harness }) => {
  await seed(page, harness, 'analysis');
  const state = await bootstrap(page, harness);
  state.report!.records.forEach(record => { delete record.analysis; });
  await page.route('**/api/bootstrap', route => route.fulfill({ json: { ok: true, value: state } }));
  await page.route('**/api/analysis-trace', route => route.fulfill({ json: { ok: true, value: null } }));
  await page.route('**/api/preview', route => route.fulfill({ status: 503, json: { ok: false, error: '合成测试：邮箱暂时离线' } }));
  await page.goto(harness.server.url);
  await page.locator('.mail-row').filter({ hasText: subjects[0] }).getByRole('button', { name: new RegExp(subjects[0]) }).click();
  const reading = page.getByRole('region', { name: '邮件内容', exact: true });
  await reading.getByRole('button', { name: '分析记录', exact: true }).click();
  await expect(reading).toContainText('仅显示已有记录，不补造缺失内容。');
  await reading.getByRole('button', { name: '查看正文', exact: true }).click();
  await expect(reading.getByRole('alert')).toHaveText('合成测试：邮箱暂时离线');
  await expect(reading.getByRole('region', { name: '分析记录', exact: true })).toBeVisible();
  expect(harness.modelCalls()).toBe(subjects.length);
});

test('complete request recording is an explicit saved privacy setting and clearing it preserves analysis', async ({ page, harness }) => {
  const report = await seed(page, harness, 'analysis');
  await page.goto(harness.server.url);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '隐私记录', exact: true }).click();
  const toggle = page.getByLabel('保存原文', { exact: true });
  await expect(toggle).not.toBeChecked(); await toggle.check();
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByText('设置已保存。', { exact: true })).toBeVisible();
  let state = await bootstrap(page, harness);
  expect(state.config.settings.detailedDiagnostics).toBe(true); expect(state.report?.judgmentHash).toBe(state.config.judgmentHash);
  await page.getByRole('button', { name: '清除原文', exact: true }).click();
  await expect(page.getByText('完整记录已清除，分析与撤销记录保留。', { exact: true })).toBeVisible();
  state = await bootstrap(page, harness); expect(state.report?.id).toBe(report.id); expect(state.report?.records).toHaveLength(subjects.length);
});

test('failed retries stay in review and newer basic attempts take precedence over an incomplete full trace', async ({ page, harness }) => {
  await seed(page, harness, 'analysis');
  const report = (await harness.service.loadReport())!;
  const record = report.records.find(record => record.category === 'clean')!;
  record.category = 'review'; record.eligible = false; record.verdicts = []; record.matchedRules = [];
  record.analysis!.error = '无法连接 Jev'; record.analysis!.traceStatus = 'incomplete';
  record.analysis!.attempts = [{ attempt: 1, startedAt: now.toISOString(), status: 'failed', errorCode: 'network_error' }];
  await harness.fixture.store.saveReport(report);
  let traceReads = 0;
  await page.route('**/api/analysis-trace', route => { traceReads++; return route.fulfill({ json: { ok: true, value: { reportId: report.id, recordId: record.id,
    createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 7 * 86400000).toISOString(), requestText: '{}',
    attempts: [{ attempt: 1, startedAt: now.toISOString(), status: 'sending' }] } } }); });
  await page.route('**/api/retry-analysis', async route => {
    report.status = 'failed'; record.analysis!.error = 'Jev 暂时繁忙';
    record.analysis!.attempts.push({ attempt: 2, startedAt: now.toISOString(), completedAt: now.toISOString(), status: 'failed', errorCode: 'server_error', usage: { input_tokens: 12, output_tokens: 3 } });
    await harness.fixture.store.saveReport(report);
    await route.fulfill({ json: { ok: true, value: report } });
  });
  await page.goto(harness.server.url);
  await page.getByRole('button', { name: '待查看', exact: true }).click();
  await page.locator('.mail-row').filter({ hasText: record.subject }).getByRole('button', { name: new RegExp(record.subject) }).click();
  await page.getByRole('button', { name: '分析记录', exact: true }).click();
  await expect(page.getByText('第 1 次：请求失败', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '重试分析', exact: true }).click();
  await page.getByRole('button', { name: '确认重试', exact: true }).click();
  await expect(page.getByText('仍未收到可用回答，请看请求记录。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '待查看', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('重试完成，请查看最新判断。', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '分析记录', exact: true }).click();
  await expect(page.getByText('请求 2 次，已知用量 15。', { exact: true })).toBeVisible();
  await expect(page.getByText('第 2 次：请求失败', { exact: true })).toBeVisible();
  expect(traceReads).toBe(2); expect(harness.modelCalls()).toBe(subjects.length);
});

test('automatic confirmation remains neutral through reload and becomes success without a refresh or another move', async ({ page, harness }) => {
  await seed(page, harness, 'analysis');
  await page.goto(harness.server.url);
  harness.fixture.omitReceipt();
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const checking = new Promise<void>(resolve => { entered = resolve; });
  const search = harness.fixture.client.search;
  harness.fixture.client.search = async () => { entered(); await gate; return search(); };
  try {
    await page.getByRole('button', { name: '整理', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确认处理', exact: true }).click();
    await checking;
    const rows = page.locator('.mail-row');
    await expect(rows.locator('.status-checking')).toHaveCount(2);
    await expect(rows.locator('.status-uncertain')).toHaveCount(0);
    await expect(page.locator('.cleanup-result')).toHaveClass(/is-active/);
    await expect(page.locator('.cleanup-result')).not.toHaveClass(/needs-attention/);
    await expect(page.getByRole('button', { name: '核对结果', exact: true })).toHaveCount(0);
    await expect(page.locator('.operation-issues')).toHaveCount(0);
    await expect(page.locator('.messages')).not.toContainText('整理完成');
    await rows.filter({ hasText: subjects[0] }).getByRole('button', { name: new RegExp(subjects[0]) }).click();
    await expect(page.locator('.preview-state-summary')).toContainText('核对中');
    await page.reload();
    await expect(rows.locator('.status-checking')).toHaveCount(2);
    expect(harness.fixture.moveCalls).toBe(2);
    await page.screenshot({ path: '.runtime-cache/confirmation-checking.png' });
    release();
    await expect(rows.locator('.status-moved')).toHaveCount(2);
    await expect(rows.locator('.status-checking')).toHaveCount(0);
    await expect(rows.locator('.status-uncertain')).toHaveCount(0);
    expect(harness.fixture.moveCalls).toBe(2); expect(harness.modelCalls()).toBe(subjects.length);
    await expect(page.locator('.cleanup-result')).toContainText('已将 2 封邮件 移到「Trash」。');
    await expect(page.locator('.messages [role="status"]')).toHaveText('整理完成，共处理 2 封邮件。');
  } finally { release(); }
});

test('English completion notices report the analyzed count and distinguish partial organizing from full success', async ({ page, harness }) => {
  await configureMailbox(page, harness, { aiKey: true, consent: true });
  const state = await bootstrap(page, harness);
  await page.request.post(harness.server.origin + '/api/config', { headers, data: { settings: { ...state.config.settings, language: 'en' } } });
  await page.goto(harness.server.url);
  await page.getByRole('button', { name: 'Start analysis', exact: true }).click();
  const notice = page.locator('.messages [role="status"]');
  await expect(notice).toContainText('Analysis complete: 4 emails.');
  const move = harness.fixture.client.messageMove;
  harness.fixture.client.messageMove = async (uid, destination) => {
    const result = await move(uid, destination);
    harness.fixture.changeIdentity();
    return result;
  };
  await page.getByRole('button', { name: 'Organize', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm action', exact: true }).click();
  await expect(notice).toHaveClass(/warning/);
  await expect(notice).toContainText('Organizing finished.');
  await expect(notice).toContainText('Processed 1 email');
  await expect(notice).toContainText('1 email unsuccessful');
  await expect(notice).not.toContainText('Organization complete');
  expect(harness.fixture.moveCalls).toBe(1);
  expect(harness.modelCalls()).toBe(subjects.length);
});
