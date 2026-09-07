// tn-calendar — reads the user's calendars through EventKit and prints JSON.
//
// Why a compiled helper instead of AppleScript: driving Calendar.app over Apple
// events takes ~11s for a one-week window even when it returns nothing, which is
// far too slow to sit behind an HTTP request. EventKit answers the same query in
// milliseconds and does not require Calendar.app to be running.
//
//   tn-calendar --list
//   tn-calendar --from 2026-09-07 --to 2026-09-14 [--ids A,B]
//   tn-calendar --create --title T --start ISO --end ISO [--calendar ID]
//                        [--location L] [--notes N] [--all-day]
//   tn-calendar --update --event ID [--title T] [--start ISO] [--end ISO]
//                        [--location L] [--notes N]
//   tn-calendar --delete --event ID
//
// Writes go to the calendar the OS already syncs, so an event created here
// reaches Google (or wherever the calendar lives) without this app holding any
// credentials of its own.

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

/// EventKit access is asynchronous and the modern calls are only on macOS 14+,
/// so this bridges them to a blocking result the CLI can act on.
///
/// Reading needs full access. *Adding* an event does not — macOS has a separate
/// "Add Events Only" grant — so a write asks only for what it needs. Someone who
/// granted add-only can still create events here even though the agenda cannot
/// be read.
func requestAccess(writeOnly: Bool = false) -> Bool {
    let sem = DispatchSemaphore(value: 0)
    var granted = false
    if #available(macOS 14.0, *) {
        if writeOnly {
            // Full access also satisfies a write, so don't downgrade someone
            // who already granted it.
            if EKEventStore.authorizationStatus(for: .event) == .fullAccess { return true }
            store.requestWriteOnlyAccessToEvents { ok, _ in granted = ok; sem.signal() }
        } else {
            store.requestFullAccessToEvents { ok, _ in granted = ok; sem.signal() }
        }
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

/// Accepts the ISO-8601 the frontend sends, and is deliberately lenient about
/// a missing timezone offset: ISO8601DateFormatter *requires* one, so a plain
/// "2026-09-07T18:00:00" would silently fail to parse. Anything without an
/// offset is read as local time, which is what a hand-written time means.
func parseISO(_ s: String) -> Date? {
    let iso = ISO8601DateFormatter()
    iso.timeZone = TimeZone.current
    for opts in [[.withInternetDateTime, .withFractionalSeconds] as ISO8601DateFormatter.Options,
                 [.withInternetDateTime]] {
        iso.formatOptions = opts
        if let d = iso.date(from: s) { return d }
    }
    for pattern in ["yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd HH:mm", "yyyy-MM-dd"] {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone.current
        f.dateFormat = pattern
        if let d = f.date(from: s) { return d }
    }
    return nil
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

// A bare create only needs add-only; everything else has to read.
let needsWriteOnly = flags.contains("create") && !flags.contains("update") && !flags.contains("delete")
guard requestAccess(writeOnly: needsWriteOnly) else { fail("calendar access not granted", 2) }

// ---- write commands -------------------------------------------------------
// Grouped before the read path so a create/update/delete never depends on the
// range arguments.

func calendarFor(_ id: String?) -> EKCalendar? {
    if let id = id, !id.isEmpty {
        return store.calendars(for: .event).first { $0.calendarIdentifier == id }
    }
    // No explicit target: the calendar the OS considers default for new events.
    return store.defaultCalendarForNewEvents
}

func applyFields(_ event: EKEvent) {
    if let t = args["title"] { event.title = t }
    if let l = args["location"] { event.location = l }
    if let n = args["notes"] { event.notes = n }
    if flags.contains("all-day") { event.isAllDay = true }
    if let s = args["start"], let d = parseISO(s) { event.startDate = d }
    if let e = args["end"], let d = parseISO(e) { event.endDate = d }
}

if flags.contains("create") {
    guard let title = args["title"], !title.isEmpty else { fail("--title is required") }
    guard let cal = calendarFor(args["calendar"]) else { fail("no writable calendar found") }
    guard cal.allowsContentModifications else { fail("that calendar is read-only") }
    let event = EKEvent(eventStore: store)
    event.calendar = cal
    event.title = title
    // Sensible default so a bare create still produces a valid event.
    let start = args["start"].flatMap(parseISO) ?? Date()
    event.startDate = start
    event.endDate = args["end"].flatMap(parseISO) ?? start.addingTimeInterval(30 * 60)
    applyFields(event)
    if event.endDate <= event.startDate { fail("end must be after start") }
    do {
        try store.save(event, span: .thisEvent, commit: true)
        emit(["ok": true, "id": event.eventIdentifier ?? "", "calendar": cal.title])
    } catch { fail("could not save: \(error.localizedDescription)") }
    exit(0)
}

// Every occurrence of a recurring event shares one eventIdentifier, and
// event(withIdentifier:) hands back the *first* one. Editing or deleting
// "Wednesday's standup" that way would silently change Monday's. So when the
// caller says which occurrence it means, the matching instance is looked up by
// its start date instead.
func findEvent(_ id: String, occurrence: String?) -> EKEvent? {
    if let occ = occurrence, !occ.isEmpty, let want = parseISO(occ) {
        let pred = store.predicateForEvents(withStart: want.addingTimeInterval(-86400),
                                            end: want.addingTimeInterval(86400), calendars: nil)
        let hit = store.events(matching: pred).first {
            $0.eventIdentifier == id && abs(($0.startDate ?? .distantPast).timeIntervalSince(want)) < 60
        }
        if let hit = hit { return hit }
    }
    return store.event(withIdentifier: id)
}

if flags.contains("update") || flags.contains("delete") {
    guard let id = args["event"], !id.isEmpty else { fail("--event is required") }
    // Finding an existing event needs read access, so this is the one place a
    // write also depends on full access rather than write-only.
    guard let event = findEvent(id, occurrence: args["occurrence"]) else { fail("event not found", 3) }
    guard event.calendar?.allowsContentModifications ?? false else { fail("that calendar is read-only") }
    if flags.contains("delete") {
        do {
            try store.remove(event, span: .thisEvent, commit: true)
            emit(["ok": true, "deleted": id])
        } catch { fail("could not delete: \(error.localizedDescription)") }
        exit(0)
    }
    applyFields(event)
    if event.endDate <= event.startDate { fail("end must be after start") }
    do {
        try store.save(event, span: .thisEvent, commit: true)
        emit(["ok": true, "id": event.eventIdentifier ?? ""])
    } catch { fail("could not save: \(error.localizedDescription)") }
    exit(0)
}

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
        // Every occurrence of a series shares an id, so the caller needs to
        // know when it is looking at one.
        "recurring": e.hasRecurrenceRules,
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
