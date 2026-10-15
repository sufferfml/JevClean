// Compile the real AppKit shell with an isolated loopback fixture; never open a real mailbox or browser.
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
if (process.platform !== 'darwin') throw new Error('Native menu checks require macOS.');
const sourceApp = resolve(process.argv[2] || 'release/JevClean.app');
const directory = await mkdtemp(join(tmpdir(), 'jevclean-native-menu-'));
const app = join(directory, 'NativeChecks.app');
let test;
try {
  await mkdir(join(app, 'Contents/MacOS'), { recursive: true });
  await mkdir(join(app, 'Contents/Resources'), { recursive: true });
  await cp(join(sourceApp, 'Contents/Resources/node'), join(app, 'Contents/Resources/node'));
  await writeFile(join(app, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.jevclean.native-checks</string><key>CFBundleExecutable</key><string>NativeChecks</string><key>LSUIElement</key><true/></dict></plist>');
  await writeFile(join(directory, 'control.json'), JSON.stringify({ busy: false, phase: 'idle', language: 'zh-CN' }));
  await writeFile(join(app, 'Contents/Resources/server.cjs'), `
const fs=require('node:fs');const http=require('node:http');const path=require('node:path');
const directory=process.env.JEVCLEAN_DATA_DIR;const file=path.join(directory,'instance.json');
if(fs.existsSync(file)){const old=JSON.parse(fs.readFileSync(file));try{process.kill(old.pid,0);process.exit(0);}catch{fs.unlinkSync(file);}}
const token='b'.repeat(64);const server=http.createServer((req,res)=>{
 const state=JSON.parse(fs.readFileSync(path.join(directory,'control.json')));res.setHeader('Content-Type','application/json');
 if(req.headers['x-jevclean-token']!==token){res.statusCode=401;res.end('{}');return;}
 if(req.url==='/api/runtime'){if(state.offline){res.statusCode=503;res.end('{}');}else res.end(JSON.stringify({ok:true,value:{processed:1,total:3,...state}}));return;}
 if(req.url==='/api/shutdown'&&req.method==='POST'){if(state.busy){res.statusCode=400;res.end(JSON.stringify({ok:false}));return;}
 res.end(JSON.stringify({ok:true,value:null}));setTimeout(()=>{server.closeIdleConnections();server.close(()=>{fs.unlinkSync(file);process.exit(0);});},20);return;}
 res.statusCode=404;res.end('{}');
});server.listen(0,'127.0.0.1',()=>fs.writeFileSync(file,JSON.stringify({pid:process.pid,url:'http://127.0.0.1:'+server.address().port+'/#session='+token})));
process.on('SIGTERM',()=>{server.closeIdleConnections();server.close(()=>{try{fs.unlinkSync(file);}catch{}process.exit(0);});});
`);
  const source = await readFile('scripts/macos-launcher.swift', 'utf8');
  const prefix = source.slice(0, source.lastIndexOf('\nlet application = NSApplication.shared'));
  const driver = `
extension Launcher {
    static func runChecks() {
        let subject = Launcher()
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        app.delegate = subject
        var opens = 0
        var terminated = false
        subject.browserOpener = { url in
            precondition(url.host == "127.0.0.1" && url.scheme == "http" && url.fragment?.hasPrefix("session=") == true)
            opens += 1
            return true
        }
        subject.terminateApplication = { terminated = true }
        func wait(_ message: String, _ condition: () -> Bool) {
            let deadline = Date().addingTimeInterval(10)
            while !condition() && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
            precondition(condition(), message)
        }
        func control(_ json: String) {
            try! Data(json.utf8).write(to: subject.directory.appendingPathComponent("control.json"))
            subject.refresh()
        }
        subject.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
        wait("initial readiness") { subject.healthy }
        precondition(subject.statusItem != nil && subject.statusItem?.button?.image?.isTemplate == true)
        precondition(subject.restartItem.isEnabled && subject.quitItem.isEnabled)
        precondition(opens == 0, "--no-open must suppress the initial browser only")
        let first = subject.current!.pid
        subject.openInterface()
        wait("explicit reopen despite --no-open") { opens == 1 }
        precondition(subject.current!.pid == first, "reopening must reuse the service")
        control("{\\\"busy\\\":true,\\\"phase\\\":\\\"moving\\\",\\\"language\\\":\\\"zh-CN\\\"}")
        wait("busy menu guard") { subject.busy && subject.stateItem.title.contains("整理中") }
        precondition(!subject.restartItem.isEnabled && !subject.quitItem.isEnabled && subject.openItem.isEnabled)
        subject.restart(); subject.quit()
        precondition(subject.primary?.processIdentifier == first && !subject.controlling, "busy control must not stop the service")
        control("{\\\"busy\\\":false,\\\"phase\\\":\\\"idle\\\",\\\"language\\\":\\\"en\\\",\\\"offline\\\":true}")
        wait("unreachable menu guard") { !subject.healthy }
        precondition(!subject.restartItem.isEnabled && !subject.quitItem.isEnabled)
        control("{\\\"busy\\\":false,\\\"phase\\\":\\\"idle\\\",\\\"language\\\":\\\"en\\\"}")
        wait("English menu") { subject.healthy && !subject.busy && subject.openItem.title == "Open app" }
        precondition(subject.stateItem.title == "JevClean · Ready" && subject.restartItem.title == "Restart app")
        let instance = subject.directory.appendingPathComponent("instance.json")
        let original = try! Data(contentsOf: instance)
        let bad = "{\\\"pid\\\":1,\\\"url\\\":\\\"https://external.example/#session=" + String(repeating: "b", count: 64) + "\\\"}"
        try! Data(bad.utf8).write(to: instance)
        precondition(subject.readSession() == nil, "reject external or malformed session addresses")
        try! original.write(to: instance)
        subject.restart()
        wait("idle restart") { subject.healthy && subject.current?.pid != first && opens == 2 }
        precondition(FileManager.default.fileExists(atPath: subject.directory.appendingPathComponent("control.json").path))
        subject.quit()
        wait("safe quit") { terminated && subject.primary == nil }
        precondition(!FileManager.default.fileExists(atPath: instance.path))
        subject.applicationWillTerminate(Notification(name: NSApplication.willTerminateNotification))
        precondition(subject.statusItem == nil)
        print("Native menu checks passed: icon, initial no-open, explicit reopen, single service, busy and unavailable guards, English, loopback validation, idle restart and quit.")
    }
}
Launcher.runChecks()
`;
  const swift = join(directory, 'main.swift');
  await writeFile(swift, prefix + driver);
  execFileSync('xcrun', ['swiftc', '-O', swift, '-o', join(app, 'Contents/MacOS/NativeChecks')], { stdio: 'inherit' });
  test = spawn(join(app, 'Contents/MacOS/NativeChecks'), ['--no-open'], { env: { ...process.env, JEVCLEAN_DATA_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; test.stdout.on('data', data => { output += data; }); test.stderr.on('data', data => { output += data; });
  const code = await new Promise((resolve, reject) => { test.once('exit', resolve); test.once('error', reject); });
  if (code !== 0) throw new Error('Native checks failed: ' + output.slice(-6000));
  console.log(output.trim());
} finally {
  if (test && test.exitCode === null) test.kill('SIGTERM');
  try { const value = JSON.parse(await readFile(join(directory, 'instance.json'), 'utf8')); process.kill(value.pid, 'SIGTERM'); } catch {}
  await rm(directory, { recursive: true, force: true });
}
