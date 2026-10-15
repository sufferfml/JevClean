// INPUT: bundled local service and authenticated runtime status. OUTPUT: menu bar, open/reopen, safe restart/quit.
// POS: macOS shell only; credentials, mail and task safety stay in src/local/main.ts and server.ts.
import AppKit

private struct Session {
    let pid: Int32
    let url: URL
    let origin: URL
    let token: String
}

final class Launcher: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var primary: Process?
    private var reopening: Process?
    private var statusItem: NSStatusItem?
    private let menu = NSMenu()
    private let stateItem = NSMenuItem(title: "JevClean", action: nil, keyEquivalent: "")
    private lazy var openItem = NSMenuItem(title: "打开应用", action: #selector(openInterface), keyEquivalent: "")
    private lazy var restartItem = NSMenuItem(title: "重启应用", action: #selector(restart), keyEquivalent: "")
    private lazy var quitItem = NSMenuItem(title: "退出应用", action: #selector(quit), keyEquivalent: "")
    private var timer: Timer?
    private var current: Session?
    private var fetching = false
    private var healthy = false
    private var busy = true
    private var controlling = false
    private var restarting = false
    private var approvedQuit = false
    private var pendingOpen = false
    private var english = false
    private var stateText = "启动中"
    // Injected only by isolated native checks; production uses the system browser and app lifecycle.
    private var browserOpener: (URL) -> Bool = { NSWorkspace.shared.open($0) }
    private var terminateApplication: () -> Void = { NSApplication.shared.terminate(nil) }

    private func text(_ zh: String, _ en: String) -> String { english ? en : zh }
    private var directory: URL {
        // Same directory contract as main.ts; test runs use an isolated data directory.
        if let value = ProcessInfo.processInfo.environment["JEVCLEAN_DATA_DIR"] {
            return URL(fileURLWithPath: value, isDirectory: true).standardizedFileURL
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/JevClean", isDirectory: true)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        menu.autoenablesItems = false
        menu.delegate = self
        stateItem.isEnabled = false
        [openItem, restartItem, quitItem].forEach { $0.target = self }
        menu.addItem(stateItem)
        menu.addItem(.separator())
        menu.addItem(openItem)
        menu.addItem(restartItem)
        menu.addItem(.separator())
        menu.addItem(quitItem)
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let icon = NSImage(systemSymbolName: "envelope", accessibilityDescription: "JevClean")
        icon?.size = NSSize(width: 18, height: 16)
        icon?.isTemplate = true
        item.button?.image = icon
        if icon == nil { item.button?.title = "J" }
        item.button?.setAccessibilityLabel("JevClean")
        item.menu = menu
        statusItem = item
        updateMenu()
        timer = Timer(timeInterval: 1.5, repeats: true) { [weak self] _ in self?.refresh() }
        RunLoop.main.add(timer!, forMode: .common)
        // --no-open applies only to first launch. A user's later open/restart always opens the UI.
        start(open: !CommandLine.arguments.contains("--no-open"))
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        openInterface()
        return false
    }

    func menuWillOpen(_ menu: NSMenu) { refresh() }

    private func start(open: Bool) {
        guard primary == nil else { return }
        guard let resources = Bundle.main.resourceURL else { failed(); return }
        pendingOpen = open
        approvedQuit = false
        current = nil
        healthy = false
        busy = true
        stateText = text("启动中", "Starting…")
        let child = Process()
        child.executableURL = resources.appendingPathComponent("node")
        // The macOS shell owns opening the browser. Never inherit an initial --no-open on reopen.
        child.arguments = [resources.appendingPathComponent("server.cjs").path, "--no-open"]
        child.standardOutput = FileHandle.nullDevice
        child.standardError = FileHandle.nullDevice
        child.terminationHandler = { [weak self] process in
            let code = process.terminationStatus
            let pid = process.processIdentifier
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.primary = nil
                self.fetching = false
                self.healthy = false
                if self.restarting {
                    self.restarting = false
                    self.controlling = false
                    self.start(open: true)
                    return
                }
                if code == 0 {
                    // A separately launched copy may briefly reuse an existing service.
                    if self.pendingOpen, let session = self.readSession(), session.pid != pid {
                        self.openBrowser(session)
                    }
                    self.approvedQuit = true
                    self.terminateApplication()
                } else {
                    self.busy = false
                    self.controlling = false
                    self.current = nil
                    self.stateText = self.text("已停止", "Stopped")
                    self.updateMenu()
                    self.failed()
                }
            }
        }
        do {
            try child.run()
            primary = child
            updateMenu()
            refresh()
        } catch {
            busy = false
            stateText = text("启动失败", "Startup failed")
            updateMenu()
            failed()
        }
    }

    private func readSession() -> Session? {
        guard let data = try? Data(contentsOf: directory.appendingPathComponent("instance.json")),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let raw = value["url"] as? String, let pid = value["pid"] as? Int32, pid > 0,
              var components = URLComponents(string: raw),
              components.scheme == "http", components.host == "127.0.0.1",
              let port = components.port, port > 0 && port <= 65535,
              components.user == nil, components.password == nil, components.path == "/", components.query == nil,
              let fragment = components.fragment, fragment.hasPrefix("session="),
              let url = components.url else { return nil }
        let token = String(fragment.dropFirst("session=".count))
        guard token.count == 64 && token.allSatisfy({ "0123456789abcdef".contains($0) }) else { return nil }
        components.fragment = nil
        guard let origin = components.url else { return nil }
        return Session(pid: pid, url: url, origin: origin, token: token)
    }

    private func request(_ session: Session, path: String, post: Bool = false, completion: @escaping (Int, [String: Any]?) -> Void) {
        var req = URLRequest(url: session.origin.appendingPathComponent("api/" + path))
        req.timeoutInterval = 3
        req.setValue(session.token, forHTTPHeaderField: "X-JevClean-Token")
        if post {
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = Data("{}".utf8)
        }
        URLSession.shared.dataTask(with: req) { data, response, _ in
            let body = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            DispatchQueue.main.async { completion(status, body) }
        }.resume()
    }

    private func refresh() {
        guard !fetching, !controlling, primary != nil else { return }
        guard let session = readSession() else { updateMenu(); return }
        fetching = true
        request(session, path: "runtime") { [weak self] code, body in
            guard let self = self else { return }
            self.fetching = false
            guard !self.controlling, self.primary != nil else { return }
            guard code == 200, body?["ok"] as? Bool == true,
                  let value = body?["value"] as? [String: Any], let running = value["busy"] as? Bool else {
                self.healthy = false
                self.busy = true
                self.stateText = self.text("连接中断", "Connection lost")
                self.updateMenu()
                return
            }
            self.current = session
            self.healthy = true
            self.busy = running
            self.english = value["language"] as? String == "en"
            let phase = value["phase"] as? String ?? "idle"
            let processed = value["processed"] as? Int ?? 0
            let total = value["total"] as? Int ?? 0
            let labels: [String: (String, String)] = [
                "connecting": ("连接中", "Connecting"),
                "scanning": ("分析中", "Analyzing"),
                "reading": ("读取中", "Reading emails"),
                "moving": ("整理中", "Organizing"),
                "restoring": ("撤销中", "Undoing"),
                "checking": ("核对中", "Checking results")
            ]
            let label = labels[phase] ?? ("处理中", "Working")
            self.stateText = running ? self.text(label.0, label.1) + (total > 0 ? " \(processed) / \(total)" : "…") : self.text("准备就绪", "Ready")
            self.updateMenu()
            if self.pendingOpen { self.pendingOpen = false; self.openBrowser(session) }
        }
    }

    private func updateMenu() {
        stateItem.title = "JevClean · " + stateText
        openItem.title = text("打开应用", "Open app")
        restartItem.title = text("重启应用", "Restart app")
        quitItem.title = text("退出应用", "Quit app")
        let canStop = !controlling && (primary == nil || healthy && !busy)
        restartItem.isEnabled = canStop
        quitItem.isEnabled = canStop
        openItem.isEnabled = !controlling
        restartItem.toolTip = canStop ? nil : text("请等当前任务完成。", "Wait for the current task to finish.")
        quitItem.toolTip = restartItem.toolTip
        statusItem?.button?.toolTip = "JevClean · " + stateText
    }

    @objc private func openInterface() {
        guard !controlling, reopening?.isRunning != true else { return }
        if primary == nil { start(open: true); return }
        guard let resources = Bundle.main.resourceURL else { failed(); return }
        let helper = Process()
        helper.executableURL = resources.appendingPathComponent("node")
        helper.arguments = [resources.appendingPathComponent("server.cjs").path, "--no-open"]
        helper.standardOutput = FileHandle.nullDevice
        helper.standardError = FileHandle.nullDevice
        helper.terminationHandler = { [weak self] process in
            let succeeded = process.terminationStatus == 0
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.reopening = nil
                if succeeded { self.pendingOpen = true; self.refresh() } else { self.failed() }
            }
        }
        do { try helper.run(); reopening = helper } catch { failed() }
    }

    private func openBrowser(_ session: Session) {
        // Validated loopback URL, in memory only. Never write the token or session URL to logs.
        if !browserOpener(session.url) {
            let alert = NSAlert()
            alert.messageText = text("打开失败", "Could not open app")
            alert.informativeText = text("应用仍在运行。请设置默认浏览器后重新打开。", "The app is still running. Set a default browser, then open the app again.")
            alert.runModal()
        }
    }

    @objc private func restart() { stop(restart: true) }
    @objc private func quit() { stop(restart: false) }

    private func stop(restart: Bool) {
        guard !controlling else { return }
        if primary == nil {
            if restart { start(open: true) } else { approvedQuit = true; terminateApplication() }
            return
        }
        guard healthy, !busy, let session = current else { refresh(); return }
        controlling = true
        restarting = restart
        stateText = text(restart ? "重启中" : "退出中", restart ? "Restarting…" : "Quitting…")
        updateMenu()
        // The service checks its live task lock again. Never kill a process to bypass this check.
        request(session, path: "shutdown", post: true) { [weak self] code, body in
            guard let self = self else { return }
            if code == 200 && body?["ok"] as? Bool == true { return }
            self.controlling = false
            self.restarting = false
            self.refresh()
            let alert = NSAlert()
            alert.messageText = self.text("稍后再试", "Try again later")
            alert.informativeText = self.text("任务进行中，或应用暂未响应。请等任务结束后再试。", "A task is running or the app is not responding. Wait for it to finish, then try again.")
            alert.runModal()
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if approvedQuit || primary == nil { return .terminateNow }
        stop(restart: false)
        return .terminateCancel
    }

    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
        if let item = statusItem { NSStatusBar.system.removeStatusItem(item) }
        statusItem = nil
    }

    private func failed() {
        let alert = NSAlert()
        alert.messageText = text("启动失败", "Startup failed")
        alert.informativeText = text("请检查应用文件是否完整。确认能读取保存的数据和密码。可从菜单栏尝试重启。", "Check that the app files are complete and saved data and passwords can be read. Try restarting from the menu bar.")
        alert.runModal()
    }
}

let application = NSApplication.shared
let launcher = Launcher()
application.setActivationPolicy(.accessory)
application.delegate = launcher
application.run()
