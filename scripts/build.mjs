import { writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
const result = await build({ entryPoints: ['src/local/main.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: 'dist/server.cjs', external: ['@napi-rs/keyring'], sourcemap: false, metafile: true });
await writeFile('dist/bundle-meta.json', JSON.stringify(result.metafile));
