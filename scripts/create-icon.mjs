import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
  await page.setContent('<style>body{margin:0;background:transparent}</style>' + await readFile('build/icon.svg', 'utf8'));
  await page.screenshot({ path: 'build/icon.png', omitBackground: true });
} finally { await browser.close(); }
if (process.platform === 'darwin') {
  await mkdir('build/icon.iconset', { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const suffix = scale === 2 ? '@2x' : '';
      const pixels = String(size * scale);
      const result = spawnSync('sips', ['-z', pixels, pixels, 'build/icon.png', '--out', 'build/icon.iconset/icon_' + size + 'x' + size + suffix + '.png'], { stdio: 'ignore' });
      if (result.status !== 0) throw new Error('Icon resize failed');
    }
  }
  const result = spawnSync('iconutil', ['-c', 'icns', 'build/icon.iconset', '-o', 'build/icon.icns'], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Icon conversion failed');
}
