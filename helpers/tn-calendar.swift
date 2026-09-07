// tn-calendar — reads the user's calendars through EventKit and prints JSON.
//
// Why a compiled helper instead of AppleScript: driving Calendar.app over Apple
// events takes ~11s for a one-week window even when it returns nothing, which is
// far too slow to sit behind an HTTP request. EventKit answers the same query in
// milliseconds and does not require Calendar.app to be running.
//
//   tn-calendar --list
//   tn-calendar --from 2026-09-07 --to 2026-09-14 [--ids A,B]
//
// Read-only by design: nothing here mutates a calendar.

import Foundation
import EventKit

let store = EKEventStore()

func fail(_ message: String, _ code: Int32 = 1) -> Never {
    let payload: [String: Any] = ["error": message]
    if let data = try? JSONSerialization.data(withJSONObject: payload),
       let text = String(data: data, encoding: .utf8) {
        print(text)
    }
    exit(code)
}

/// EventKit access is asynchronous and the modern call is only on macOS 14+, so
/// this bridges both to a blocking result the CLI can act on.
func requestAccess() -> Bool {
    let sem = DispatchSemaphore(value: 0)
    var granted = false
    if #available(macOS 14.0, *) {
        store.requestFullAccessToEvents { ok, _ in granted = ok; sem.signal() }
    } else {
        store.requestAccess(to: .event) { ok, _ in granted = ok; sem.signal() }
    }
    // A denied prompt still calls back; a hung one should not wedge the server.
    _ = sem.wait(timeout: .now() + 20)
    return granted
}

func isoDay(_ s: String) -> Date? {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd"
    f.timeZone = TimeZone.current
    return f.date(from: s)
}

func iso(_ d: Date) -> String {
    let f = ISO8601DateFormatter()
    f.timeZone = TimeZone.current
    f.formatOptions = [.withInternetDateTime]
    return f.string(from: d)
}

func hexColor(_ cg: CGColor?) -> String {
    guard let c = cg, let comps = c.components, comps.count >= 3 else { return "" }
    let r = Int((comps[0] * 255).rounded()), g = Int((comps[1] * 255).rounded()), b = Int((comps[2] * 255).rounded())
    return String(format: "#%02x%02x%02x", max(0, min(255, r)), max(0, min(255, g)), max(0, min(255, b)))
}

func emit(_ obj: Any) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj),
          let text = String(data: data, encoding: .utf8) else { fail("could not encode result") }
    print(text)
}

// ---- argument parsing ----
var args: [String: String] = [:]
var flags: Set<String> = []
var i = 1
let argv = CommandLine.arguments
while i < argv.count {
    let a = argv[i]
    if a.hasPrefix("--") {
        let key = String(a.dropFirst(2))
        if i + 1 < argv.count && !argv[i + 1].hasPrefix("--") { args[key] = argv[i + 1]; i += 2 }
        else { flags.insert(key); i += 1 }
    } else { i += 1 }
}

// Report the authorisation state without prompting, so the app can explain
// itself before macOS shows a dialog.
if flags.contains("status") {
    let s = EKEventStore.authorizationStatus(for: .event)
    let name: String
    switch s {
    case .notDetermined: name = "notDetermined"
    case .restricted: name = "restricted"
    case .denied: name = "denied"
    case .fullAccess: name = "authorized"
    case .writeOnly: name = "writeOnly"
    case .authorized: name = "authorized"
    @unknown default: name = "unknown"
    }
    emit(["status": name])
    exit(0)
}

guard requestAccess() else { fail("calendar access not granted", 2) }

if flags.contains("list") {
    let cals = store.calendars(for: .event).map { c -> [String: Any] in
        [
            "id": c.calendarIdentifier,
            "title": c.title,
            "color": hexColor(c.cgColor),
            "source": c.source?.title ?? "",
            "type": {
                switch c.source?.sourceType {
                case .some(.local): return "local"
                case .some(.exchange): return "exchange"
                case .some(.calDAV): return "caldav"
                case .some(.subscribed): return "subscribed"
                case .some(.birthdays): return "birthdays"
                default: return "other"
                }
            }(),
            "allowsModify": c.allowsContentModifications,
        ]
    }
    emit(["calendars": cals])
    exit(0)
}

guard let fromStr = args["from"], let toStr = args["to"],
      let from = isoDay(fromStr), let toDay = isoDay(toStr) else {
    fail("--from and --to are required as yyyy-MM-dd")
}
// `to` is inclusive of that whole day.
let to = Calendar.current.date(byAdding: .day, value: 1, to: toDay) ?? toDay

var calendars: [EKCalendar]? = nil
if let ids = args["ids"], !ids.isEmpty {
    let wanted = Set(ids.split(separator: ",").map(String.init))
    calendars = store.calendars(for: .event).filter { wanted.contains($0.calendarIdentifier) }
}

let predicate = store.predicateForEvents(withStart: from, end: to, calendars: calendars)
let events = store.events(matching: predicate).sorted { ($0.startDate ?? .distantPast) < ($1.startDate ?? .distantPast) }

let out = events.map { e -> [String: Any] in
    // Declined invitations are noise on an agenda, so mark them and let the
    // caller decide.
    var declined = false
    if let me = e.attendees?.first(where: { $0.isCurrentUser }) {
        declined = me.participantStatus == .declined
    }
    return [
        "id": e.eventIdentifier ?? "",
        "title": e.title ?? "(untitled)",
        "start": iso(e.startDate ?? Date()),
        "end": iso(e.endDate ?? Date()),
        "allDay": e.isAllDay,
        "location": e.location ?? "",
        "notes": String((e.notes ?? "").prefix(400)),
        "url": e.url?.absoluteString ?? "",
        "calendar": e.calendar?.title ?? "",
        "calendarId": e.calendar?.calendarIdentifier ?? "",
        "color": hexColor(e.calendar?.cgColor),
        "organizer": e.organizer?.name ?? "",
        "attendees": e.attendees?.count ?? 0,
        "declined": declined,
        "status": {
            switch e.status {
            case .confirmed: return "confirmed"
            case .tentative: return "tentative"
            case .canceled: return "canceled"
            default: return "none"
            }
        }(),
    ]
}
emit(["events": out])
