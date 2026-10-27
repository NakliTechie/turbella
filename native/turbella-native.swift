// Turbella's native helper for macOS, built on first use by `turbella overlay`
// or `turbella run` (src/tools.js) with the system swiftc. No dependencies.
//
//   turbella-native overlay <url> <pidfile>
//       Small always-on-top windows showing the daemon at <url>: one per active
//       agent session by default, or one for all sessions. They float over every
//       app and Space and never take focus from the agent. A menu bar item
//       switches that mode, pages, looks, opacity and click-through.
//
//   turbella-native run <port> <command> [args...]
//       Runs the command in a pseudo-terminal one row shorter than this one and
//       pins a one-line strip (gauge, current tool) to the top row. The strip
//       shows only this agent: TURBELLA_RUN tags its events. Rows the
//       agent addresses are shifted down by one on the way out, and cursor and
//       mouse reports shifted up by one on the way in, so the agent never sees
//       the strip.
//
// Both read only what the page reads: the daemon's /events and /status on
// 127.0.0.1. Nothing leaves the machine.

import Cocoa
import Foundation
import WebKit

let args = CommandLine.arguments
func fail(_ msg: String) -> Never {
  FileHandle.standardError.write(("turbella-native: " + msg + "\n").data(using: .utf8)!)
  exit(2)
}

// MARK: - overlay

// One floating window: a panel holding the visualiser for one session, or for
// all sessions together (key "*").
final class Floater {
  let key: String
  let slot: Int
  let panel: NSPanel
  let web: WKWebView
  init(key: String, slot: Int, panel: NSPanel, web: WKWebView) { self.key = key; self.slot = slot; self.panel = panel; self.web = web }
}

final class Overlay: NSObject, NSApplicationDelegate, NSWindowDelegate {
  static let all = "*"
  static let maxWindows = 8
  let base: URL
  let pidfile: String
  var windows: [String: Floater] = [:]
  var dismissed = Set<String>()     // closed by the person; not reopened
  var showViz = true
  var item: NSStatusItem!
  var cycleItem: NSMenuItem!
  var nextItem: NSMenuItem!
  var lockItem: NSMenuItem!
  var perSessionItem: NSMenuItem!
  var opacityItems: [NSMenuItem] = []
  var session: URLSession!
  var timer: Timer?
  let defaults = UserDefaults(suiteName: "com.naklitechie.turbella.overlay") ?? .standard
  var perSession: Bool { defaults.object(forKey: "perSession") as? Bool ?? true }
  var opacity: CGFloat { defaults.object(forKey: "opacity") as? CGFloat ?? 1 }
  var clickThrough = false

  init(url: URL, pidfile: String) { self.base = url; self.pidfile = pidfile }

  func applicationDidFinishLaunching(_ note: Notification) {
    try? String(getpid()).write(toFile: pidfile, atomically: true, encoding: .utf8)
    session = URLSession(configuration: .ephemeral)
    buildMenu()
    refresh()
    timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.refresh() }
  }

  func applicationWillTerminate(_ note: Notification) { try? FileManager.default.removeItem(atPath: pidfile) }

  // MARK: sessions -> windows

  struct Active { let session: String; let agent: String }

  func refresh() {
    session.dataTask(with: base.appendingPathComponent("status")) { [weak self] data, _, _ in
      guard let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
      let list = (obj["sessions"] as? [[String: Any]] ?? []).compactMap { s -> Active? in
        guard let id = s["session"] as? String, !id.isEmpty else { return nil }
        return Active(session: id, agent: s["agent"] as? String ?? "agent")
      }
      DispatchQueue.main.async { self?.reconcile(list) }
    }.resume()
  }

  func reconcile(_ active: [Active]) {
    var want: [String: String] = [:] // key -> title
    if perSession {
      for a in active where !dismissed.contains(a.session) {
        if want.count >= Overlay.maxWindows { break }
        want[a.session] = "\(a.agent) · \(a.session.prefix(8))"
      }
    }
    // The combined window: always in combined mode, and in per-session mode
    // while no session is active, so there is something to look at.
    if (!perSession || want.isEmpty) && !dismissed.contains(Overlay.all) {
      want[Overlay.all] = perSession ? "Turbella · waiting for an agent" : "Turbella · all sessions"
    }
    for key in windows.keys where want[key] == nil { close(key) }
    for (key, title) in want {
      if let w = windows[key] { w.panel.title = title } else { open(key, title: title) }
    }
  }

  func pageURL(for key: String) -> URL {
    var c = URLComponents(url: base, resolvingAgainstBaseURL: false)!
    c.path = showViz ? "/viz" : "/"
    var q = showViz ? [URLQueryItem(name: "overlay", value: "1")] : []
    if key != Overlay.all && showViz { q.append(URLQueryItem(name: "session", value: key)) }
    c.queryItems = q.isEmpty ? nil : q
    return c.url!
  }

  // New windows stack down the right edge of the screen, then in a second column.
  func frame(slot: Int) -> NSRect {
    let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1280, height: 800)
    let w: CGFloat = 320, h: CGFloat = 200, gap: CGFloat = 12
    let perColumn = max(1, Int((screen.height - gap) / (h + gap)))
    let col = slot / perColumn, row = slot % perColumn
    return NSRect(x: screen.maxX - gap - w - CGFloat(col) * (w + gap),
                  y: screen.maxY - gap - h - CGFloat(row) * (h + gap), width: w, height: h)
  }

  func open(_ key: String, title: String) {
    let used = Set(windows.values.map(\.slot))
    let slot = (0...).first { !used.contains($0) }!
    // A non-activating panel: clicks reach the page without pulling focus
    // away from the agent's window.
    let panel = NSPanel(contentRect: frame(slot: slot),
                        styleMask: [.titled, .closable, .resizable, .utilityWindow, .nonactivatingPanel],
                        backing: .buffered, defer: false)
    panel.title = title
    panel.identifier = NSUserInterfaceItemIdentifier(key)
    panel.appearance = NSAppearance(named: .darkAqua)
    panel.isFloatingPanel = true
    panel.level = .floating
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.hidesOnDeactivate = false
    panel.backgroundColor = .black
    panel.minSize = NSSize(width: 200, height: 120)
    panel.isReleasedWhenClosed = false
    panel.delegate = self
    panel.alphaValue = opacity
    panel.ignoresMouseEvents = clickThrough
    let web = WKWebView(frame: panel.contentView!.bounds, configuration: WKWebViewConfiguration())
    web.autoresizingMask = [.width, .height]
    web.setValue(false, forKey: "drawsBackground")
    panel.contentView!.addSubview(web)
    web.load(URLRequest(url: pageURL(for: key)))
    panel.orderFrontRegardless()
    windows[key] = Floater(key: key, slot: slot, panel: panel, web: web)
  }

  func close(_ key: String) {
    guard let w = windows.removeValue(forKey: key) else { return }
    w.panel.delegate = nil
    w.panel.close()
  }

  // The person closed a window: keep it closed until "Show all windows".
  func windowWillClose(_ note: Notification) {
    guard let key = (note.object as? NSPanel)?.identifier?.rawValue, windows[key] != nil else { return }
    dismissed.insert(key)
    windows.removeValue(forKey: key)
  }

  // MARK: menu bar

  func buildMenu() {
    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    item.button?.image = NSImage(systemSymbolName: "waveform", accessibilityDescription: "Turbella")
    let menu = NSMenu()
    menu.autoenablesItems = false
    func add(_ title: String, _ sel: Selector, _ key: String = "") -> NSMenuItem {
      let m = NSMenuItem(title: title, action: sel, keyEquivalent: key)
      m.target = self
      menu.addItem(m)
      return m
    }
    perSessionItem = add("One window per session", #selector(togglePerSession))
    perSessionItem.state = perSession ? .on : .off
    _ = add("Show all windows", #selector(showAll))
    menu.addItem(.separator())
    _ = add("Visualiser", #selector(showVisualiser))
    _ = add("Timeline", #selector(showTimeline))
    nextItem = add("Next look", #selector(nextLook))
    cycleItem = add("Cycle looks", #selector(toggleCycle))
    menu.addItem(.separator())
    lockItem = add("Click-through", #selector(toggleLock))
    let op = NSMenuItem(title: "Opacity", action: nil, keyEquivalent: "")
    let sub = NSMenu()
    for v in [1.0, 0.85, 0.7, 0.5] {
      let m = NSMenuItem(title: "\(Int(v * 100))%", action: #selector(setOpacity(_:)), keyEquivalent: "")
      m.target = self
      m.representedObject = v
      m.state = abs(opacity - v) < 0.01 ? .on : .off
      sub.addItem(m)
      opacityItems.append(m)
    }
    op.submenu = sub
    menu.addItem(op)
    menu.addItem(.separator())
    _ = add("Quit Turbella overlay", #selector(quit), "q")
    item.menu = menu
  }

  func each(_ js: String) { for w in windows.values { w.web.evaluateJavaScript(js, completionHandler: nil) } }
  func reloadAll() { for w in windows.values { w.web.load(URLRequest(url: pageURL(for: w.key))) } }

  @objc func togglePerSession() {
    defaults.set(!perSession, forKey: "perSession")
    perSessionItem.state = perSession ? .on : .off
    refresh()
  }
  @objc func showAll() {
    dismissed.removeAll()
    for w in windows.values { w.panel.orderFrontRegardless() }
    refresh()
  }
  @objc func showVisualiser() { showViz = true; nextItem.isEnabled = true; cycleItem.isEnabled = true; reloadAll() }
  @objc func showTimeline() { showViz = false; nextItem.isEnabled = false; cycleItem.isEnabled = false; reloadAll() }
  @objc func quit() { NSApp.terminate(nil) }
  @objc func nextLook() { each("window.turbella.tools.next_look(); 0") }
  @objc func toggleCycle() {
    let on = cycleItem.state != .on
    cycleItem.state = on ? .on : .off
    each("window.turbella.tools.cycle_looks({ on: \(on) }); 0")
  }
  // Click-through lets the agent's window take clicks under the overlay; the
  // menu bar item turns it off again.
  @objc func toggleLock() {
    clickThrough.toggle()
    lockItem.state = clickThrough ? .on : .off
    for w in windows.values { w.panel.ignoresMouseEvents = clickThrough }
  }
  @objc func setOpacity(_ sender: NSMenuItem) {
    let v = sender.representedObject as? Double ?? 1
    defaults.set(v, forKey: "opacity")
    for w in windows.values { w.panel.alphaValue = v }
    for m in opacityItems { m.state = m === sender ? .on : .off }
  }
}

// MARK: - run: daemon feed

// Follows /events and /status for the strip. Callbacks arrive on URLSession's
// queue; the terminal loop reads a snapshot under the lock.
final class Feed: NSObject, URLSessionDataDelegate {
  let base: String
  let run: String            // this wrapper's id; the hook copies it into the agent's events
  var mine = Set<String>()   // sessions that carried it, for events that do not
  let lock = NSLock()
  let opened = Date().timeIntervalSince1970 * 1000
  var gauge = 0.0
  var label = "waiting for the agent"
  var since = Date()
  var open = Set<String>()   // tool calls started and not ended
  var turns = Set<String>()  // sessions with a turn in progress
  var version = 0
  var pending = Data()
  var session: URLSession!

  init(port: Int, run: String) {
    base = "http://127.0.0.1:\(port)"
    self.run = run
    super.init()
    session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
    connect()
    let timer = DispatchSource.makeTimerSource(queue: .global())
    timer.schedule(deadline: .now(), repeating: 2)
    timer.setEventHandler { [weak self] in self?.pollStatus() }
    timer.resume()
    statusTimer = timer
  }
  var statusTimer: DispatchSourceTimer?

  func connect() {
    var req = URLRequest(url: URL(string: base + "/events")!)
    req.timeoutInterval = 3600 * 24
    session.dataTask(with: req).resume()
  }

  func pollStatus() {
    session.dataTask(with: URL(string: base + "/status?run=" + run)!) { [weak self] data, _, _ in
      guard let self, let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let g = obj["gauge"] as? Double else { return }
      self.lock.lock(); if g != self.gauge { self.gauge = g; self.version += 1 }; self.lock.unlock()
    }.resume()
  }

  func urlSession(_ s: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    pending.append(data)
    while let nl = pending.firstIndex(of: 0x0A) {
      let line = pending[pending.startIndex..<nl]
      pending = Data(pending[(nl + 1)...])
      guard line.starts(with: Data("data: ".utf8)),
            let ev = try? JSONSerialization.jsonObject(with: line.dropFirst(6)) as? [String: Any] else { continue }
      take(ev)
    }
  }

  func urlSession(_ s: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard task.originalRequest?.url?.path == "/events" else { return }
    lock.lock(); label = "reconnecting to the daemon"; since = Date(); version += 1; lock.unlock()
    DispatchQueue.global().asyncAfter(deadline: .now() + 2) { [weak self] in self?.connect() }
  }

  static let words = ["tool": "ok", "tool_fail": "failed", "permission": "waiting for permission", "think": "thinking",
                      "subagent": "subagent", "stop": "stopped", "turn": "new turn", "notification": "notification"]

  func take(_ ev: [String: Any]) {
    // The backlog sent on connect is history, not news.
    if (ev["ts"] as? Double ?? 0) < opened - 2000 { return }
    let kind = ev["kind"] as? String ?? ""
    let status = ev["status"] as? String ?? ""
    let tool = ev["tool"] as? String
    let session = ev["session"] as? String ?? ""
    let key = "\(session)|\(tool ?? "")|\(ev["sig"] as? String ?? "")"
    lock.lock(); defer { lock.unlock() }
    // Only this wrapper's agent: events it tagged, and others from its sessions.
    if ev["run"] as? String == run { if !session.isEmpty { mine.insert(session) } }
    else if session.isEmpty || !mine.contains(session) { return }
    if kind == "stop" {
      turns.remove(session)
      open = open.filter { !$0.hasPrefix(session + "|") }
    } else if kind != "notification" {
      turns.insert(session)
    }
    let running = kind == "tool" && status == "waiting"
    if running { open.insert(key) } else if kind == "tool" || kind == "tool_fail" { open.remove(key) }
    label = [tool, running ? "running" : Feed.words[kind] ?? kind].compactMap { $0 }.joined(separator: " · ")
    since = Date()
    version += 1
  }

  // The strip's text and gauge, and a key that changes when either should redraw.
  func snapshot() -> (gauge: Double, text: String, key: String) {
    lock.lock(); defer { lock.unlock() }
    let s = Int(Date().timeIntervalSince(since))
    var text = label
    if s >= 2 && !open.isEmpty { text += " · \(s) s" }
    else if s >= 2 && !turns.isEmpty { text += " · working, \(s) s since" }
    return (gauge, text, "\(version)|\(text)")
  }
}

// MARK: - run: terminal

nonisolated(unsafe) var resized: sig_atomic_t = 0

final class Wrapper {
  let master: Int32
  var rows: Int
  var cols: Int
  let feed: Feed
  // What the agent has set, as far as the strip cares.
  var origin = false     // DECOM: the agent's cursor rows are relative to its region
  var saved = false      // the agent saved its cursor and has not restored it
  var syncing = false    // inside a synchronized update (?2026)
  var cprWanted = 0      // cursor position reports the agent asked for
  // Escape sequence parser state for the agent's output.
  enum State { case ground, esc, escInter, csi, str, strEsc }
  var state = State.ground
  var seq: [UInt8] = []
  var drawn = ""
  var dirty = true

  init(master: Int32, rows: Int, cols: Int, feed: Feed) {
    self.master = master; self.rows = rows; self.cols = cols; self.feed = feed
  }

  static func put(_ fd: Int32, _ bytes: [UInt8]) {
    var off = 0
    while off < bytes.count {
      let n = bytes[off...].withUnsafeBufferPointer { write(fd, $0.baseAddress, $0.count) }
      if n < 0 { if errno == EINTR || errno == EAGAIN { continue }; return }
      off += n
    }
  }
  func out(_ s: String) { Wrapper.put(1, Array(s.utf8)) }

  // Reserve the top row: the agent's region is rows 2…N.
  func margins() -> String { "\u{1b}7\u{1b}[2;\(rows)r\u{1b}8" }

  func start() {
    out("\u{1b}[2J\u{1b}[2;\(rows)r\u{1b}[2;1H")
    draw(force: true)
  }

  func finish() {
    out("\u{1b}7\u{1b}[r\u{1b}8\u{1b}7\u{1b}[1;1H\u{1b}[2K\u{1b}8\r\n")
  }

  func resize(rows: Int, cols: Int) {
    self.rows = rows; self.cols = cols
    out(margins())
    dirty = true
  }

  // MARK: agent output: shift absolute rows down one

  func fromAgent(_ bytes: ArraySlice<UInt8>) {
    var o: [UInt8] = []
    o.reserveCapacity(bytes.count + 32)
    for b in bytes {
      switch state {
      case .ground:
        if b == 0x1B { state = .esc; seq = [b] } else { o.append(b) }
      case .esc:
        seq.append(b)
        switch b {
        case 0x5B: state = .csi                                   // [
        case 0x5D, 0x50, 0x5F, 0x5E, 0x58: o += seq; state = .str // ] P _ ^ X
        case 0x20...0x2F: state = .escInter
        default:
          o += seq; state = .ground
          if b == 0x37 { saved = true }                           // ESC 7
          if b == 0x38 { saved = false }                          // ESC 8
          if b == 0x63 { o += Array(("\u{1b}[2;\(rows)r\u{1b}[2;1H").utf8); origin = false; dirty = true } // ESC c
        }
      case .escInter:
        seq.append(b)
        if (0x30...0x7E).contains(b) { o += seq; state = .ground }
      case .csi:
        seq.append(b)
        if (0x40...0x7E).contains(b) { o += csi(seq); state = .ground }
        else if seq.count > 256 { o += seq; state = .ground }
      case .str:
        o.append(b)
        if b == 0x07 { state = .ground } else if b == 0x1B { state = .strEsc }
      case .strEsc:
        o.append(b)
        state = .ground
      }
    }
    Wrapper.put(1, o)
  }

  func csi(_ s: [UInt8]) -> [UInt8] {
    let final = s.last!
    var body = String(decoding: s[2..<(s.count - 1)], as: UTF8.self)
    var priv = ""
    if let f = body.first, "?<=>".contains(f) { priv = String(f); body.removeFirst() }
    let raw = body.split(separator: ";", omittingEmptySubsequences: false).map(String.init)
    let num = { (i: Int) -> Int? in i < raw.count ? Int(raw[i]) : nil }
    func shift(_ r: Int?) -> Int { max(1, r ?? 1) + 1 }

    if priv.isEmpty {
      switch final {
      case 0x48, 0x66: // CUP, HVP
        if origin { break }
        let col = raw.count > 1 ? raw[1] : ""
        return Array("\u{1b}[\(shift(num(0)));\(col)\(Character(UnicodeScalar(final)))".utf8)
      case 0x64: // VPA
        if origin { break }
        return Array("\u{1b}[\(shift(num(0)))d".utf8)
      case 0x72: // DECSTBM
        let top = (num(0) ?? 1) + 1
        let bottom = min(rows, (num(1).map { $0 == 0 ? rows - 1 : $0 } ?? (rows - 1)) + 1)
        return Array("\u{1b}[\(max(2, top));\(bottom)r".utf8) + (origin ? [] : Array("\u{1b}[2;1H".utf8))
      case 0x4A: // ED: a full or upper clear wipes the strip
        if (num(0) ?? 0) != 0 { dirty = true }
      case 0x73: if raw == [""] { saved = true }   // SCOSC
      case 0x75: if raw == [""] { saved = false }  // SCORC
      case 0x6E: if num(0) == 6 { cprWanted += 1 } // DSR cursor position
      default: break
      }
    } else if priv == "?" && (final == 0x68 || final == 0x6C) {
      let on = final == 0x68
      for p in raw.compactMap({ Int($0) }) {
        switch p {
        case 6: origin = on
        case 47, 1047, 1049: dirty = true
        case 2026: syncing = on
        default: break
        }
      }
    } else if priv == "?" && final == 0x6E && num(0) == 6 {
      cprWanted += 1
    }
    return s
  }

  // MARK: keyboard and reports: shift rows up one

  func fromTerminal(_ bytes: ArraySlice<UInt8>) -> [UInt8] {
    let s = String(decoding: bytes, as: UTF8.self)
    guard s.contains("\u{1b}[") else { return Array(bytes) }
    var out = ""
    var rest = Substring(s)
    // Cursor position reports, only when the agent asked: ESC [ row ; col R
    // (unrequested, the same bytes are a modified F3 key). SGR mouse:
    // ESC [ < b ; x ; y M|m, dropped when it lands on the strip.
    while let r = rest.range(of: "\u{1b}[") {
      out += rest[..<r.lowerBound]
      var tail = rest[r.upperBound...]
      let isMouse = tail.first == "<"
      if isMouse { tail = tail.dropFirst() }
      let end = tail.firstIndex { !("0123456789;".contains($0)) }
      if let end, let fin = tail[end...].first {
        let nums = tail[..<end].split(separator: ";", omittingEmptySubsequences: false).map { Int($0) }
        if !isMouse && fin == "R" && nums.count == 2 && cprWanted > 0, let row = nums[0], let col = nums[1] {
          cprWanted -= 1
          out += "\u{1b}[\(max(1, row - 1));\(col)R"
          rest = tail[tail.index(after: end)...]
          continue
        }
        if isMouse && (fin == "M" || fin == "m") && nums.count == 3, let b = nums[0], let x = nums[1], let y = nums[2] {
          if y > 1 { out += "\u{1b}[<\(b);\(x);\(y - 1)\(fin)" }
          rest = tail[tail.index(after: end)...]
          continue
        }
      }
      out += "\u{1b}["
      rest = rest[r.upperBound...]
    }
    out += rest
    return Array(out.utf8)
  }

  // MARK: the strip

  func draw(force: Bool = false) {
    guard state == .ground, !syncing, !saved else { return }
    let snap = feed.snapshot()
    if !force && !dirty && snap.key == drawn { return }
    drawn = snap.key
    dirty = false
    let g = max(0, min(1, snap.gauge))
    let filled = Int((g * 10).rounded())
    let colour = g >= 0.5 ? 160 : g >= 0.25 ? 214 : 39
    let bar = String(repeating: "█", count: filled) + String(repeating: "░", count: 10 - filled)
    let head = " turbella "
    let gaugeText = " \(String(format: "%.2f", g)) "
    var label = " " + snap.text + " "
    let room = cols - 1 - head.count - bar.count - gaugeText.count
    if room < 4 { label = "" } else if label.count > room { label = String(label.prefix(room - 1)) + "…" }
    var s = "\u{1b}7\u{1b}[?6l\u{1b}[1;1H\u{1b}[0;48;5;236;38;5;250m\u{1b}[2K"
    s += "\u{1b}[1m\(head)\u{1b}[22m\u{1b}[38;5;\(colour)m\(bar)\u{1b}[38;5;250m\(gaugeText)\u{1b}[38;5;245m\(label)"
    s += "\u{1b}[0m" + (origin ? "\u{1b}[?6h" : "") + "\u{1b}8"
    out(s)
  }
}

func winsizeOf(_ fd: Int32) -> winsize? {
  var ws = winsize()
  return ioctl(fd, TIOCGWINSZ, &ws) == 0 && ws.ws_row > 2 ? ws : nil
}

func runWrapped(port: Int, command: [String]) -> Int32 {
  // The agent and its hooks inherit this; the hook copies it into each event.
  let runId = String(UUID().uuidString.prefix(8)).lowercased()
  setenv("TURBELLA_RUN", runId, 1)
  var cargs: [UnsafeMutablePointer<CChar>?] = command.map { strdup($0) } + [nil]
  // No terminal, or one too small for a strip: run the agent as it is.
  guard isatty(0) == 1, isatty(1) == 1, var ws = winsizeOf(1) else {
    execvp(cargs[0], &cargs)
    fail("cannot run \(command[0]): \(String(cString: strerror(errno)))")
  }
  var original = termios()
  tcgetattr(0, &original)
  var inner = ws
  inner.ws_row -= 1
  var master: Int32 = -1
  var term = original
  let pid = forkpty(&master, nil, &term, &inner)
  if pid < 0 { fail("forkpty failed") }
  if pid == 0 {
    execvp(cargs[0], &cargs)
    let msg = "turbella run: cannot run \(command[0]): \(String(cString: strerror(errno)))\n"
    _ = msg.withCString { write(2, $0, strlen($0)) }
    _exit(127)
  }

  var rawMode = original
  cfmakeraw(&rawMode)
  tcsetattr(0, TCSANOW, &rawMode)
  signal(SIGWINCH) { _ in resized = 1 }

  let feed = Feed(port: port, run: runId)
  let w = Wrapper(master: master, rows: Int(ws.ws_row), cols: Int(ws.ws_col), feed: feed)
  w.start()

  var buf = [UInt8](repeating: 0, count: 65536)
  var fds = [pollfd(fd: 0, events: Int16(POLLIN), revents: 0), pollfd(fd: master, events: Int16(POLLIN), revents: 0)]
  var lastDraw = Date()
  loop: while true {
    if resized != 0 {
      resized = 0
      if let now = winsizeOf(1) {
        ws = now
        inner = now
        inner.ws_row -= 1
        _ = ioctl(master, TIOCSWINSZ, &inner)
        w.resize(rows: Int(now.ws_row), cols: Int(now.ws_col))
      }
    }
    fds[0].revents = 0; fds[1].revents = 0
    let n = poll(&fds, 2, 250)
    if n < 0 && errno != EINTR { break }
    if fds[1].revents != 0 {
      let r = read(master, &buf, buf.count)
      if r <= 0 { break loop }
      w.fromAgent(buf[0..<r])
    }
    if fds[0].revents & Int16(POLLIN) != 0 {
      let r = read(0, &buf, buf.count)
      if r > 0 { Wrapper.put(master, w.fromTerminal(buf[0..<r])) }
    }
    // Redraw when the feed changed, at most a few times a second.
    if Date().timeIntervalSince(lastDraw) > 0.2 { w.draw(); lastDraw = Date() }
  }

  var status: Int32 = 0
  waitpid(pid, &status, 0)
  w.finish()
  tcsetattr(0, TCSANOW, &original)
  return (status & 0x7f) == 0 ? (status >> 8) & 0xff : 128 + (status & 0x7f)
}

// MARK: - main

guard args.count >= 2 else { fail("usage: turbella-native overlay <url> <pidfile> | run <port> <command> [args...]") }
switch args[1] {
case "overlay":
  guard args.count == 4, let url = URL(string: args[2]) else { fail("usage: turbella-native overlay <url> <pidfile>") }
  let app = NSApplication.shared
  app.setActivationPolicy(.accessory)
  let delegate = Overlay(url: url, pidfile: args[3])
  app.delegate = delegate
  app.run()
case "run":
  guard args.count >= 4, let port = Int(args[2]) else { fail("usage: turbella-native run <port> <command> [args...]") }
  exit(runWrapped(port: port, command: Array(args[3...])))
default:
  fail("unknown mode \(args[1])")
}
