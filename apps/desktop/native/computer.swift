// luban computer helper — the only place that injects OS input.
//
// It speaks one JSON object per line on stdin and answers one JSON object per
// line on stdout, so the Node side never has to quote text into argv (Chinese
// text, quotes and newlines all pass through untouched).
//
//   {"action":"check"}
//   {"action":"screenshot","path":"/tmp/a.png","region":{"x":0,"y":0,"width":800,"height":600}}
//   {"action":"cursor"}
//   {"action":"move","x":100,"y":200}
//   {"action":"click","x":100,"y":200,"button":"left","count":2}
//   {"action":"drag","from":{"x":10,"y":10},"to":{"x":300,"y":260}}
//   {"action":"scroll","dy":-400,"dx":0,"x":100,"y":100}
//   {"action":"type","text":"你好，世界"}
//   {"action":"key","key":"c","modifiers":["cmd","shift"]}
//   {"action":"open","url":"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"}
//
// Every answer is {"ok":true,…} or {"ok":false,"error":"…"}.
//
// Build: swiftc -O computer.swift -o luban-computer

import Foundation
import CoreGraphics
import ApplicationServices
import AppKit

// MARK: - Errors

// MARK: - Emit

func emit(_ payload: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func emitError(_ message: String) -> Never {
    emit(["ok": false, "error": message])
    exit(0)
}

// MARK: - Permission probes

/// True when this binary may synthesize events for other applications.
func accessibilityTrusted(prompt: Bool) -> Bool {
    if prompt {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }
    return AXIsProcessTrusted()
}

/// macOS 15 obsoleted CGDisplayCreateImage, so capture goes through the system
/// `screencapture`, which is also what carries the Screen Recording permission of
/// the process that spawned us. A 1×1 probe tells us whether it is granted.
@discardableResult
func runScreencapture(_ arguments: [String]) -> Bool {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    process.arguments = arguments
    process.standardError = FileHandle.nullDevice
    process.standardOutput = FileHandle.nullDevice
    do { try process.run() } catch { return false }
    process.waitUntilExit()
    return process.terminationStatus == 0
}

func screenCaptureAvailable() -> Bool {
    let probe = NSTemporaryDirectory() + "luban-screen-probe-\(getpid()).png"
    defer { try? FileManager.default.removeItem(atPath: probe) }
    guard runScreencapture(["-x", "-R", "0,0,1,1", probe]) else { return false }
    let size = (try? FileManager.default.attributesOfItem(atPath: probe))?[.size] as? Int ?? 0
    return size > 8
}

// MARK: - Pointer helpers

func point(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: x, y: y) }

func post(_ event: CGEvent?) {
    event?.post(tap: .cghidEventTap)
}

func mouseButton(_ name: String?) -> (CGMouseButton, CGEventType, CGEventType) {
    switch (name ?? "left").lowercased() {
    case "right": return (.right, .rightMouseDown, .rightMouseUp)
    case "middle", "center": return (.center, .otherMouseDown, .otherMouseUp)
    default: return (.left, .leftMouseDown, .leftMouseUp)
    }
}

/// Move the pointer exactly.
///
/// Warp first: `CGWarpMouseCursorPosition` needs no TCC grant, so a helper whose
/// Accessibility grant is still pending can still put the cursor where the model
/// asked. The mouseMoved event afterwards is what makes windows react (hover,
/// cursor shapes); when posting is denied it simply does nothing.
func relocate(_ to: CGPoint) {
    if CGEvent(source: nil)?.location != to {
        CGWarpMouseCursorPosition(to)
        CGAssociateMouseAndMouseCursorPosition(1)
    }
    post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: to, mouseButton: .left))
}

/// True when the OS will accept synthetic clicks and keystrokes from us.
func postEventAllowed() -> Bool {
    if #available(macOS 10.15, *) { return CGPreflightPostEventAccess() }
    return accessibilityTrusted(prompt: false)
}

func click(at to: CGPoint, button: String?, count: Int) {
    let (cgButton, down, up) = mouseButton(button)
    relocate(to)
    usleep(20_000)
    for index in 0..<max(1, count) {
        let downEvent = CGEvent(mouseEventSource: nil, mouseType: down, mouseCursorPosition: to, mouseButton: cgButton)
        // The click counter is what makes a double click a double click for AppKit.
        downEvent?.setIntegerValueField(.mouseEventClickState, value: Int64(index + 1))
        post(downEvent)
        usleep(15_000)
        let upEvent = CGEvent(mouseEventSource: nil, mouseType: up, mouseCursorPosition: to, mouseButton: cgButton)
        upEvent?.setIntegerValueField(.mouseEventClickState, value: Int64(index + 1))
        post(upEvent)
        if index + 1 < max(1, count) { usleep(60_000) }
    }
}

// MARK: - Keyboard

/// Virtual keycodes are layout independent; characters go through setUnicodeString.
let namedKeys: [String: CGKeyCode] = [
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
    "escape": 53, "esc": 53, "left": 123, "right": 124, "down": 125, "up": 126,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "forwarddelete": 117,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
    "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
    "3": 20, "4": 21, "6": 22, "5": 23, "equal": 24, "9": 25, "7": 26, "minus": 27,
    "8": 28, "0": 29, "rightbracket": 30, "o": 31, "u": 32, "leftbracket": 33, "i": 34,
    "p": 35, "l": 37, "j": 38, "quote": 39, "k": 40, "semicolon": 41, "backslash": 42,
    "comma": 43, "slash": 44, "n": 45, "m": 46, "period": 47, "grave": 50,
]

func modifierFlags(_ names: [String]) -> CGEventFlags {
    var flags: CGEventFlags = []
    for raw in names {
        switch raw.lowercased() {
        case "cmd", "command", "meta": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "alt", "option", "opt": flags.insert(.maskAlternate)
        case "ctrl", "control": flags.insert(.maskControl)
        case "fn": flags.insert(.maskSecondaryFn)
        case "capslock", "caps": flags.insert(.maskAlphaShift)
        default: break
        }
    }
    return flags
}

func pressKey(_ name: String, modifiers: [String]) {
    let key = name.lowercased()
    let flags = modifierFlags(modifiers)
    guard let code = namedKeys[key] else {
        // A single character with no named code: type it with the modifiers held.
        if key.count == 1, let scalar = key.unicodeScalars.first {
            let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
            down?.flags = flags
            var chars = [UniChar](repeating: 0, count: 1)
            chars[0] = UniChar(scalar.value)
            down?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &chars)
            post(down)
            let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
            up?.flags = flags
            up?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &chars)
            post(up)
            return
        }
        emitError("unknown key: \(name)")
    }
    let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)
    down?.flags = flags
    post(down)
    usleep(8_000)
    let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
    up?.flags = flags
    post(up)
}

func typeText(_ text: String) {
    // Chunk on grapheme clusters so surrogate pairs stay intact; each event
    // carries one string, which is faster than a keycode round trip per char.
    let chunkSize = 24
    let scalars = Array(text.utf16)
    var index = 0
    while index < scalars.count {
        let end = min(index + chunkSize, scalars.count)
        var chunk = Array(scalars[index..<end])
        let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
        down?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: &chunk)
        post(down)
        let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
        up?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: &chunk)
        post(up)
        index = end
        usleep(6_000)
    }
}

// MARK: - Screenshot

func capture(path: String, region: [String: Any]?) {
    var arguments = ["-x", "-o"]
    if let region, let x = region["x"] as? Double, let y = region["y"] as? Double,
       let width = region["width"] as? Double, let height = region["height"] as? Double {
        // -R takes points in the display's top-left coordinate space.
        arguments += ["-R", "\(Int(x)),\(Int(y)),\(max(1, Int(width))),\(max(1, Int(height)))"]
    }
    arguments.append(path)
    guard runScreencapture(arguments), FileManager.default.fileExists(atPath: path) else {
        emitError("screen capture unavailable; grant Screen Recording to luban in System Settings › Privacy & Security › Screen Recording")
    }
    let size = (try? FileManager.default.attributesOfItem(atPath: path))?[.size] as? Int ?? 0
    emit(["ok": true, "path": path, "bytes": size])
}

// MARK: - Dispatch

func run(_ request: [String: Any]) {
    let action = (request["action"] as? String ?? "").lowercased()
    switch action {
    case "check":
        let trusted = accessibilityTrusted(prompt: request["prompt"] as? Bool ?? false)
        emit(["ok": true, "accessibility": trusted, "postEvent": postEventAllowed(),
              "screenRecording": screenCaptureAvailable(),
              "displayScale": NSScreen.main?.backingScaleFactor ?? 1])
    case "trust":
        _ = accessibilityTrusted(prompt: true)
        emit(["ok": true])
    case "trusted":
        emit(["ok": true, "accessibility": accessibilityTrusted(prompt: false)])
    case "open":
        guard let raw = request["url"] as? String, let url = URL(string: raw) else { emitError("bad url") }
        NSWorkspace.shared.open(url)
        emit(["ok": true])
    case "cursor":
        let location = CGEvent(source: nil)?.location ?? .zero
        emit(["ok": true, "x": location.x, "y": location.y])
    case "screenshot":
        guard let path = request["path"] as? String else { emitError("path required") }
        capture(path: path, region: request["region"] as? [String: Any])
    case "move":
        guard let x = request["x"] as? Double, let y = request["y"] as? Double else { emitError("x and y required") }
        relocate(point(x, y))
        emit(["ok": true])
    case "click", "doubleclick", "rightclick":
        guard let x = request["x"] as? Double, let y = request["y"] as? Double else { emitError("x and y required") }
        let button = request["button"] as? String ?? (action == "rightclick" ? "right" : "left")
        let count = action == "doubleclick" ? 2 : Int(request["count"] as? Double ?? 1)
        click(at: point(x, y), button: button, count: count)
        emit(["ok": true])
    case "drag":
        guard let from = request["from"] as? [String: Any], let to = request["to"] as? [String: Any],
              let fx = from["x"] as? Double, let fy = from["y"] as? Double,
              let tx = to["x"] as? Double, let ty = to["y"] as? Double else { emitError("from/to required") }
        let start = point(fx, fy)
        relocate(start)
        usleep(40_000)
        post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: start, mouseButton: .left))
        let steps = 18
        for step in 1...steps {
            let ratio = Double(step) / Double(steps)
            let mid = point(fx + (tx - fx) * ratio, fy + (ty - fy) * ratio)
            post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: mid, mouseButton: .left))
            usleep(12_000)
        }
        post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point(tx, ty), mouseButton: .left))
        emit(["ok": true])
    case "scroll":
        let dy = Int32(request["dy"] as? Double ?? 0)
        let dx = Int32(request["dx"] as? Double ?? 0)
        if let x = request["x"] as? Double, let y = request["y"] as? Double { relocate(point(x, y)) }
        let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)
        post(event)
        emit(["ok": true])
    case "type":
        guard let text = request["text"] as? String else { emitError("text required") }
        typeText(text)
        emit(["ok": true])
    case "key":
        guard let key = request["key"] as? String else { emitError("key required") }
        pressKey(key, modifiers: request["modifiers"] as? [String] ?? [])
        emit(["ok": true])
    default:
        emitError("unknown action: \(action)")
    }
}

// MARK: - Main loop

setvbuf(stdout, nil, _IOLBF, 0)
while let line = readLine(strippingNewline: true) {
    if line.isEmpty { continue }
    guard let data = line.data(using: .utf8),
          let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
        emitError("invalid JSON request")
    }
    run(request)
}
