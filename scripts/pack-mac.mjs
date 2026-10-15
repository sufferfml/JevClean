import { cp, mkdir, readFile, readdir, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) throw new Error('Run macOS packaging on the target architecture.');
const version = 'v24.21.0'; // Official LTS runtime, reviewed 2026-10-02. Pin for reproducible releases.
const filename = 'node-' + version + '-darwin-' + process.arch + '.tar.gz';
const cache = resolve('.runtime-cache'); await mkdir(cache, { recursive: true });
const download = (name) => execFileSync('curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--tlsv1.2', '--retry', '2', '--connect-timeout', '15', '--max-time', '120', 'https://nodejs.org/dist/' + version + '/' + name, '--output', join(cache, name)], { stdio: 'inherit' });
await stat(join(cache, filename)).catch(() => download(filename));
download('SHASUMS256.txt');
const sums = await readFile(join(cache, 'SHASUMS256.txt'), 'utf8');
const expected = sums.split('\n').find(line => line.endsWith('  ' + filename))?.split(' ')[0];
if (!expected || createHash('sha256').update(await readFile(join(cache, filename))).digest('hex') !== expected) throw new Error('Official Node archive checksum mismatch.');
const extracted = join(cache, filename.replace('.tar.gz', ''));
await rm(extracted, { recursive: true, force: true }); execFileSync('tar', ['-xzf', join(cache, filename), '-C', cache]);
const app = resolve('release/JevClean.app'); await rm(app, { recursive: true, force: true });
const resources = join(app, 'Contents/Resources'); const executables = join(app, 'Contents/MacOS');
await mkdir(resources, { recursive: true }); await mkdir(executables, { recursive: true });
await cp(join(extracted, 'bin/node'), join(resources, 'node')); await chmod(join(resources, 'node'), 0o755);
await cp('dist/server.cjs', join(resources, 'server.cjs')); await cp('dist/web', join(resources, 'web'), { recursive: true });
for (const name of ['keyring', 'keyring-darwin-' + process.arch]) { const target = join(resources, 'node_modules/@napi-rs', name); await mkdir(dirname(target), { recursive: true }); await cp(join('node_modules/@napi-rs', name), target, { recursive: true }); }
await cp('build/icon.icns', join(resources, 'icon.icns'));
await cp('LICENSE', join(resources, 'LICENSE')); await cp(join(extracted, 'LICENSE'), join(resources, 'NODE-LICENSE'));
const meta = JSON.parse(await readFile('dist/bundle-meta.json', 'utf8'));
const packageRoots = new Set(Object.keys(meta.inputs).map(name => name.match(/^(node_modules\/(?:@[^/]+\/)?[^/]+)/)?.[1]).filter(Boolean));
for (const name of ['react', 'react-dom', 'scheduler', '@napi-rs/keyring', '@phosphor-icons/react']) packageRoots.add('node_modules/' + name);
let notices = 'JevClean third-party licenses. Node.js notices are in NODE-LICENSE.\n';
for (const root of [...packageRoots].sort()) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  notices += '\n\n=== ' + pkg.name + '@' + pkg.version + ' (' + pkg.license + ') ===\n';
  for (const file of (await readdir(root)).filter(name => /^(license|licence|copying|notice)(?:[.-]|$)/i.test(name))) {
    if ((await stat(join(root, file))).isFile()) notices += await readFile(join(root, file), 'utf8') + '\n';
  }
}
await writeFile(join(resources, 'THIRD-PARTY-NOTICES.txt'), notices);
execFileSync('xcrun', ['swiftc', '-O', '-target', (process.arch === 'arm64' ? 'arm64' : 'x86_64') + '-apple-macosx13.5', 'scripts/macos-launcher.swift', '-o', join(executables, 'JevClean')], { stdio: 'inherit' });
await writeFile(join(app, 'Contents/Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleName</key><string>JevClean</string><key>CFBundleDisplayName</key><string>JevClean</string><key>CFBundleIdentifier</key><string>org.jevclean.local</string><key>CFBundleVersion</key><string>0.2.0</string><key>CFBundleShortVersionString</key><string>0.2.0</string><key>CFBundleExecutable</key><string>JevClean</string><key>CFBundleIconFile</key><string>icon.icns</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/><key>LSMinimumSystemVersion</key><string>13.5</string><key>NSHighResolutionCapable</key><true/></dict></plist>');
execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
const archive = resolve('release/JevClean-mac-' + process.arch + '.zip'); await rm(archive, { force: true });
execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive]);
let bytes = 0; async function size(directory) { for (const file of await readdir(directory, { withFileTypes: true })) { const path = join(directory, file.name); if (file.isDirectory()) await size(path); else bytes += (await stat(path)).size; } }
await size(app); const result = { architecture: process.arch, runtime: version, appBytes: bytes, zipBytes: (await stat(archive)).size, app, archive, signed: 'ad-hoc', notarized: false };
await writeFile('release/package-info.json', JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result, null, 2));
