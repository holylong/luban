// luban glow — the screen itself says "the agent holds this Mac".
//
// The terminal cannot paint over other applications, so the CLI variant of
// computer control draws its rim with a native overlay: one borderless,
// click-through window per display, at the screensaver level, above full-screen
// apps. It is a separate process on purpose — the agent's backend may be a
// child of a terminal that is free to be busy elsewhere, and killing this file's
// process is what turns the rim off.
//
// Usage:
//   luban-glow [--label "luban 正在操控"] [--stop-file ~/.luban/computer/stop]
//              [--parent-pid 1234] [--timeout 7200]
//
// + ⌘. anywhere (global key monitor, needs Accessibility) or SIGTERM/SIGINT
//   writes the stop file, plays a red fade and exits — so the next action the
//   backend attempts is refused by the same flag the desktop app uses.
//
// Build: swiftc -O glow.swift -o luban-glow

import AppKit
import CoreGraphics
import Foundation

// MARK: - Options

struct Options {
    var label = "luban 正在操控"
    var stopFile: String?
    var parentPid: Int32?
    var timeout: Double = 7200
}

func parseOptions(_ arguments: [String]) -> Options {
    var options = Options()
    var index = 1
    while index < arguments.count {
        let flag = arguments[index]
        let value = index + 1 < arguments.count ? arguments[index + 1] : nil
        switch flag {
        case "--label": options.label = value ?? options.label; index += 2
        case "--stop-file": options.stopFile = value; index += 2
        case "--parent-pid": options.parentPid = value.flatMap { Int32($0) }; index += 2
        case "--timeout": options.timeout = value.flatMap { Double($0) } ?? options.timeout; index += 2
        default: index += 1
        }
    }
    return options
}

let options = parseOptions(CommandLine.arguments)

// MARK: - Shared animation state

/// One clock for every display, so two monitors pulse in step.
final class GlowState {
    let started = Date()
    var stopping = false
    var stopStarted = Date()
    /// Written by the ⌘. monitor; the backend re-reads it before every action.
    var stopFile: String?
    var label: String

    init(stopFile: String?, label: String) {
        self.stopFile = stopFile
        self.label = label
    }

    var time: Double { Date().timeIntervalSince(started) }

    func requestStop() {
        if stopping { return }
        stopping = true
        stopStarted = Date()
        if let path = stopFile {
            try? "\(Int(Date().timeIntervalSince1970 * 1000))".write(toFile: path, atomically: true, encoding: .utf8)
        }
        // Every view repaints with the red accent for the length of the fade.
        for window in NSApp.windows { window.contentView?.needsDisplay = true }
    }
}

let state = GlowState(stopFile: options.stopFile, label: options.label)

// MARK: - The rim

final class RimView: NSView {
    override var isOpaque: Bool { false }

    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        let width = bounds.width
        let height = bounds.height
        context.clear(CGRect(x: 0, y: 0, width: width, height: height))

        let stopping = state.stopping
        // The fade is short and fixed: 0.7s of red, then the process exits.
        let fade = stopping ? max(0, 1 - Date().timeIntervalSince(state.stopStarted) / 0.7) : 1
        let accent: (CGFloat, CGFloat, CGFloat) = stopping ? (1.0, 0.38, 0.42) : (0.43, 0.66, 1.0)
        let pulse = 0.55 + 0.45 * sin(state.time * 2.2)
        let strength = CGFloat(pulse * fade)

        // Four soft bands hugging the edges; the middle of the screen stays
        // untouched so text under the rim is never dimmed.
        let depth: CGFloat = 64
        let bands: [(CGRect, CGPoint, CGPoint)] = [
            (CGRect(x: 0, y: height - depth, width: width, height: depth), CGPoint(x: 0, y: height), CGPoint(x: 0, y: height - depth)),
            (CGRect(x: 0, y: 0, width: width, height: depth), CGPoint(x: 0, y: 0), CGPoint(x: 0, y: depth)),
            (CGRect(x: 0, y: 0, width: depth, height: height), CGPoint(x: 0, y: 0), CGPoint(x: depth, y: 0)),
            (CGRect(x: width - depth, y: 0, width: depth, height: height), CGPoint(x: width, y: 0), CGPoint(x: width - depth, y: 0)),
        ]
        for (rect, start, end) in bands {
            let colors = [
                CGColor(red: accent.0, green: accent.1, blue: accent.2, alpha: 0.42 * strength),
                CGColor(red: accent.0, green: accent.1, blue: accent.2, alpha: 0),
            ] as CFArray
            if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1]) {
                context.saveGState()
                context.clip(to: rect)
                context.drawLinearGradient(gradient, start: start, end: end, options: [])
                context.restoreGState()
            }
        }

        // Hairline: the whole screen is "held".
        context.setStrokeColor(CGColor(red: accent.0, green: accent.1, blue: accent.2, alpha: 0.85 * strength))
        context.setLineWidth(2)
        context.stroke(CGRect(x: 1, y: 1, width: width - 2, height: height - 2))
        // A second, dimmer line 6px in: the rim reads as a lit frame on a bright
        // desktop too, not only as a tint that a white window can swallow.
        context.setStrokeColor(CGColor(red: accent.0, green: accent.1, blue: accent.2, alpha: 0.30 * strength))
        context.setLineWidth(1)
        context.stroke(CGRect(x: 6.5, y: 6.5, width: width - 13, height: height - 13))

        // Arcs travel along the rim, each a jagged bolt of live current.
        let perimeter = 2 * (width + height)
        let travel = CGFloat((state.time * (stopping ? 900 : 320)).truncatingRemainder(dividingBy: Double(perimeter)))
        let segment = CGFloat(190 + 60 * sin(state.time * 1.7))
        for index in 0..<3 {
            let (startX, startY, dx, dy) = rimPoint(distance: travel + CGFloat(index) * 420, width: width, height: height)
            let length = min(segment + CGFloat(index) * 70, dx != 0 ? width : height)
            let alpha = (0.8 - CGFloat(index) * 0.16) * strength
            bolt(context, from: CGPoint(x: startX, y: startY),
                 to: CGPoint(x: startX + dx * length, y: startY + dy * length),
                 jitter: 7, alpha: alpha, width: 1.6 - CGFloat(index) * 0.3,
                 accent: accent)
        }

        drawBadge(context, width: width, height: height, accent: accent, strength: strength)
    }

    /// Walk the rectangle clockwise from the top-left, returning point + heading.
    private func rimPoint(distance: CGFloat, width: CGFloat, height: CGFloat) -> (CGFloat, CGFloat, CGFloat, CGFloat) {
        let perimeter = 2 * (width + height)
        var d = distance.truncatingRemainder(dividingBy: perimeter)
        if d < 0 { d += perimeter }
        if d < width { return (d, height, 1, 0) }
        if d < width + height { return (width, height - (d - width), 0, -1) }
        if d < 2 * width + height { return (width - (d - width - height), 0, -1, 0) }
        return (0, d - 2 * width - height, 0, 1)
    }

    private func bolt(_ context: CGContext, from: CGPoint, to: CGPoint, jitter: CGFloat, alpha: CGFloat,
                      width: CGFloat, accent: (CGFloat, CGFloat, CGFloat)) {
        let steps = 14
        context.saveGState()
        context.setShadow(offset: .zero, blur: 16,
                          color: CGColor(red: accent.0, green: accent.1, blue: accent.2, alpha: alpha))
        context.setStrokeColor(CGColor(red: 0.59, green: 0.80, blue: 1.0, alpha: alpha))
        context.setLineWidth(width)
        context.setLineCap(.round)
        context.beginPath()
        context.move(to: from)
        for step in 1...steps {
            let ratio = CGFloat(step) / CGFloat(steps)
            let wobble = (CGFloat.random(in: -0.5...0.5)) * jitter * sin(ratio * .pi)
            context.addLine(to: CGPoint(x: from.x + (to.x - from.x) * ratio + wobble,
                                        y: from.y + (to.y - from.y) * ratio + wobble))
        }
        context.strokePath()
        context.restoreGState()
    }

    private func drawBadge(_ context: CGContext, width: CGFloat, height: CGFloat, accent: (CGFloat, CGFloat, CGFloat), strength: CGFloat) {
        let text = state.stopping ? "已停止操控" : state.label
        let hint = state.stopping ? "" : " · ⌘. 停止"
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        let font = NSFont.systemFont(ofSize: 12, weight: .medium)
        let hintFont = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        let line = NSMutableAttributedString(string: "⌁ ", attributes: [
            .font: NSFont.systemFont(ofSize: 13, weight: .bold),
            .foregroundColor: NSColor(calibratedRed: accent.0, green: accent.1, blue: accent.2, alpha: 0.95 * strength),
        ])
        line.append(NSAttributedString(string: text, attributes: [
            .font: font,
            .foregroundColor: NSColor(calibratedRed: 0.81, green: 0.89, blue: 1.0, alpha: 0.95 * strength),
        ]))
        if !hint.isEmpty {
            line.append(NSAttributedString(string: hint, attributes: [
                .font: hintFont,
                .foregroundColor: NSColor(calibratedRed: 0.56, green: 0.72, blue: 1.0, alpha: 0.85 * strength),
            ]))
        }
        line.addAttribute(.paragraphStyle, value: paragraph, range: NSRange(location: 0, length: line.length))
        let size = line.size()
        let padding = NSSize(width: 12, height: 6)
        let box = NSRect(x: (width - size.width) / 2 - padding.width,
                         y: height - size.height - 2 * padding.height - 4,
                         width: size.width + 2 * padding.width,
                         height: size.height + 2 * padding.height)
        let path = NSBezierPath(roundedRect: box, xRadius: box.height / 2, yRadius: box.height / 2)
        NSColor(calibratedRed: 0.04, green: 0.07, blue: 0.13, alpha: 0.92 * strength).setFill()
        path.fill()
        NSColor(calibratedRed: accent.0, green: accent.1, blue: accent.2, alpha: 0.55 * strength).setStroke()
        path.lineWidth = 1
        path.stroke()
        line.draw(with: NSRect(x: box.minX + padding.width,
                              y: box.minY + padding.height,
                              width: size.width,
                              height: size.height),
                  options: [.usesLineFragmentOrigin])
    }
}

final class OverlayWindow: NSWindow {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

// MARK: - App wiring

final class Controller: NSObject, NSApplicationDelegate {
    var windows: [NSWindow] = []
    var timer: Timer?
    var parentWatch: Timer?
    var watchdog: Timer?
    var monitor: Any?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        buildWindows()
        // 30fps is enough for a rim and cheap enough to leave running for hours.
        let animation = Timer(timeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
            self?.tick()
        }
        RunLoop.main.add(animation, forMode: .common)
        timer = animation

        // ⌘. is the same abort key as the desktop app. A global monitor only
        // observes (it never swallows the key), which is what we want: the app
        // in front still gets its own shortcut handling.
        monitor = NSEvent.addGlobalMonitorForEvents(matching: [.keyDown]) { event in
            guard event.modifierFlags.contains(.command) else { return }
            guard event.charactersIgnoringModifiers == "." else { return }
            state.requestStop()
        }

        // The backend dies with its terminal; this overlay must not outlive it.
        if let pid = options.parentPid {
            parentWatch = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { _ in
                if kill(pid, 0) != 0 { Controller.finish() }
            }
        }
        if options.timeout > 0 {
            watchdog = Timer.scheduledTimer(withTimeInterval: options.timeout, repeats: false) { _ in
                state.requestStop()
            }
        }
        print("ready")
        fflush(stdout)
    }

    private func buildWindows() {
        for screen in NSScreen.screens {
            let window = OverlayWindow(contentRect: screen.frame, styleMask: [.borderless], backing: .buffered, defer: false)
            window.backgroundColor = .clear
            window.isOpaque = false
            window.hasShadow = false
            window.ignoresMouseEvents = true
            window.isMovable = false
            window.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.screenSaverWindow)))
            window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
            window.contentView = RimView(frame: NSRect(origin: .zero, size: screen.frame.size))
            // orderFrontRegardless keeps focus where the human put it.
            window.orderFrontRegardless()
            windows.append(window)
        }
    }

    private func tick() {
        for window in windows { window.contentView?.needsDisplay = true }
        if state.stopping, Date().timeIntervalSince(state.stopStarted) > 0.7 { Controller.finish() }
    }

    static func finish() {
        for window in NSApp.windows { window.orderOut(nil) }
        exit(0)
    }
}

// SIGTERM/SIGINT mean "the backend closed the session", and a dead backend is
// not a human abort: exit without touching the stop flag, otherwise a session
// that ends normally would leave a flag that aborts the next one.
SignalHandler.install()
enum SignalHandler {
    static func install() {
        for signalNumber in [SIGTERM, SIGINT, SIGHUP] {
            signal(signalNumber) { _ in exit(0) }
        }
    }
}

let application = NSApplication.shared
let controller = Controller()
application.delegate = controller
application.run()
