//! Input parser vectors. Most come from OpenTUI Core's parse.keypress*.test.ts,
//! parse.mouse.test.ts, and stdin-parser.test.ts (via the opentui-rust port),
//! translated to the native event model (docs/input-parser.md §8):
//! - Native reports characters as sent: Shift+a from Kitty is code 'a' with Shift
//!   and text "A"; a typed `A` is code 'A' without Shift.
//! - Core's linefeed is Enter, clear is KP_BEGIN, Shift+Tab is Tab with Shift.
//! - Focus is an event; unknown sequences are replies, never keys with no name.
//! - Mouse decoding is stateless: motion with a button held is a drag.
const std = @import("std");
const testing = std.testing;
const ip = @import("../input-parser.zig");
const utils = @import("../utils.zig");

const K = ip.key;
const Mods = ip.Modifiers;
const NONE: Mods = .{};
const SHIFT: Mods = .{ .shift = true };
const ALT: Mods = .{ .alt = true };
const CTRL: Mods = .{ .ctrl = true };
const SUPER: Mods = .{ .super = true };
const start_ns: u64 = 1_000_000_000;
const ms: u64 = std.time.ns_per_ms;

fn mods(comptime list: []const Mods) Mods {
    var bits: u8 = 0;
    for (list) |value| bits |= @bitCast(value);
    return @bitCast(bits);
}

/// One event with copied spans. Consecutive paste records are joined (G1).
const Got = struct {
    kind: ip.Kind,
    action: u8,
    mods: u8,
    flags: u8,
    code: u32,
    base: u32,
    x: u16,
    y: u16,
    raw: []const u8,
    text: []const u8,

    fn eql(a: Got, b: Got) bool {
        return a.kind == b.kind and a.action == b.action and a.mods == b.mods and a.flags == b.flags and
            a.code == b.code and a.base == b.base and a.x == b.x and a.y == b.y and
            std.mem.eql(u8, a.raw, b.raw) and std.mem.eql(u8, a.text, b.text);
    }
};

const Expect = struct {
    kind: ip.Kind,
    action: u8 = 0,
    mods: Mods = .{},
    flags: ?u8 = null,
    code: ?u32 = null,
    base: ?u32 = null,
    x: u16 = 0,
    y: u16 = 0,
    raw: ?[]const u8 = null,
    text: ?[]const u8 = null,

    fn matches(e: Expect, g: Got) bool {
        if (e.kind != g.kind or e.action != g.action or @as(u8, @bitCast(e.mods)) != g.mods) return false;
        if (e.flags) |value| if (value != g.flags) return false;
        if (e.code) |value| if (value != g.code) return false;
        if (e.base) |value| if (value != g.base) return false;
        if (e.x != g.x or e.y != g.y) return false;
        if (e.raw) |value| if (!std.mem.eql(u8, value, g.raw)) return false;
        if (e.text) |value| if (!std.mem.eql(u8, value, g.text)) return false;
        return true;
    }
};

fn k(code: u32, modifiers: Mods) Expect {
    return .{ .kind = .key, .action = 1, .code = code, .mods = modifiers };
}

fn ka(code: u32, modifiers: Mods, action: ip.KeyAction) Expect {
    return .{ .kind = .key, .action = @backingInt(action), .code = code, .mods = modifiers };
}

fn kt(code: u32, modifiers: Mods, text: []const u8) Expect {
    return .{ .kind = .key, .action = 1, .code = code, .mods = modifiers, .text = text };
}

fn kr(code: u32, modifiers: Mods, raw: []const u8) Expect {
    return .{ .kind = .key, .action = 1, .code = code, .mods = modifiers, .raw = raw };
}

fn ch(code: u32) Expect {
    return k(code, NONE);
}

fn reply(raw: []const u8) Expect {
    return .{ .kind = .reply, .raw = raw, .flags = 0 };
}

fn frag(raw: []const u8) Expect {
    return .{ .kind = .reply, .raw = raw, .flags = ip.flags.reply_fragment };
}

fn report(raw: []const u8) Expect {
    return .{ .kind = .reply, .raw = raw, .flags = ip.flags.reply_cursor_position };
}

fn mouse(action: ip.MouseAction, button: u32, x: u16, y: u16, modifiers: Mods) Expect {
    return .{ .kind = .mouse, .action = @backingInt(action), .code = button, .x = x, .y = y, .mods = modifiers };
}

fn down(button: u32, x: u16, y: u16) Expect {
    return mouse(.down, button, x, y, NONE);
}

fn paste(text: []const u8) Expect {
    return .{ .kind = .paste, .code = 0, .text = text, .flags = ip.flags.paste_start | ip.flags.paste_end };
}

fn focus(gained: bool) Expect {
    return .{ .kind = .focus, .action = @intFromBool(gained), .code = 0 };
}

const none = ip.mouse_button_none;

/// A parser driven by a manual clock that loops on `consumed` like a host.
const Harness = struct {
    arena: *std.heap.ArenaAllocator,
    parser: *ip.InputParser,
    events: []ip.Event,
    payload: []u8,
    out: std.ArrayList(Got) = .empty,
    now: u64 = start_ns,
    feeds: u32 = 0,

    fn init(capacity: u32, payload_capacity: u32) !Harness {
        const arena = try testing.allocator.create(std.heap.ArenaAllocator);
        errdefer testing.allocator.destroy(arena);
        arena.* = .init(testing.allocator);
        errdefer arena.deinit();
        const allocator = arena.allocator();
        const parser = try allocator.create(ip.InputParser);
        parser.* = .{};
        return .{
            .arena = arena,
            .parser = parser,
            .events = try allocator.alloc(ip.Event, capacity),
            .payload = try allocator.alloc(u8, payload_capacity),
        };
    }

    fn create() !Harness {
        return init(64, 64 * 1024);
    }

    fn deinit(self: *Harness) void {
        self.arena.deinit();
        testing.allocator.destroy(self.arena);
    }

    fn feed(self: *Harness, bytes: []const u8) ![]const Got {
        const first = self.out.items.len;
        var rest = bytes;
        while (true) {
            var sink: ip.Sink = .{ .events = self.events, .payload = self.payload };
            const consumed = self.parser.feed(rest, self.now, &sink);
            self.feeds += 1;
            try self.collect(&sink);
            rest = rest[consumed..];
            if (rest.len == 0) break;
            // An expiry can fill a minimal sink before the first byte.
            try testing.expect(consumed > 0 or sink.count > 0);
        }
        return self.out.items[first..];
    }

    fn wait(self: *Harness, milliseconds: u64) ![]const Got {
        self.now += milliseconds * ms;
        return self.feed("");
    }

    fn collect(self: *Harness, sink: *const ip.Sink) !void {
        const allocator = self.arena.allocator();
        for (sink.events[0..sink.count]) |record| {
            const raw = try allocator.dupe(u8, sink.raw(record));
            const text = sink.text(record);
            if (record.kind == @backingInt(ip.Kind.paste) and self.out.items.len > 0) {
                const last = &self.out.items[self.out.items.len - 1];
                if (last.kind == .paste and last.flags & ip.flags.paste_end == 0) {
                    try testing.expectEqual(@as(u8, 0), record.flags & ip.flags.paste_start);
                    last.text = try std.mem.concat(allocator, u8, &.{ last.text, text });
                    last.flags |= record.flags;
                    continue;
                }
            }
            try self.out.append(allocator, .{
                .kind = @fromBackingInt(@intCast(record.kind)),
                .action = record.action,
                .mods = record.modifiers,
                .flags = record.flags,
                .code = record.code,
                .base = record.base_code,
                .x = record.x,
                .y = record.y,
                .raw = raw,
                .text = try allocator.dupe(u8, text),
            });
        }
    }
};

fn dump(label: []const u8, input: []const u8, got: []const Got) void {
    std.debug.print("{s} for {any}:\n", .{ label, input });
    for (got) |g| std.debug.print("  {t} action={d} mods={d} flags={d} code={d} base={d} xy={d},{d} raw={any} text={any}\n", .{
        g.kind, g.action, g.mods, g.flags, g.code, g.base, g.x, g.y, g.raw, g.text,
    });
}

fn expectGot(input: []const u8, expected: []const Expect, got: []const Got) !void {
    const ok = ok: {
        if (expected.len != got.len) break :ok false;
        for (expected, got) |e, g| if (!e.matches(g)) break :ok false;
        break :ok true;
    };
    if (!ok) {
        dump("unexpected events", input, got);
        std.debug.print("expected:\n", .{});
        for (expected) |e| std.debug.print("  {any}\n", .{e});
        return error.TestUnexpectedResult;
    }
}

/// Parses chunks that all arrive at one moment.
fn split(harness: *Harness, chunks: []const []const u8) ![]const Got {
    const first = harness.out.items.len;
    for (chunks) |chunk| _ = try harness.feed(chunk);
    return harness.out.items[first..];
}

fn check(input: []const u8, expected: []const Expect) !void {
    var harness = try Harness.create();
    defer harness.deinit();
    try expectGot(input, expected, try harness.feed(input));
}

fn checkOne(cases: []const struct { []const u8, Expect }) !void {
    for (cases) |case| try check(case[0], &.{case[1]});
}

/// Feeds `head`, waits 100 ms, and feeds `tail`. The wait reports the first `at_wait` events of
/// `expected`: a unit that timed out. A deferred unit reports nothing until `tail`.
fn checkTimed(expect: ip.Expectations, head: []const u8, at_wait: usize, tail: []const u8, expected: []const Expect) !void {
    var harness = try Harness.create();
    defer harness.deinit();
    harness.parser.setExpectations(expect);
    try expectGot(head, &.{}, try harness.feed(head));
    try expectGot(head, expected[0..at_wait], try harness.wait(100));
    try expectGot(head, expected[at_wait..], try harness.feed(tail));
}

fn gotEql(a: []const Got, b: []const Got) bool {
    if (a.len != b.len) return false;
    for (a, b) |x, y| if (!x.eql(y)) return false;
    return true;
}

/// G1: whole input, byte-at-a-time input, and every two-chunk split parse the same.
fn expectSplitInvariant(stream: []const u8) !void {
    var whole = try Harness.create();
    defer whole.deinit();
    const expected = try whole.feed(stream);
    var bytes = try Harness.create();
    defer bytes.deinit();
    for (0..stream.len) |index| _ = try bytes.feed(stream[index..][0..1]);
    if (!gotEql(expected, bytes.out.items)) {
        dump("whole", stream, expected);
        dump("byte at a time", stream, bytes.out.items);
        return error.TestUnexpectedResult;
    }
    for (1..stream.len) |index| {
        var pair = try Harness.create();
        defer pair.deinit();
        const got = try split(&pair, &.{ stream[0..index], stream[index..] });
        if (!gotEql(expected, got)) {
            std.debug.print("split at {d}\n", .{index});
            dump("whole", stream, expected);
            dump("split", stream, got);
            return error.TestUnexpectedResult;
        }
    }
}

fn x10(code: u8, x: u8, y: u8) [6]u8 {
    return .{ 0x1b, '[', 'M', code + 32, x + 33, y + 33 };
}

// parse.keypress.test.ts

test "input parser text, controls, and Alt prefixes" {
    try checkOne(&.{
        .{ "a", kt('a', NONE, "a") },
        .{ "A", kt('A', NONE, "A") },
        .{ "1", ch('1') },
        .{ "!", ch('!') },
        .{ " ", kt(' ', NONE, " ") },
        .{ "é", kt(0xe9, NONE, "é") },
        .{ "中", ch(0x4e2d) },
        .{ "👍", kt(0x1f44d, NONE, "👍") },
        .{ "\r", kt(K.enter, NONE, "") },
        .{ "\n", kr(K.enter, NONE, "\n") },
        .{ "\t", k(K.tab, NONE) },
        .{ "\x08", k(K.backspace, NONE) },
        .{ "\x7f", k(K.backspace, NONE) },
        .{ "\x01", kt('a', CTRL, "") },
        .{ "\x1a", k('z', CTRL) },
        .{ "\x07", k('g', CTRL) },
        .{ "\x00", k(' ', CTRL) },
        .{ "\x1c", k('\\', CTRL) },
        .{ "\x1d", k(']', CTRL) },
        .{ "\x1e", k('^', CTRL) },
        .{ "\x1f", k('_', CTRL) },
        .{ "\x1b\r", kr(K.enter, ALT, "\x1b\r") },
        .{ "\x1b\n", k(K.enter, ALT) },
        .{ "\x1b ", k(' ', ALT) },
        .{ "\x1ba", Expect{ .kind = .key, .action = 1, .code = 'a', .mods = ALT, .raw = "\x1ba", .text = "" } },
        .{ "\x1bA", k('A', ALT) },
        .{ "\x1bU", k('U', ALT) },
        .{ "\x1b5", k('5', ALT) },
        .{ "\x1b\x7f", k(K.backspace, ALT) },
        .{ "\x1b\x08", k(K.backspace, ALT) },
        .{ "\x1b\x01", k('a', mods(&.{ CTRL, ALT })) },
        .{ "\x1b\x1a", k('z', mods(&.{ CTRL, ALT })) },
        .{ "\x1b\x1c", k('\\', mods(&.{ CTRL, ALT })) },
        .{ "\x1b\x1f", k('_', mods(&.{ CTRL, ALT })) },
        // Terminal.app's old Option+arrow forms; `ESC P` is a DCS introducer.
        .{ "\x1bF", kr(K.right, ALT, "\x1bF") },
        .{ "\x1bB", k(K.left, ALT) },
        // Eight-bit Alt: 0xa0 is 0x80 + ' '.
        .{ "\xa0", kr(' ', ALT, "\xa0") },
        .{ "\xff", k(K.backspace, ALT) },
        .{ "\x9b", k(K.escape, ALT) },
        .{ "\x1b\x9b", kr(K.escape, ALT, "\x1b\x9b") },
        // Issue 046: Alt with any printable ASCII.
        .{ "\x1b.", k('.', ALT) },
        .{ "\x1b/", k('/', ALT) },
        .{ "\x1b<", k('<', ALT) },
        .{ "\x1b!", k('!', ALT) },
        .{ "\x1bN", k('N', ALT) },
        // Issue 047: Alt with any UTF-8 scalar.
        .{ "\x1bé", Expect{ .kind = .key, .action = 1, .code = 0xe9, .mods = ALT, .raw = "\x1bé", .text = "" } },
        .{ "\x1bж", k(0x436, ALT) },
        .{ "\x1b👍", k(0x1f44d, ALT) },
    });
    var letters: [26]u8 = undefined;
    for (&letters, 0..) |*letter, index| letter.* = 'a' + @as(u8, @intCast(index));
    for (letters) |letter| {
        if (letter == 'b' or letter == 'f') continue;
        try check(&.{ 0x1b, letter }, &.{k(letter, ALT)});
    }
    try check("\x1bb\x1bf", &.{ k('b', ALT), k('f', ALT) });
}

test "input parser bytes that are not UTF-8 are eight-bit Alt keys" {
    try check("\xffa", &.{ k(K.backspace, ALT), ch('a') });
    try check("\xe4a", &.{ kr('d', ALT, "\xe4"), ch('a') });
    try check("\xc0A", &.{ k('@', ALT), ch('A') });
    try check("\x9c\x93", &.{ k('\\', mods(&.{ CTRL, ALT })), k('s', mods(&.{ CTRL, ALT })) });
    try check("\xe0\x80\x80", &.{ k('`', ALT), k(' ', mods(&.{ CTRL, ALT })), k(' ', mods(&.{ CTRL, ALT })) });
    // A scalar of each lead range waits for its rest without a deadline (issue 344).
    for ([_][]const u8{ "\u{80}", "\u{7ff}", "\u{800}", "\u{d7ff}", "\u{ff5e}", "\u{10000}", "\u{10ffff}" }) |text| {
        for (1..text.len) |index| for ([_]u64{ 0, 25, std.time.ms_per_s, std.time.ms_per_min }) |pause| {
            var harness = try Harness.create();
            defer harness.deinit();
            try expectGot(text, &.{}, try harness.feed(text[0..index]));
            try testing.expectEqual(null, harness.parser.deadlineNs());
            try expectGot(text, &.{}, try harness.wait(pause));
            const scalar = try std.unicode.utf8Decode(text);
            try expectGot(text, &.{ch(scalar)}, try harness.feed(text[index..]));
        };
    }
    // A byte that cannot continue the scalar ends the wait: the buffered bytes are eight-bit Alt
    // keys, the first with the ESC of an Alt prefix, and the byte parses as usual. A second byte
    // outside its lead's range (overlong, surrogate, above U+10FFFF) cannot continue it either.
    for ([_]struct { []const u8, []const u8, []const Expect }{
        .{ "\xe0", "\x9f", &.{ k('`', ALT), k('_', mods(&.{ CTRL, ALT })) } },
        .{ "\xed", "\xa0", &.{ k('m', ALT), k(' ', ALT) } },
        .{ "\xf0", "\x8f", &.{ k('p', ALT), k('o', mods(&.{ CTRL, ALT })) } },
        .{ "\xf4", "\x90", &.{ k('t', ALT), k('p', mods(&.{ CTRL, ALT })) } },
        .{ "\xe2", "\xc3\xa9", &.{ k('b', ALT), ch(0xe9) } },
        .{ "\xe4\xb8", "a", &.{ k('d', ALT), k('8', ALT), ch('a') } },
        .{ "\xe4", "\x1b[A", &.{ k('d', ALT), k(K.up, NONE) } },
        .{ "\xe4\xb8", "\x1bq", &.{ k('d', ALT), k('8', ALT), k('q', ALT) } },
        .{ "\x1b\xe4", "a", &.{ kr('d', ALT, "\x1b\xe4"), ch('a') } },
        .{ "\x1b\xe2", "\x9c\x93", &.{kr(0x2713, ALT, "\x1b\u{2713}")} },
    }) |case| try checkTimed(.{}, case[0], 0, case[1], case[2]);
}

test "input parser Escape forms resolve by timeout" {
    var harness = try Harness.create();
    defer harness.deinit();
    try expectGot("", &.{}, try harness.feed("\x1b"));
    try testing.expectEqual(harness.now + ip.timeout_ns, harness.parser.deadlineNs().?);
    try expectGot("", &.{}, try harness.wait(19));
    try expectGot("", &.{kr(K.escape, NONE, "\x1b")}, try harness.wait(1));
    try testing.expectEqual(null, harness.parser.deadlineNs());
    // A later batch reports an expired Escape first.
    try expectGot("", &.{}, try harness.feed("\x1b"));
    harness.now += 40 * ms;
    try expectGot("", &.{ k(K.escape, NONE), ch('q') }, try harness.feed("q"));
    // `ESC ESC` is Alt+Escape; a third Escape makes the first a key of its own (issue 044).
    try expectGot("", &.{}, try harness.feed("\x1b\x1b"));
    try expectGot("", &.{kr(K.escape, ALT, "\x1b\x1b")}, try harness.wait(20));
    try expectGot("", &.{kr(K.escape, NONE, "\x1b")}, try harness.feed("\x1b\x1b\x1b"));
    try expectGot("", &.{k(K.escape, ALT)}, try harness.wait(20));
    for (0..3) |_| {
        _ = try harness.feed("\x1b");
        try expectGot("", &.{k(K.escape, NONE)}, try harness.wait(20));
    }
    // The timeout counts from the latest byte.
    _ = try harness.feed("\x1b");
    _ = try harness.wait(5);
    try expectGot("", &.{k(K.up, NONE)}, try harness.feed("[A"));
    try expectGot("", &.{}, try harness.wait(100));
}

test "input parser applies ESC ESC only to key sequences" {
    try check("\x1b\x1b[A", &.{kr(K.up, ALT, "\x1b\x1b[A")});
    try check("\x1b\x1b[1;5A", &.{k(K.up, mods(&.{ CTRL, ALT }))});
    try check("\x1b\x1bOP", &.{k(K.f(1), ALT)});
    // Issue 044: Escape then a mouse report, reply, paste, Alt+a, or a third Escape.
    try check("\x1b\x1ba", &.{ kr(K.escape, NONE, "\x1b"), kr('a', ALT, "\x1ba") });
    try check("\x1b\x1b[<0;1;1M\x1b\x1b[?1u", &.{
        kr(K.escape, NONE, "\x1b"),
        down(0, 0, 0),
        k(K.escape, NONE),
        reply("\x1b[?1u"),
    });
    try check("\x1b\x1b]11;rgb:0/0/0\x07", &.{ k(K.escape, NONE), reply("\x1b]11;rgb:0/0/0\x07") });
    try check("\x1b\x1b[200~x\x1b[201~", &.{ k(K.escape, NONE), paste("x") });
    try check("\x1b\x1b[I", &.{ k(K.escape, NONE), focus(true) });
    try check("\x1b\x1bOz", &.{ k(K.escape, NONE), reply("\x1bOz") });
    try check("\x1b\x1bPx\x1b\\", &.{ k(K.escape, NONE), reply("\x1bPx\x1b\\") });
    try check("\x1b\x1bB", &.{ k(K.escape, NONE), k(K.left, ALT) });
    try check("\x1b\x1b[M !!", &.{ k(K.escape, NONE), down(0, 0, 0) });
    // A cut-short sequence after `ESC ESC` reports the first Escape too.
    try check("\x1b\x1b[1;\x1b[A", &.{ k(K.escape, NONE), frag("\x1b[1;"), k(K.up, NONE) });
    try check("\x1b\x1b[1;\r", &.{ k(K.escape, NONE), frag("\x1b[1;"), k(K.enter, NONE) });
    try check("\x1b\x1b[M \x01", &.{ k(K.escape, NONE), frag("\x1b[M "), k('a', CTRL) });
}

test "input parser legacy navigation, function, and modified keys" {
    try checkOne(&.{
        .{ "\x1bOP", k(K.f(1), NONE) },
        .{ "\x1bOQ", k(K.f(2), NONE) },
        .{ "\x1bOR", k(K.f(3), NONE) },
        .{ "\x1bOS", k(K.f(4), NONE) },
        .{ "\x1b[11~", k(K.f(1), NONE) },
        .{ "\x1b[12~", k(K.f(2), NONE) },
        .{ "\x1b[13~", k(K.f(3), NONE) },
        .{ "\x1b[14~", k(K.f(4), NONE) },
        .{ "\x1b[15~", k(K.f(5), NONE) },
        .{ "\x1b[17~", k(K.f(6), NONE) },
        .{ "\x1b[21~", k(K.f(10), NONE) },
        .{ "\x1b[23~", k(K.f(11), NONE) },
        .{ "\x1b[24~", kt(K.f(12), NONE, "") },
        .{ "\x1b[25~", k(K.f(13), NONE) },
        .{ "\x1b[26~", k(K.f(14), NONE) },
        .{ "\x1b[28~", k(K.f(15), NONE) },
        .{ "\x1b[29~", k(K.menu, NONE) },
        .{ "\x1b[31~", k(K.f(17), NONE) },
        .{ "\x1b[34~", k(K.f(20), NONE) },
        .{ "\x1b[A", kr(K.up, NONE, "\x1b[A") },
        .{ "\x1b[B", k(K.down, NONE) },
        .{ "\x1b[C", k(K.right, NONE) },
        .{ "\x1b[D", k(K.left, NONE) },
        .{ "\x1b[E", k(K.kp_begin, NONE) },
        .{ "\x1b[F", k(K.end, NONE) },
        .{ "\x1b[H", k(K.home, NONE) },
        .{ "\x1b[P", k(K.f(1), NONE) },
        .{ "\x1b[Q", k(K.f(2), NONE) },
        .{ "\x1b[S", k(K.f(4), NONE) },
        .{ "\x1b[1~", k(K.home, NONE) },
        .{ "\x1b[2~", k(K.insert, NONE) },
        .{ "\x1b[3~", k(K.delete, NONE) },
        .{ "\x1b[4~", k(K.end, NONE) },
        .{ "\x1b[5~", k(K.page_up, NONE) },
        .{ "\x1b[6~", k(K.page_down, NONE) },
        .{ "\x1b[7~", k(K.home, NONE) },
        .{ "\x1b[8~", k(K.end, NONE) },
        .{ "\x1b[57427~", k(K.kp_begin, NONE) },
        .{ "\x1bOA", k(K.up, NONE) },
        .{ "\x1bOB", k(K.down, NONE) },
        .{ "\x1bOC", k(K.right, NONE) },
        .{ "\x1bOD", k(K.left, NONE) },
        .{ "\x1bOE", k(K.kp_begin, NONE) },
        .{ "\x1bOF", k(K.end, NONE) },
        .{ "\x1bOH", k(K.home, NONE) },
        .{ "\x1b[Z", kr(K.tab, SHIFT, "\x1b[Z") },
        // Modifier bits: Shift 1, Alt 2, Ctrl 4, Super 8.
        .{ "\x1b[1;2A", k(K.up, SHIFT) },
        .{ "\x1b[1;3A", k(K.up, ALT) },
        .{ "\x1b[1;4A", k(K.up, mods(&.{ SHIFT, ALT })) },
        .{ "\x1b[1;5A", k(K.up, CTRL) },
        .{ "\x1b[1;7A", k(K.up, mods(&.{ CTRL, ALT })) },
        .{ "\x1b[1;8A", k(K.up, mods(&.{ SHIFT, ALT, CTRL })) },
        .{ "\x1b[1;9A", k(K.up, SUPER) },
        .{ "\x1b[1;16A", k(K.up, mods(&.{ SHIFT, ALT, CTRL, SUPER })) },
        .{ "\x1b[5A", k(K.up, CTRL) },
        .{ "\x1b[1;2Q", k(K.f(2), SHIFT) },
        .{ "\x1b[1;2P", k(K.f(1), SHIFT) },
        .{ "\x1b[1;3S", k(K.f(4), ALT) },
        .{ "\x1b[3;2~", k(K.delete, SHIFT) },
        .{ "\x1b[3;3~", k(K.delete, ALT) },
        .{ "\x1b[3;5~", k(K.delete, CTRL) },
        .{ "\x1b[6;5~", k(K.page_down, CTRL) },
        .{ "\x1b[11;9~", k(K.f(1), SUPER) },
        .{ "\x1b[11;6~", k(K.f(1), mods(&.{ SHIFT, CTRL })) },
        // rxvt: lowercase CSI letters and `$` are Shift, lowercase SS3 letters and `^` are Ctrl.
        .{ "\x1b[a", k(K.up, SHIFT) },
        .{ "\x1b[b", k(K.down, SHIFT) },
        .{ "\x1b[c", k(K.right, SHIFT) },
        .{ "\x1b[d", k(K.left, SHIFT) },
        .{ "\x1b[e", k(K.kp_begin, SHIFT) },
        .{ "\x1bOa", k(K.up, CTRL) },
        .{ "\x1bOb", k(K.down, CTRL) },
        .{ "\x1bOc", k(K.right, CTRL) },
        .{ "\x1bOd", k(K.left, CTRL) },
        .{ "\x1b[2$", kr(K.insert, SHIFT, "\x1b[2$") },
        .{ "\x1b[3$", k(K.delete, SHIFT) },
        .{ "\x1b[5$", k(K.page_up, SHIFT) },
        .{ "\x1b[8$", k(K.end, SHIFT) },
        .{ "\x1b[2^", k(K.insert, CTRL) },
        .{ "\x1b[6^", k(K.page_down, CTRL) },
        .{ "\x1b[2@", k(K.insert, mods(&.{ SHIFT, CTRL })) },
        // The Linux console's F1 to F5 and PuTTY's Page Up and Page Down.
        .{ "\x1b[[A", k(K.f(1), NONE) },
        .{ "\x1b[[B", k(K.f(2), NONE) },
        .{ "\x1b[[C", k(K.f(3), NONE) },
        .{ "\x1b[[D", k(K.f(4), NONE) },
        .{ "\x1b[[E", k(K.f(5), NONE) },
        .{ "\x1b[[5~", k(K.page_up, NONE) },
        .{ "\x1b[[6~", k(K.page_down, NONE) },
        .{ "\x1b[[F", reply("\x1b[[F") },
        // The application keypad inserts its characters.
        .{ "\x1bOM", k(K.enter, NONE) },
        .{ "\x1bOp", kt('0', NONE, "0") },
        .{ "\x1bOy", kt('9', NONE, "9") },
        .{ "\x1bOj", kt('*', NONE, "*") },
        .{ "\x1bOk", kt('+', NONE, "+") },
        .{ "\x1bOl", kt(',', NONE, ",") },
        .{ "\x1bOm", kt('-', NONE, "-") },
        .{ "\x1bOn", kt('.', NONE, ".") },
        .{ "\x1bOo", kt('/', NONE, "/") },
        .{ "\x1bOX", kt('=', NONE, "=") },
        .{ "\x1bO5A", k(K.up, CTRL) },
        .{ "\x1bOz", reply("\x1bOz") },
        .{ "\x1bO;A", reply("\x1bO;A") },
    });
    for ([_]struct { u8, Mods }{
        .{ '2', SHIFT },                   .{ '3', ALT },                   .{ '4', mods(&.{ SHIFT, ALT }) }, .{ '5', CTRL },
        .{ '6', mods(&.{ SHIFT, CTRL }) }, .{ '7', mods(&.{ ALT, CTRL }) },
    }) |modifier| {
        for ([_]struct { u8, u32 }{ .{ 'A', K.up }, .{ 'B', K.down }, .{ 'C', K.right }, .{ 'D', K.left } }) |arrow| {
            try check(&.{ 0x1b, '[', '1', ';', modifier[0], arrow[0] }, &.{k(arrow[1], modifier[1])});
        }
    }
}

test "input parser modifyOtherKeys" {
    try checkOne(&.{
        .{ "\x1b[27;2;49~", kt('1', SHIFT, "1") },
        .{ "\x1b[27;2;13~", k(K.enter, SHIFT) },
        .{ "\x1b[27;5;13~", Expect{ .kind = .key, .action = 1, .code = K.enter, .mods = CTRL, .flags = 0 } },
        .{ "\x1b[27;3;13~", k(K.enter, ALT) },
        .{ "\x1b[27;8;13~", k(K.enter, mods(&.{ SHIFT, CTRL, ALT })) },
        .{ "\x1b[27;5;27~", k(K.escape, CTRL) },
        .{ "\x1b[27;6;27~", k(K.escape, mods(&.{ SHIFT, CTRL })) },
        .{ "\x1b[27;5;9~", k(K.tab, CTRL) },
        .{ "\x1b[27;2;9~", k(K.tab, SHIFT) },
        .{ "\x1b[27;5;32~", k(' ', CTRL) },
        .{ "\x1b[27;2;127~", k(K.backspace, SHIFT) },
        .{ "\x1b[27;5;8~", k(K.backspace, CTRL) },
        .{ "\x1b[27;2;53~", k('5', SHIFT) },
        .{ "\x1b[27;5;57399~", kt(K.kp_0, CTRL, "0") },
        .{ "\x1b[27;5;3~", reply("\x1b[27;5;3~") },
        .{ "\x1b[27;5~", reply("\x1b[27;5~") },
    });
}

test "input parser replies, focus, and mouse reports are not keys" {
    for ([_][]const u8{
        "\x1b[4;1782;3012t",    "\x1b[8;24;80t",                    "\x1b[?1;2c",                     "\x1b[?62;c",
        "\x1b[?1;0;6;9;15c",    "\x1b[?1;2$y",                      "\x1b[?25;1$y",                   "\x1b[>41;1;0c",
        "\x1b[?2026;2$y",       "\x1b]11;rgb:0000/0000/0000\x1b\\", "\x1b]10;rgb:ffff/ffff/ffff\x07", "\x1bP>|kitty(0.40)\x1b\\",
        "\x1b_Gi=1;OK\x1b\\",   "\x1b[201~",                        "\x1b[h",                         "\x1b[?997;1n",
        "\x1b[1R",              "\x1b[1;1:1R",                      "\x1b[<0M",                       "\x1b[?1u",
        "\x1b]4;0;#ffffff\x07", "\x1bP1+r4d73=1b5b\x1b\\",          "\x1b[=1c",                       "\x1b[1 q",
        "\x1b[\x80A",
    }) |bytes| {
        try check(bytes, &.{reply(bytes)});
        var with_q: [64]u8 = undefined;
        @memcpy(with_q[0..bytes.len], bytes);
        with_q[bytes.len] = 'q';
        try check(with_q[0 .. bytes.len + 1], &.{ reply(bytes), ch('q') });
    }
    try check("\x1b[I\x1b[O", &.{ focus(true), focus(false) });
    try check("a\x1b[Ib\x1b[Oc", &.{ ch('a'), focus(true), ch('b'), focus(false), ch('c') });
    // Reply protocols.
    try check("\x1b[?1u", &.{Expect{ .kind = .reply, .code = @backingInt(ip.Protocol.csi), .flags = 0 }});
    try check("\x1bOz", &.{Expect{ .kind = .reply, .code = @backingInt(ip.Protocol.ss3), .flags = 0 }});
    try check("\x1b]1\x07", &.{Expect{ .kind = .reply, .code = @backingInt(ip.Protocol.osc), .flags = 0 }});
    try check("\x1bP1\x1b\\", &.{Expect{ .kind = .reply, .code = @backingInt(ip.Protocol.dcs), .flags = 0 }});
    try check("\x1b_1\x1b\\", &.{Expect{ .kind = .reply, .code = @backingInt(ip.Protocol.apc), .flags = 0 }});
    // BEL ends only OSC.
    try check("\x1bPa\x07b\x1b\\", &.{reply("\x1bPa\x07b\x1b\\")});
    try check("\x1b_a\x07b\x1b\\", &.{reply("\x1b_a\x07b\x1b\\")});
    // Incomplete strings, paste starts, and partial mouse reports wait.
    for ([_][]const u8{ "\x1b]11;rgb:0000", "\x1b[<35;", "\x1b[<35;20", "\x1b[<", "\x1b[<64;20;10", "\x1b[M\x20\x21" }) |bytes| {
        try check(bytes, &.{});
    }
}

test "input parser cursor position reports and F3 share CSI R forms" {
    // Core's conformance vectors decide which forms are F3; these rows pin the reply flags.
    const plain: ip.Expectations = .{};
    const cpr: ip.Expectations = .{ .replies = true, .cursor_position = true };
    const kitty: ip.Expectations = .{ .kitty_keyboard = true };
    for ([_]struct { ip.Expectations, []const u8, Expect }{
        .{ cpr, "\x1b[1;2R", report("\x1b[1;2R") },
        .{ kitty, "\x1b[R", reply("\x1b[R") },
        .{ kitty, "\x1b[1;2R", report("\x1b[1;2R") },
        .{ plain, "\x1b[12;40R", report("\x1b[12;40R") },
        .{ plain, "\x1b[1;1R", report("\x1b[1;1R") },
        .{ plain, "\x1b[1;1:1R", reply("\x1b[1;1:1R") },
    }) |case| {
        var harness = try Harness.create();
        defer harness.deinit();
        harness.parser.setExpectations(case[0]);
        try expectGot(case[1], &.{case[2]}, try harness.feed(case[1]));
    }
}

// parse.keypress-kitty.test.ts and parse.keypress-kitty.protocol.test.ts

test "input parser Kitty keys report modifiers, events, and text" {
    const kitty = ip.flags.key_kitty;
    const caps: Mods = .{ .caps_lock = true };
    const num: Mods = .{ .num_lock = true };
    try checkOne(&.{
        .{ "\x1b[97u", Expect{ .kind = .key, .action = 1, .code = 'a', .flags = kitty, .text = "a", .raw = "\x1b[97u" } },
        .{ "\x1b[97;2u", kt('a', SHIFT, "A") },
        .{ "\x1b[97:65;2u", kt('a', SHIFT, "A") },
        .{ "\x1b[49:33;2u", kt('1', SHIFT, "!") },
        .{ "\x1b[97;5u", kt('a', CTRL, "a") },
        .{ "\x1b[97;3u", k('a', ALT) },
        .{ "\x1b[97;6u", kt('a', mods(&.{ CTRL, SHIFT }), "A") },
        .{ "\x1b[97;9u", k('a', SUPER) },
        .{ "\x1b[97;17u", k('a', .{ .hyper = true }) },
        .{ "\x1b[97;33u", k('a', .{ .meta = true }) },
        .{ "\x1b[97;65u", k('a', caps) },
        .{ "\x1b[97;129u", k('a', num) },
        .{ "\x1b[97;69u", k('a', mods(&.{ CTRL, caps })) },
        .{ "\x1b[97;256u", k('a', @bitCast(@as(u8, 255))) },
        .{ "\x1b[97;1:1u", ka('a', NONE, .press) },
        .{ "\x1b[97;1:2u", ka('a', NONE, .repeat) },
        .{ "\x1b[97;1:3u", ka('a', NONE, .release) },
        .{ "\x1b[97;5:2u", ka('a', CTRL, .repeat) },
        .{ "\x1b[97;2:3u", ka('a', SHIFT, .release) },
        .{ "\x1b[97;1:9u", ka('a', NONE, .press) },
        .{ "\x1b[97;1:u", ka('a', NONE, .press) },
        .{ "\x1b[97:65u", kt('a', NONE, "a") },
        .{ "\x1b[97::113u", kt('a', NONE, "a") },
        .{ "\x1b[97;1;97u", kt('a', NONE, "a") },
        .{ "\x1b[97;1;65u", kt('a', NONE, "A") },
        .{ "\x1b[97;1;229u", kt('a', NONE, "å") },
        .{ "\x1b[32u", kt(' ', NONE, " ") },
        .{ "\x1b[32;2u", kt(' ', SHIFT, " ") },
        .{ "\x1b[32:32:32;5u", k(' ', CTRL) },
        .{ "\x1b[233u", kt(0xe9, NONE, "é") },
        .{ "\x1b[233;2u", kt(0xe9, SHIFT, "É") },
        .{ "\x1b[1072;2u", kt(0x430, SHIFT, "А") },
        .{ "\x1b[128512u", kt(0x1f600, NONE, "😀") },
        .{ "\x1b[13u", kt(K.enter, NONE, "") },
        .{ "\x1b[27u", k(K.escape, NONE) },
        .{ "\x1b[9u", k(K.tab, NONE) },
        .{ "\x1b[127;3u", k(K.backspace, ALT) },
        .{ "\x1b[8u", k(K.backspace, NONE) },
        .{ "\x1b[57344u", k(K.escape, NONE) },
        .{ "\x1b[57345u", k(K.enter, NONE) },
        .{ "\x1b[57346u", k(K.tab, NONE) },
        .{ "\x1b[57347u", k(K.backspace, NONE) },
        .{ "\x1b[57349;5u", k(K.delete, CTRL) },
        .{ "\x1b[57376u", k(K.f(13), NONE) },
        .{ "\x1b[57414u", kt(57414, NONE, "") },
        .{ "\x1b[57399u", kt(K.kp_0, NONE, "0") },
        .{ "\x1b[57400;5u", kt(K.kp_0 + 1, CTRL, "1") },
        .{ "\x1b[57400;1;120u", kt(K.kp_0 + 1, NONE, "x") },
        .{ "\x1b[57409u", kt(57409, NONE, ".") },
        .{ "\x1b[57416u", kt(57416, NONE, ",") },
        .{ "\x1b[57441u", k(57441, NONE) },
        .{ "\x1b[57364;1:3u", ka(K.f(1), NONE, .release) },
        .{ "\x1b[57352;5:2u", ka(K.up, CTRL, .repeat) },
        // Kitty's `mods:event` on legacy forms.
        .{ "\x1b[1;1:1A", Expect{ .kind = .key, .action = 1, .code = K.up, .flags = kitty } },
        .{ "\x1b[1;1:3A", ka(K.up, NONE, .release) },
        .{ "\x1b[1;1:2B", ka(K.down, NONE, .repeat) },
        .{ "\x1b[1;5:3B", ka(K.down, CTRL, .release) },
        .{ "\x1b[1;1:1E", k(K.kp_begin, NONE) },
        .{ "\x1b[1;1:1P", k(K.f(1), NONE) },
        .{ "\x1b[5;1:2~", ka(K.page_up, NONE, .repeat) },
        .{ "\x1b[3;5:3~", ka(K.delete, CTRL, .release) },
        .{ "\x1b[24;1:2~", ka(K.f(12), NONE, .repeat) },
        .{ "\x1b[29;1:1~", Expect{ .kind = .key, .action = 1, .code = K.menu, .flags = kitty } },
        .{ "\x1b[1;2A", Expect{ .kind = .key, .action = 1, .code = K.up, .mods = SHIFT, .flags = 0 } },
        .{ "\x1b[97:65:113;5:2;97u", ka('a', CTRL, .repeat) },
        // Fields past params_max are ignored.
        .{ "\x1b[97;5;97;1;1;1;1;1;1;1;1;1;1;1;1;1;1:2u", kt('a', CTRL, "a") },
        // Not Unicode scalar values, or control characters.
        .{ "\x1b[1114112u", reply("\x1b[1114112u") },
        .{ "\x1b[55296u", reply("\x1b[55296u") },
        .{ "\x1b[3;5u", reply("\x1b[3;5u") },
        .{ "\x1b[0u", reply("\x1b[0u") },
        .{ "\x1b[u", reply("\x1b[u") },
    });
    // Text without a key (input method commits) and long text.
    try check("\x1b[0;;229u", &.{kt(0, NONE, "å")});
    try check("\x1b[0;;104:105u", &.{kt(0, NONE, "hi")});
    try check("\x1b[0;;104:0:7:105u", &.{kt(0, NONE, "hi")});
    try check("\x1b[0;;20013:25991:20013:25991:20013:25991:20013:25991u", &.{
        Expect{ .kind = .key, .action = 1, .code = 0, .flags = kitty, .text = "中文中文中文中文" },
    });
    try check("\x1b[0;;20013:25991:20013:25991:20013:25991:20013:25991:20013u", &.{
        Expect{ .kind = .key, .action = 1, .code = 0, .flags = kitty | ip.flags.key_text_truncated, .text = "中文中文中文中文" },
    });
    try check("\x1b[0;;128512:128512:128512:128512:128512:128512:128512:128512:128512u", &.{
        Expect{ .kind = .key, .action = 1, .code = 0, .flags = kitty | ip.flags.key_text_truncated, .text = utils.repeat(u8, "😀", 8) },
    });
    // Base-layout keys are reported as sent; key bindings decide policy (issue 050).
    try check("\x1b[97:65:113u", &.{Expect{ .kind = .key, .action = 1, .code = 'a', .base = 'q' }});
    try check("\x1b[12618::99;5u", &.{Expect{ .kind = .key, .action = 1, .code = 12618, .mods = CTRL, .base = 'c' }});
    try check("\x1b[1094::106;5u", &.{Expect{ .kind = .key, .action = 1, .code = 0x446, .mods = CTRL, .base = 'j' }});
    try check("\x1b[57352::57352u", &.{Expect{ .kind = .key, .action = 1, .code = K.up, .base = 0 }});
}

test "input parser decodes every Kitty functional key" {
    var buffer: [16]u8 = undefined;
    var count: u32 = 0;
    for ([_]u32{ 27, 13, 9, 127 }) |code| {
        try check(try std.fmt.bufPrint(&buffer, "\x1b[{d}u", .{code}), &.{k(code, NONE)});
        count += 1;
    }
    var code: u32 = 57348;
    while (code <= K.functional_last) : (code += 1) {
        try check(try std.fmt.bufPrint(&buffer, "\x1b[{d}u", .{code}), &.{k(code, NONE)});
        count += 1;
    }
    try testing.expectEqual(@as(u32, 111), count);
}

// parse.mouse.test.ts

test "input parser X10 mouse reports" {
    const all = mods(&.{ SHIFT, ALT, CTRL });
    for ([_]struct { u8, Expect }{
        .{ 0, down(0, 10, 5) },
        .{ 1, down(1, 10, 5) },
        .{ 2, down(2, 10, 5) },
        .{ 3, mouse(.up, 0, 10, 5, NONE) },
        .{ 64, mouse(.scroll, 0, 10, 5, NONE) },
        .{ 65, mouse(.scroll, 1, 10, 5, NONE) },
        .{ 66, mouse(.scroll, 2, 10, 5, NONE) },
        .{ 67, mouse(.scroll, 3, 10, 5, NONE) },
        .{ 68, mouse(.scroll, 0, 10, 5, SHIFT) },
        .{ 80, mouse(.scroll, 0, 10, 5, CTRL) },
        .{ 4, mouse(.down, 0, 10, 5, SHIFT) },
        .{ 8, mouse(.down, 0, 10, 5, ALT) },
        .{ 16, mouse(.down, 0, 10, 5, CTRL) },
        .{ 28, mouse(.down, 0, 10, 5, all) },
        .{ 18, mouse(.down, 2, 10, 5, CTRL) },
        .{ 32, mouse(.drag, 0, 10, 5, NONE) },
        .{ 33, mouse(.drag, 1, 10, 5, NONE) },
        .{ 34, mouse(.drag, 2, 10, 5, NONE) },
        .{ 35, mouse(.move, none, 10, 5, NONE) },
        .{ 39, mouse(.move, none, 10, 5, SHIFT) },
        .{ 63, mouse(.move, none, 10, 5, all) },
        .{ 96, mouse(.move, none, 10, 5, NONE) },
        .{ 128, down(8, 10, 5) },
        .{ 129, down(9, 10, 5) },
    }) |case| {
        const bytes = x10(case[0], 10, 5);
        var expected = case[1];
        expected.raw = &bytes;
        try check(&bytes, &.{expected});
    }
    // Coordinates past 94 are bytes above 127; xterm's 0 is one past its limit (issue 049).
    for ([_][2]u8{ .{ 0, 0 }, .{ 79, 23 }, .{ 94, 94 }, .{ 95, 0 }, .{ 222, 1 } }) |cell| {
        try check(&x10(0, cell[0], cell[1]), &.{down(0, cell[0], cell[1])});
    }
    try check("\x1b[M\x20\x00\x00", &.{down(0, 223, 223)});
    try check("\x1b[M\x20\x7f\x7f", &.{down(0, 94, 94)});
    try check("\x1b[M !!x", &.{ down(0, 0, 0), ch('x') });
    try check("\x1b[M abc", &.{ down(0, 64, 65), ch('c') });
    // A release reports the button pressed last.
    try check("\x1b[M\"!!\x1b[M#!!", &.{ down(2, 0, 0), mouse(.up, 2, 0, 0, NONE) });
    try check("\x1b[M\"!!\x1b[M'!!", &.{ down(2, 0, 0), mouse(.up, 2, 0, 0, SHIFT) });
    // A control byte cuts the report short.
    try check("\x1b[M \x1b[A", &.{ frag("\x1b[M "), k(K.up, NONE) });
    var harness = try Harness.create();
    defer harness.deinit();
    try expectGot("", &.{down(0, 0, 0)}, try split(&harness, &.{ "\x1b[M", " !!" }));
}

test "input parser SGR mouse reports" {
    const all = mods(&.{ SHIFT, ALT, CTRL });
    try checkOne(&.{
        .{ "\x1b[<0;11;6M", Expect{ .kind = .mouse, .action = 1, .code = 0, .x = 10, .y = 5, .raw = "\x1b[<0;11;6M", .text = "" } },
        .{ "\x1b[<0;11;6m", mouse(.up, 0, 10, 5, NONE) },
        .{ "\x1b[<1;11;6M", down(1, 10, 5) },
        .{ "\x1b[<2;11;6M", down(2, 10, 5) },
        .{ "\x1b[<2;11;6m", mouse(.up, 2, 10, 5, NONE) },
        .{ "\x1b[<64;11;6M", mouse(.scroll, 0, 10, 5, NONE) },
        .{ "\x1b[<65;11;6M", mouse(.scroll, 1, 10, 5, NONE) },
        .{ "\x1b[<66;11;6M", mouse(.scroll, 2, 10, 5, NONE) },
        .{ "\x1b[<67;11;6M", mouse(.scroll, 3, 10, 5, NONE) },
        // URxvt sets the wheel bit on motion.
        .{ "\x1b[<96;81;67M", mouse(.move, none, 80, 66, NONE) },
        .{ "\x1b[<97;81;67M", mouse(.move, none, 80, 66, NONE) },
        .{ "\x1b[<35;11;6m", mouse(.move, none, 10, 5, NONE) },
        .{ "\x1b[<32;13;6m", mouse(.drag, 0, 12, 5, NONE) },
        .{ "\x1b[<34;1;1M", mouse(.drag, 2, 0, 0, NONE) },
        .{ "\x1b[<4;11;6M", mouse(.down, 0, 10, 5, SHIFT) },
        .{ "\x1b[<8;11;6M", mouse(.down, 0, 10, 5, ALT) },
        .{ "\x1b[<16;11;6M", mouse(.down, 0, 10, 5, CTRL) },
        .{ "\x1b[<28;11;6M", mouse(.down, 0, 10, 5, all) },
        .{ "\x1b[<20;1;1M", mouse(.down, 0, 0, 0, mods(&.{ SHIFT, CTRL })) },
        .{ "\x1b[<128;1;1M", down(8, 0, 0) },
        .{ "\x1b[<0;1;1M", down(0, 0, 0) },
        .{ "\x1b[<0;0;0M", down(0, 0, 0) },
        .{ "\x1b[<0;501;301M", down(0, 500, 300) },
        .{ "\x1b[<0;70000;1M", down(0, 65535, 0) },
        // A wheel release carries nothing (issue 048); button 3 is no button.
        .{ "\x1b[<64;11;6m", reply("\x1b[<64;11;6m") },
        .{ "\x1b[<3;11;6M", reply("\x1b[<3;11;6M") },
        .{ "\x1b[<3;11;6m", reply("\x1b[<3;11;6m") },
        .{ "\x1b[<0;1M", reply("\x1b[<0;1M") },
        .{ "\x1b[<0;1;1;1M", reply("\x1b[<0;1;1;1M") },
        .{ "\x1b[<0:1;1;1M", reply("\x1b[<0:1;1;1M") },
        .{ "\x1b[<0;1;1R", reply("\x1b[<0;1;1R") },
    });
    // Mouse decoding is stateless.
    try check("\x1b[<0;6;6M\x1b[<32;9;6m\x1b[<0;9;6m\x1b[<35;11;6m", &.{
        down(0, 5, 5), mouse(.drag, 0, 8, 5, NONE), mouse(.up, 0, 8, 5, NONE), mouse(.move, none, 10, 5, NONE),
    });
    try check("\x1b[<64;83;68M\x1b[<96;82;68M", &.{ mouse(.scroll, 0, 82, 67, NONE), mouse(.move, none, 81, 67, NONE) });
    try check("x\x1b[<64;10;5M", &.{ ch('x'), mouse(.scroll, 0, 9, 4, NONE) });
    var harness = try Harness.create();
    defer harness.deinit();
    try expectGot("", &.{mouse(.scroll, 0, 9, 4, NONE)}, try split(&harness, &.{ "\x1b[<64;10;", "5M" }));
}

// stdin-parser.test.ts

test "input parser bracketed paste" {
    try check("\x1b[200~hello\x1b[201~", &.{paste("hello")});
    try check("\x1b[200~\x1b[201~", &.{Expect{ .kind = .paste, .code = 0, .text = "", .raw = "", .flags = ip.flags.paste_start | ip.flags.paste_end }});
    try check("\x1b[200~line1\nline2\x1b[201~", &.{paste("line1\nline2")});
    try check("\x1b[200~abc\x1bdef\x1b[201~", &.{paste("abc\x1bdef")});
    try check("\x1b[200~abc\x1b[202~def\x1b[201~", &.{paste("abc\x1b[202~def")});
    try check("\x1b[200~hello\x1b[201~\x1b[A", &.{ paste("hello"), k(K.up, NONE) });
    try check("\x1b[200~first\x1b[201~\x1b[200~second\x1b[201~", &.{ paste("first"), paste("second") });
    try check("\x1b[200~日本語👍\x1b[201~", &.{paste("日本語👍")});
    try check("\x1b[200~qjk \r\t\x1b[A\x1b[201!\x1b[20\x1b\x1b[201~q", &.{ paste("qjk \r\t\x1b[A\x1b[201!\x1b[20\x1b"), ch('q') });
    try check("\x1b[200~\x1b\x1b\x1b[201~", &.{paste("\x1b\x1b")});
    try check("\x1b[200~\x1b[20\x1b[201~", &.{paste("\x1b[20")});
    const start = "\x1b[200~";
    for (1..start.len) |index| {
        var harness = try Harness.create();
        defer harness.deinit();
        const rest = try std.mem.concat(testing.allocator, u8, &.{ start[index..], "hi\x1b[201~" });
        defer testing.allocator.free(rest);
        try expectGot(start, &.{paste("hi")}, try split(&harness, &.{ start[0..index], rest }));
    }
    const end = "\x1b[201~";
    for (1..end.len) |index| {
        var harness = try Harness.create();
        defer harness.deinit();
        _ = try harness.feed("\x1b[200~hello");
        _ = try harness.feed(end[0..index]);
        try expectGot(end, &.{Expect{ .kind = .paste, .code = 0, .text = "hello", .flags = ip.flags.paste_start }}, harness.out.items);
        _ = try harness.feed(end[index..]);
        try expectGot(end, &.{paste("hello")}, harness.out.items);
    }
    // A paste has no deadline.
    var harness = try Harness.create();
    defer harness.deinit();
    try expectGot("", &.{Expect{ .kind = .paste, .code = 0, .text = "partial", .flags = ip.flags.paste_start }}, try harness.feed("\x1b[200~partial"));
    try testing.expectEqual(null, harness.parser.deadlineNs());
    _ = try harness.wait(100);
    _ = try harness.feed("\x1b[201~");
    try expectGot("", &.{paste("partial")}, harness.out.items);
    // Large pastes stream through bounded sinks, with markers inside the payload.
    const payload = try testing.allocator.alloc(u8, 100 * 1024);
    defer testing.allocator.free(payload);
    for (payload, 0..) |*byte, index| byte.* = if (index % 997 == 0) 0x1b else 'a' + @as(u8, @intCast(index % 26));
    const stream = try std.mem.concat(testing.allocator, u8, &.{ "\x1b[200~", payload, "\x1b[201~z" });
    defer testing.allocator.free(stream);
    var large = try Harness.create();
    defer large.deinit();
    try expectGot("large paste", &.{ paste(payload), ch('z') }, try large.feed(stream));
    try testing.expect(large.feeds > 1);
}

test "input parser separates replies from text and reports partial units as fragments" {
    var harness = try Harness.create();
    defer harness.deinit();
    try expectGot("", &.{reply("\x1b]4;0;#ffffff\x07")}, try split(&harness, &.{ "\x1b]4;0;", "#ffffff\x07" }));
    try expectGot("", &.{reply("\x1bPtest\x1b\\")}, try split(&harness, &.{ "\x1bPtest\x1b", "\\" }));
    try check("\x1b]4;0;#fff\x07\x1bP>|test\x1b\\\x1b_OK\x1b\\", &.{ reply("\x1b]4;0;#fff\x07"), reply("\x1bP>|test\x1b\\"), reply("\x1b_OK\x1b\\") });
    // The timeout counts from the latest byte, so a reply that keeps arriving keeps waiting.
    const response = "\x1b[4;1080;1920t";
    var timed = try Harness.create();
    defer timed.deinit();
    for (response, 0..) |_, index| {
        try expectGot(response, &.{}, try timed.wait(15));
        const got = try timed.feed(response[index..][0..1]);
        if (index + 1 == response.len) try expectGot(response, &.{reply(response)}, got) else try expectGot(response, &.{}, got);
    }
}

test "input parser ESC, control bytes, and overlong units interrupt a unit" {
    try check("\x1b[<35;\x1b[<35;20;5m", &.{ frag("\x1b[<35;"), mouse(.move, none, 19, 4, NONE) });
    try check("\x1b]foo\x1b\\", &.{reply("\x1b]foo\x1b\\")});
    try check("\x1b]foo\x1b[A", &.{ frag("\x1b]foo"), k(K.up, NONE) });
    try check("\x1b]foo\x1bx", &.{ frag("\x1b]foo"), k('x', ALT) });
    try check("\x1bO\x1b[A", &.{ frag("\x1bO"), k(K.up, NONE) });
    try check("\x1bO\x1bOA", &.{ frag("\x1bO"), k(K.up, NONE) });
    try check("\x1b[12\r", &.{ frag("\x1b[12"), k(K.enter, NONE) });
    try check("\x1b[12\x7f", &.{ frag("\x1b[12"), k(K.backspace, NONE) });
    try check("\x1bO\x03", &.{ frag("\x1bO"), k('c', CTRL) });
    var harness = try Harness.create();
    defer harness.deinit();
    try expectGot("", &.{frag("\x1b[123")}, try harness.feed("\x1b[123\x1b"));
    try expectGot("", &.{k(K.escape, NONE)}, try harness.wait(20));
    // Overlong CSI and strings are discarded through their terminator: one unit each.
    const nines = try testing.allocator.alloc(u8, 100_000);
    defer testing.allocator.free(nines);
    @memset(nines, '9');
    const xs = nines[0 .. 2 * ip.unit_bytes_max];
    const fill = nines[0 .. ip.unit_bytes_max - 2];
    for ([_]struct { []const u8, []const u8, []const u8, []const Expect }{
        .{ "\x1b[", nines, "~q", &.{ch('q')} },
        .{ "\x1b[", nines[0..300], "\x1b[A", &.{k(K.up, NONE)} },
        .{ "\x1b]", xs, "\x07q", &.{ch('q')} },
        .{ "\x1bP", xs, "\x1b\\q", &.{ch('q')} },
        .{ "\x1b_", xs, "\x1bq", &.{k('q', ALT)} },
        // BEL is payload in an overlong DCS or APC too: only `ESC \` ends their discard.
        .{ "\x1bP", xs, "\x07bc\x1b\\q", &.{ch('q')} },
        .{ "\x1b_", xs, "\x07bc\x1b\\q", &.{ch('q')} },
        // At the limit the terminator must fit: ESC needs room for `\`; an OSC BEL drops the string.
        .{ "\x1b]", fill, "\x1b\\q", &.{ch('q')} },
        .{ "\x1b]", fill, "zz\x07q", &.{ch('q')} },
        .{ "\x1b]", fill, "\x07q", &.{ch('q')} },
    }) |case| {
        var discard = try Harness.create();
        defer discard.deinit();
        _ = try discard.feed(case[0]);
        _ = try discard.feed(case[1]);
        try expectGot(case[2], case[3], try discard.feed(case[2]));
        try testing.expectEqual(@as(u32, 1), discard.parser.discarded_count);
    }
    // A discarded unit times out like any other.
    _ = try harness.feed("\x1b]");
    _ = try harness.feed(xs);
    try expectGot("", &.{}, try harness.wait(20));
    try expectGot("", &.{ch('q')}, try harness.feed("q"));
    // A string that just fits the unit keeps its terminator.
    for ([_][]const u8{ "\x07", "\x1b\\" }) |terminator| {
        const exact = try std.mem.concat(testing.allocator, u8, &.{ "\x1b]", fill[terminator.len..], terminator });
        defer testing.allocator.free(exact);
        try check(exact, &.{reply(exact)});
    }
}

test "input parser times out partial units unless they may be mouse reports, Kitty keys, or awaited replies" {
    const plain: ip.Expectations = .{};
    const kitty: ip.Expectations = .{ .kitty_keyboard = true };
    const replies: ip.Expectations = .{ .replies = true };
    const cpr: ip.Expectations = .{ .replies = true, .cursor_position = true };
    const sentinel: ip.Expectations = .{ .replies = true, .sentinel = true };
    const sentinel_kitty: ip.Expectations = .{ .replies = true, .kitty_keyboard = true, .sentinel = true };
    for ([_]struct { ip.Expectations, []const u8, usize, []const u8, []const Expect }{
        // A fragment, and later input is not swallowed. Legacy Alt+[ and Alt+Shift+P start a CSI and a DCS.
        .{ plain, "\x1b\x1b[", 2, "<", &.{ k(K.escape, NONE), frag("\x1b["), ch('<') } },
        .{ plain, "\x1bP", 1, "q", &.{ frag("\x1bP"), ch('q') } },
        .{ plain, "\x1b]", 1, "q", &.{ frag("\x1b]"), ch('q') } },
        .{ plain, "\x1bO", 1, "a", &.{ frag("\x1bO"), ch('a') } },
        .{ plain, "\x1b]incomplete", 1, "a", &.{ frag("\x1b]incomplete"), ch('a') } },
        .{ plain, "\x1b_partial", 1, "a", &.{ frag("\x1b_partial"), ch('a') } },
        .{ plain, "\x1b[123", 1, "a", &.{ frag("\x1b[123"), ch('a') } },
        .{ plain, "\x1b[80;120", 1, "a", &.{ frag("\x1b[80;120"), ch('a') } },
        .{ plain, "\x1b[1;5", 1, "A", &.{ frag("\x1b[1;5"), ch('A') } },
        .{ plain, "\x1b[24;80", 1, "R", &.{ frag("\x1b[24;80"), ch('R') } },
        .{ plain, "\x1b]52;c;", 1, "\x1b[A", &.{ frag("\x1b]52;c;"), k(K.up, NONE) } },
        .{ plain, "\x1b[118;5", 1, "a", &.{ frag("\x1b[118;5"), ch('a') } },
        .{ plain, "\x1b[M ", 1, "a", &.{ frag("\x1b[M "), ch('a') } },
        .{ plain, "\x1b\x1b[1;5", 2, "A", &.{ k(K.escape, NONE), frag("\x1b[1;5"), ch('A') } },
        .{ plain, "\x1b[?1", 1, "u", &.{ frag("\x1b[?1"), ch('u') } },
        // Deferred units, and the bytes that cannot continue them.
        .{ plain, "\x1b[<35;20", 0, ";5m", &.{mouse(.move, none, 19, 4, NONE)} },
        .{ plain, "\x1b[<", 0, "0;1;1M", &.{down(0, 0, 0)} },
        .{ plain, "\x1b[<35;20", 0, "x", &.{ frag("\x1b[<35;20"), ch('x') } },
        .{ plain, "\x1b\x1b[<35;20", 0, "\x1b", &.{ k(K.escape, NONE), frag("\x1b[<35;20") } },
        .{ kitty, "\x1b[118;5", 0, ";3u", &.{kt('v', CTRL, "v")} },
        .{ kitty, "\x1b[97;", 0, "2u", &.{kt('a', SHIFT, "A")} },
        .{ kitty, "\x1b[97:65;", 0, "6:1u", &.{k('a', mods(&.{ CTRL, SHIFT }))} },
        .{ kitty, "\x1b[97;9", 0, "u", &.{k('a', SUPER)} },
        .{ kitty, "\x1b[1;1:", 0, "3A", &.{ka(K.up, NONE, .release)} },
        .{ kitty, "\x1b[5;1:", 0, "3~", &.{ka(K.page_up, NONE, .release)} },
        .{ kitty, "\x1b[27;5", 0, "u", &.{k(K.escape, CTRL)} },
        .{ kitty, "\x1b[118;5", 0, "\x1b[A", &.{ frag("\x1b[118;5"), k(K.up, NONE) } },
        .{ kitty, "\x1b[118;5", 0, "a", &.{ frag("\x1b[118;5"), ch('a') } },
        .{ kitty, "\x1b[1;5", 0, "A", &.{ frag("\x1b[1;5"), ch('A') } },
        .{ kitty, "\x1b\x1b[97;5", 0, "u", &.{k('a', mods(&.{ CTRL, ALT }))} },
        .{ kitty, "\x1b[97;", 0, "u", &.{ frag("\x1b[97;"), ch('u') } },
        .{ kitty, "\x1b[1;2;3;4", 1, "u", &.{ frag("\x1b[1;2;3;4"), ch('u') } },
        .{ replies, "\x1b[?1016;2$", 0, "y", &.{reply("\x1b[?1016;2$y")} },
        .{ replies, "\x1b[?62;", 0, "c", &.{reply("\x1b[?62;c")} },
        .{ replies, "\x1b[?997;1", 0, "n", &.{reply("\x1b[?997;1n")} },
        .{ replies, "\x1b[?5", 0, "u", &.{reply("\x1b[?5u")} },
        .{ replies, "\x1b[?1", 0, "x", &.{ frag("\x1b[?1"), ch('x') } },
        .{ cpr, "\x1b[1;2", 0, "R", &.{report("\x1b[1;2R")} },
        .{ replies, "\x1b[1;2", 0, "R", &.{k(K.f(3), SHIFT)} },
        .{ replies, "\x1b[24;", 0, "80R", &.{report("\x1b[24;80R")} },
        .{ replies, "\x1b[4;600", 0, ";800t", &.{reply("\x1b[4;600;800t")} },
        .{ replies, "\x1b[4;600;8", 0, "00t", &.{reply("\x1b[4;600;800t")} },
        .{ replies, "\x1b[1;5", 0, "A", &.{ frag("\x1b[1;5"), ch('A') } },
        .{ replies, "\x1b[4;600;8", 0, "R", &.{ frag("\x1b[4;600;8"), ch('R') } },
        // Only the shapes the host waits for defer: `CSI 8 ; h ; w t` is not a pixel reply.
        .{ replies, "\x1b[8;600;80", 1, "t", &.{ frag("\x1b[8;600;80"), ch('t') } },
        .{ replies, "\x1b[1;2:3:4:5", 1, "R", &.{ frag("\x1b[1;2:3:4:5"), ch('R') } },
        // Without SENTINEL a pause still cuts a string or a number short, and no reply byte continues a bare `ESC [` (issue 342).
        .{ replies, "\x1b]11;rg", 1, "b\x07", &.{ frag("\x1b]11;rg"), ch('b'), k('g', CTRL) } },
        .{ replies, "\x1b[", 0, "?c", &.{ frag("\x1b["), ch('?'), ch('c') } },
        .{ replies, "\x1b[24", 1, ";", &.{ frag("\x1b[24"), ch(';') } },
        // With SENTINEL a string that begins like a reply waits however long the pause.
        .{ sentinel, "\x1b]1", 0, "1;rgb:0/0/0\x07", &.{reply("\x1b]11;rgb:0/0/0\x07")} },
        .{ sentinel, "\x1b]11;rgb:0/0/0\x1b", 0, "\\", &.{reply("\x1b]11;rgb:0/0/0\x1b\\")} },
        .{ sentinel, "\x1bP>", 0, "|kitty(0.40.1)\x1b\\", &.{reply("\x1bP>|kitty(0.40.1)\x1b\\")} },
        .{ sentinel, "\x1bP1$r0m\x1b", 0, "\\", &.{reply("\x1bP1$r0m\x1b\\")} },
        .{ sentinel, "\x1b_Gi=1;", 0, "OK\x1b\\", &.{reply("\x1b_Gi=1;OK\x1b\\")} },
        .{ sentinel, "\x1b]11;rg", 0, "\x1b[?62c", &.{ frag("\x1b]11;rg"), reply("\x1b[?62c") } },
        // A bare introducer or a number waits for a byte that begins a reply; another byte is typed.
        .{ sentinel, "\x1b[", 0, "?62c", &.{reply("\x1b[?62c")} },
        .{ sentinel, "\x1b[24", 0, ";80R", &.{report("\x1b[24;80R")} },
        .{ sentinel, "\x1b]", 0, "11;rgb:0/0/0\x07", &.{reply("\x1b]11;rgb:0/0/0\x07")} },
        .{ sentinel, "\x1bP", 0, ">|kitty\x1b\\", &.{reply("\x1bP>|kitty\x1b\\")} },
        .{ sentinel, "\x1b_", 0, "Gi=1;OK\x1b\\", &.{reply("\x1b_Gi=1;OK\x1b\\")} },
        .{ sentinel, "\x1b[", 0, "j", &.{ frag("\x1b["), ch('j') } },
        .{ sentinel, "\x1b[", 0, "M !!", &.{Expect{ .kind = .mouse, .action = 1, .code = 0, .raw = "\x1b[M !!" }} },
        .{ sentinel, "\x1b[", 0, "<0;1;1M", &.{down(0, 0, 0)} },
        .{ sentinel, "\x1b[", 0, "M", &.{ frag("\x1b["), ch('M') } },
        .{ sentinel, "\x1b[", 0, "<", &.{ frag("\x1b["), ch('<') } },
        .{ sentinel, "\x1b[", 0, "\x1b[A", &.{ frag("\x1b["), k(K.up, NONE) } },
        .{ sentinel, "\x1b\x1b[", 0, "j", &.{ k(K.escape, NONE), frag("\x1b["), ch('j') } },
        .{ sentinel, "\x1b[24", 0, "j", &.{ frag("\x1b[24"), ch('j') } },
        .{ sentinel, "\x1b[24", 0, "R", &.{ frag("\x1b[24"), ch('R') } },
        .{ sentinel_kitty, "\x1b[13", 0, ";2u", &.{ frag("\x1b[13;2"), ch('u') } },
        .{ sentinel, "\x1bP", 0, "1$r0m\x1b\\", &.{reply("\x1bP1$r0m\x1b\\")} },
        .{ sentinel, "\x1b]", 0, ";x", &.{ frag("\x1b]"), ch(';'), ch('x') } },
        .{ sentinel, "\x1b]", 0, "12345678", &([_]Expect{frag("\x1b]1234567")} ++ typed("8")) },
        .{ sentinel, "\x1b]", 0, "j", &.{ frag("\x1b]"), ch('j') } },
        .{ sentinel, "\x1bP", 0, "+q", &.{ frag("\x1bP"), ch('+'), ch('q') } },
        .{ sentinel, "\x1b_", 0, "g", &.{ frag("\x1b_"), ch('g') } },
        .{ sentinel, "\x1b]", 0, "\x1b[A", &.{ frag("\x1b]"), k(K.up, NONE) } },
        // A lone Escape, SS3, and strings that begin like no reply still time out.
        .{ sentinel, "\x1b", 1, "j", &.{ k(K.escape, NONE), ch('j') } },
        .{ sentinel, "\x1bO", 1, "a", &.{ frag("\x1bO"), ch('a') } },
        .{ sentinel, "\x1b]x", 1, "1", &.{ frag("\x1b]x"), ch('1') } },
        .{ sentinel, "\x1bP+", 1, "q", &.{ frag("\x1bP+"), ch('q') } },
        .{ sentinel, "\x1b_g", 1, "q", &.{ frag("\x1b_g"), ch('q') } },
    }) |case| try checkTimed(case[0], case[1], case[2], case[3], case[4]);
    // A timed-out bare `ESC [` continues only into a read that holds the rest of a mouse report.
    // Keys typed after Alt+[ come one read each and stay keys, and so does any other byte.
    for ([_]struct { []const []const u8, []const Expect }{
        .{ &.{"<0;1;1M"}, &.{down(0, 0, 0)} },
        .{ &.{"M !!"}, &.{Expect{ .kind = .mouse, .action = 1, .code = 0, .raw = "\x1b[M !!" }} },
        .{ &.{ "<0", ";1;1M" }, &.{down(0, 0, 0)} },
        .{ &.{ "<", "a" }, &.{ frag("\x1b["), ch('<'), ch('a') } },
        .{ &.{ "M", "a" }, &.{ frag("\x1b["), ch('M'), ch('a') } },
        .{ &.{ "<", "1", "2", ";", "3", "x" }, &.{ frag("\x1b["), ch('<'), ch('1'), ch('2'), ch(';'), ch('3'), ch('x') } },
        .{ &.{ "M", "M", "M", "M" }, &.{ frag("\x1b["), ch('M'), ch('M'), ch('M'), ch('M') } },
        .{ &.{ "M", " ", "!", "!" }, &.{ frag("\x1b["), ch('M'), ch(' '), ch('!'), ch('!') } },
        .{ &.{"M !"}, &.{ frag("\x1b["), ch('M'), ch(' '), ch('!') } },
        .{ &.{"1m"}, &.{ frag("\x1b["), ch('1'), ch('m') } },
        .{ &.{"?m"}, &.{ frag("\x1b["), ch('?'), ch('m') } },
        .{ &.{"m1"}, &.{ frag("\x1b["), ch('m'), ch('1') } },
    }) |case| {
        var bare = try Harness.create();
        defer bare.deinit();
        _ = try bare.feed("\x1b[");
        try expectGot("\x1b[", &.{}, try bare.wait(20));
        try expectGot(case[0][0], case[1], try split(&bare, case[0]));
    }
    // A deferred unit has no deadline until a byte continues it.
    var harness = try Harness.create();
    defer harness.deinit();
    _ = try harness.feed("\x1b[");
    try expectGot("", &.{}, try harness.wait(20));
    try testing.expectEqual(null, harness.parser.deadlineNs());
    harness.now += std.time.ns_per_s;
    _ = try harness.feed("<0;1;");
    try testing.expectEqual(harness.now + ip.timeout_ns, harness.parser.deadlineNs().?);
    try expectGot("", &.{down(0, 0, 0)}, try harness.feed("1M"));
    // Clearing an expectation gives a deferred unit its deadline back; it emits on the next feed.
    harness.parser.setExpectations(.{ .replies = true });
    _ = try harness.feed("\x1b[?62");
    try expectGot("", &.{}, try harness.wait(20));
    try testing.expectEqual(null, harness.parser.deadlineNs());
    harness.parser.setExpectations(.{});
    try testing.expect(harness.parser.deadlineNs() != null);
    try expectGot("", &.{frag("\x1b[?62")}, try harness.wait(0));
    // An expectation cleared before the timeout cuts the unit short.
    harness.parser.setExpectations(.{ .replies = true });
    _ = try harness.feed("\x1b[4;1");
    harness.parser.setExpectations(.{});
    try expectGot("", &.{frag("\x1b[4;1")}, try harness.wait(20));
    // The DA1 reply ends every hold: once the host clears SENTINEL, a held unit times out as before.
    for ([_]struct { []const u8, []const Expect }{
        .{ "\x1b]11;rg", &.{frag("\x1b]11;rg")} },
        .{ "\x1b_", &.{frag("\x1b_")} },
        .{ "\x1b[24", &.{frag("\x1b[24")} },
        .{ "\x1b_Gi=" ++ utils.repeat(u8, "9", ip.unit_bytes_max), &.{} },
    }) |case| {
        harness.parser.setExpectations(sentinel);
        _ = try harness.feed(case[0]);
        try expectGot(case[0], &.{}, try harness.wait(60_000));
        harness.parser.setExpectations(.{ .replies = true });
        try expectGot(case[0], case[1], try harness.wait(0));
    }
    // A held bare `ESC [` then waits as without SENTINEL, and a reply byte no longer continues it.
    harness.parser.setExpectations(sentinel);
    _ = try harness.feed("\x1b[");
    try expectGot("", &.{}, try harness.wait(60_000));
    harness.parser.setExpectations(.{ .replies = true });
    try expectGot("", &.{}, try harness.wait(0));
    try expectGot("", &.{ frag("\x1b["), ch('?') }, try harness.feed("?"));
    // An overlong reply is discarded up to its terminator, however long it takes.
    harness.parser.setExpectations(sentinel);
    _ = try harness.feed("\x1b_Gi=" ++ utils.repeat(u8, "9", ip.unit_bytes_max));
    try expectGot("", &.{}, try harness.wait(60_000));
    try expectGot("", &.{ch('q')}, try harness.feed("9\x1b\\q"));
    // A discarded string that begins like no reply, and a discarded CSI, still time out.
    _ = try harness.feed("\x1b]x" ++ utils.repeat(u8, "9", ip.unit_bytes_max));
    try expectGot("", &.{}, try harness.wait(20));
    try expectGot("", &.{ch('q')}, try harness.feed("q"));
    _ = try harness.feed("\x1b[" ++ utils.repeat(u8, "9", ip.sequence_bytes_max));
    try expectGot("", &.{}, try harness.wait(20));
    try expectGot("", &.{ ch('1'), ch('q') }, try harness.feed("1q"));
}

test "input parser types no reply byte at any cut or pause while a sentinel is out" {
    const sentinel: ip.Expectations = .{ .replies = true, .sentinel = true };
    for ([_][]const u8{
        "\x1b[?62;22c",          "\x1b[?2026;2$y",            "\x1b[?5u",                   "\x1b[24;80R",      "\x1b[4;600;800t",
        "\x1b]11;rgb:0/0/0\x07", "\x1b]4;1;rgb:cd/0/0\x1b\\", "\x1bP>|kitty(0.40.1)\x1b\\", "\x1bP1+r54\x1b\\", "\x1b_Gi=31;OK\x1b\\",
    }) |input| {
        var whole = try Harness.create();
        defer whole.deinit();
        whole.parser.setExpectations(sentinel);
        _ = try whole.feed(input);
        _ = try whole.feed("j");
        try testing.expectEqual(@as(usize, 2), whole.out.items.len);
        for (1..input.len) |cut| for ([_]u64{ 25, 5_000, 60_000 }) |pause| {
            var harness = try Harness.create();
            defer harness.deinit();
            harness.parser.setExpectations(sentinel);
            _ = try harness.feed(input[0..cut]);
            // A lone Escape still times out; the reply after it is not typed.
            try expectGot(input, if (cut == 1) &.{k(K.escape, NONE)} else &.{}, try harness.wait(pause));
            _ = try harness.feed(input[cut..]);
            _ = try harness.feed("j");
            if (!gotEql(whole.out.items, harness.out.items[@intFromBool(cut == 1)..])) {
                std.debug.print("cut {d}, pause {d} ms\n", .{ cut, pause });
                dump("whole", input, whole.out.items);
                dump("cut", input, harness.out.items);
                return error.TestUnexpectedResult;
            }
        };
    }
}

/// Typed keys: Enter for `\r`, otherwise the byte.
fn typed(comptime text: []const u8) [text.len]Expect {
    var keys: [text.len]Expect = undefined;
    for (text, &keys) |byte, *key| key.* = if (byte == '\r') k(K.enter, NONE) else ch(byte);
    return keys;
}

test "input parser keeps typed text typed after a held or recovered prefix while a sentinel is out" {
    const Step = union(enum) { feed: []const u8, wait: u64, clear };
    const esc = k(K.escape, NONE);
    const da1 = "\x1b[?62c";
    var failed: u32 = 0;
    // A continued string keeps only a reply's prefix: OSC digits and `;`, DCS `>|` or digits and
    // `+r` or `$r`, APC `G`, a key, and `=`. A held or recovered CSI completes only as a reply.
    for ([_]struct { []const u8, []const Step, []const Expect }{
        .{ "A10", &.{ .{ .feed = "\x1b]" }, .{ .wait = 100 }, .{ .feed = "1" }, .{ .wait = 100 }, .{ .feed = "hello\r" } }, &([_]Expect{frag("\x1b]1")} ++ typed("hello\r")) },
        .{ "A13", &.{ .{ .feed = "\x1b]" }, .{ .wait = 100 }, .{ .feed = "1" }, .{ .wait = 100 }, .{ .feed = "hello\r" }, .{ .wait = 100 }, .{ .feed = da1 } }, &([_]Expect{frag("\x1b]1")} ++ typed("hello\r") ++ [_]Expect{reply(da1)}) },
        .{ "A11", &.{ .{ .feed = "\x1bP" }, .{ .wait = 100 }, .{ .feed = ">" }, .{ .wait = 100 }, .{ .feed = "abc" } }, &([_]Expect{frag("\x1bP>")} ++ typed("abc")) },
        .{ "A12", &.{ .{ .feed = "\x1b_" }, .{ .wait = 100 }, .{ .feed = "G" }, .{ .wait = 100 }, .{ .feed = "abc" } }, &([_]Expect{frag("\x1b_Ga")} ++ typed("bc")) },
        .{ "C3", &.{ .{ .feed = "\x1b" }, .{ .wait = 1000 }, .{ .feed = "]" }, .{ .wait = 5 }, .{ .feed = "1" }, .{ .wait = 50 }, .{ .feed = "hello\r" } }, &([_]Expect{ esc, kt(']', NONE, "]"), frag("1") } ++ typed("hello\r")) },
        .{ "C4", &.{ .{ .feed = "\x1b" }, .{ .wait = 1000 }, .{ .feed = "P" }, .{ .wait = 5 }, .{ .feed = ">" }, .{ .wait = 50 }, .{ .feed = "abc" } }, &([_]Expect{ esc, kt('P', NONE, "P"), frag(">") } ++ typed("abc")) },
        .{ "C9", &.{ .{ .feed = "\x1b" }, .{ .wait = 1000 }, .{ .feed = "P" }, .{ .wait = 5 }, .{ .feed = "1" }, .{ .wait = 50 }, .{ .feed = "abc" } }, &([_]Expect{ esc, kt('P', NONE, "P"), frag("1") } ++ typed("abc")) },
        .{ "E1", &.{ .{ .feed = "\x1b" }, .{ .wait = 1000 }, .{ .feed = "P2 bug\r" } }, &([_]Expect{ esc, kt('P', NONE, "P"), frag("2") } ++ typed(" bug\r")) },
        .{ "E3", &.{ .{ .feed = "\x1b" }, .{ .wait = 1000 }, .{ .feed = "_Go" } }, &.{ esc, kt('_', NONE, "_"), frag("Go") } },
        .{ "E5", &.{ .{ .feed = "\x1b" }, .{ .wait = 1000 }, .{ .feed = "P2 bug\r" }, .{ .wait = 200 }, .{ .feed = "more" }, .{ .wait = 100 }, .{ .feed = da1 } }, &([_]Expect{ esc, kt('P', NONE, "P"), frag("2") } ++ typed(" bug\r") ++ typed("more") ++ [_]Expect{reply(da1)}) },
        .{ "A1", &.{ .{ .feed = "\x1b[" }, .{ .wait = 200 }, .{ .feed = "1" }, .{ .wait = 200 }, .{ .feed = "2" }, .{ .wait = 200 }, .{ .feed = "x" } }, &.{ frag("\x1b[12"), ch('x') } },
        .{ "A2", &.{ .{ .feed = "\x1b[" }, .{ .wait = 100 }, .{ .feed = "2" }, .{ .wait = 100 }, .{ .feed = "0" }, .{ .wait = 100 }, .{ .feed = "2" }, .{ .wait = 100 }, .{ .feed = "4" }, .{ .wait = 100 }, .{ .feed = "\r" } }, &.{ frag("\x1b[2024"), k(K.enter, NONE) } },
        .{ "A3", &.{ .{ .feed = "\x1b[" }, .{ .wait = 100 }, .{ .feed = "1" }, .{ .wait = 100 }, .{ .feed = "5" }, .{ .wait = 100 }, .{ .feed = "~" } }, &.{ frag("\x1b[15"), ch('~') } },
        .{ "A4", &.{ .{ .feed = "\x1b[" }, .{ .wait = 100 }, .{ .feed = "1" }, .{ .wait = 5 }, .{ .feed = "5" }, .{ .wait = 5 }, .{ .feed = "~" } }, &.{ frag("\x1b[15"), ch('~') } },
        .{ "A5", &.{ .{ .feed = "\x1b[" }, .{ .wait = 100 }, .{ .feed = "3" }, .{ .wait = 5 }, .{ .feed = "~" } }, &.{ frag("\x1b[3"), ch('~') } },
        .{ "A6", &.{ .{ .feed = "\x1b[" }, .{ .wait = 100 }, .{ .feed = "?" }, .{ .wait = 100 }, .{ .feed = "1" }, .{ .wait = 100 }, .{ .feed = "h" } }, &.{ frag("\x1b[?1"), ch('h') } },
        .{ "A7", &.{ .{ .feed = "\x1b[" }, .{ .wait = 100 }, .{ .feed = "1" }, .{ .wait = 100 }, .{ .feed = ";" }, .{ .wait = 100 }, .{ .feed = "2" }, .{ .wait = 100 }, .{ .feed = "R" } }, &.{report("\x1b[1;2R")} },
        .{ "A8", &.{ .{ .feed = "\x1b[" }, .{ .wait = 100 }, .{ .feed = "1" } }, &.{frag("\x1b[1")} },
        .{ "C1", &.{ .{ .feed = "\x1b" }, .{ .wait = 1000 }, .{ .feed = "[" }, .{ .wait = 5 }, .{ .feed = "1" }, .{ .wait = 200 }, .{ .feed = "2" }, .{ .wait = 200 }, .{ .feed = "x" } }, &.{ esc, kt('[', NONE, "["), frag("12"), ch('x') } },
        .{ "C2", &.{ .{ .feed = "\x1b" }, .{ .wait = 1000 }, .{ .feed = "[" }, .{ .wait = 5 }, .{ .feed = "3" }, .{ .wait = 5 }, .{ .feed = "~" } }, &.{ esc, kt('[', NONE, "["), frag("3"), ch('~') } },
        .{ "C6", &.{ .{ .feed = "\x1b" }, .{ .wait = 1000 }, .{ .feed = "[" }, .{ .wait = 5 }, .{ .feed = "?" }, .{ .wait = 50 }, .{ .feed = "abc" } }, &([_]Expect{ esc, frag("\x1b[?") } ++ typed("abc")) },
        .{ "C8", &.{ .{ .feed = "\x1b" }, .{ .wait = 1000 }, .{ .feed = "[1;5A" } }, &.{ esc, frag("\x1b[1;5"), ch('A') } },
        .{ "E2", &.{ .{ .feed = "\x1b" }, .{ .wait = 1000 }, .{ .feed = "[1] item" } }, &([_]Expect{ esc, kt('[', NONE, "["), frag("1") } ++ typed("] item")) },
        .{ "E4", &.{ .{ .feed = "\x1b" }, .{ .wait = 1000 }, .{ .feed = "[2024\r" } }, &.{ esc, kt('[', NONE, "["), frag("2024"), k(K.enter, NONE) } },
        .{ "P2", &.{ .{ .feed = "\x1b[" }, .{ .wait = 100 }, .{ .feed = "2" }, .{ .wait = 100 }, .{ .feed = "0" }, .{ .wait = 100 }, .{ .feed = "0" }, .{ .wait = 5 }, .{ .feed = "~" }, .{ .feed = "abc" }, .{ .feed = da1 }, .clear, .{ .wait = 60_000 }, .{ .feed = "later\r" } }, &([_]Expect{ frag("\x1b[200"), ch('~') } ++ typed("abc") ++ [_]Expect{reply(da1)} ++ typed("later\r")) },
        .{ "C11", &.{ .{ .feed = "\x1b" }, .{ .wait = 30 }, .{ .feed = "[" }, .{ .wait = 5 }, .{ .feed = "2" }, .{ .wait = 5 }, .{ .feed = "0" }, .{ .wait = 5 }, .{ .feed = "0" }, .{ .wait = 5 }, .{ .feed = "~" }, .{ .feed = "abc" } }, &([_]Expect{ esc, kt('[', NONE, "["), frag("200"), ch('~') } ++ typed("abc")) },
        .{ "R7", &.{ .{ .feed = "\x1b" }, .{ .wait = 20 }, .{ .feed = "[1x" } }, &.{ esc, kt('[', NONE, "["), frag("1"), ch('x') } },
        // Esc, then an introducer in a read of its own (vim's P, [, ], _): the introducer is typed when
        // the next key or the batch end cuts it.
        .{ "O1P", &.{ .{ .feed = "\x1b" }, .{ .wait = 120 }, .{ .feed = "P" }, .{ .wait = 120 }, .{ .feed = "x" } }, &.{ esc, kt('P', NONE, "P"), ch('x') } },
        .{ "O1[", &.{ .{ .feed = "\x1b" }, .{ .wait = 120 }, .{ .feed = "[" }, .{ .wait = 120 }, .{ .feed = "x" } }, &.{ esc, kt('[', NONE, "["), ch('x') } },
        .{ "O1]", &.{ .{ .feed = "\x1b" }, .{ .wait = 120 }, .{ .feed = "]" }, .{ .wait = 120 }, .{ .feed = "x" } }, &.{ esc, kt(']', NONE, "]"), ch('x') } },
        .{ "O1_", &.{ .{ .feed = "\x1b" }, .{ .wait = 120 }, .{ .feed = "_" }, .{ .wait = 120 }, .{ .feed = "x" } }, &.{ esc, kt('_', NONE, "_"), ch('x') } },
        .{ "O2", &.{ .{ .feed = "\x1b" }, .{ .wait = 120 }, .{ .feed = "[" }, .{ .wait = 120 }, .{ .feed = "1" }, .{ .wait = 120 }, .{ .feed = "a" } }, &.{ esc, kt('[', NONE, "["), frag("1"), ch('a') } },
        .{ "O3", &.{ .{ .feed = "\x1b" }, .{ .wait = 120 }, .{ .feed = "]" }, .{ .wait = 120 }, .clear }, &.{ esc, kt(']', NONE, "]") } },
        .{ "O4", &.{ .{ .feed = "\x1b" }, .{ .wait = 120 }, .{ .feed = "]" }, .{ .wait = 5 }, .{ .feed = "11;" }, .{ .wait = 120 }, .clear }, &.{ esc, frag("\x1b]11;") } },
        // The check covers a string whose first byte came within 20 ms, or in the same read.
        .{ "W1", &.{ .{ .feed = "\x1b]" }, .{ .wait = 5 }, .{ .feed = "1" }, .{ .wait = 100 }, .{ .feed = "hello\r" } }, &([_]Expect{frag("\x1b]1")} ++ typed("hello\r")) },
        .{ "W2", &.{ .{ .feed = "\x1bP" }, .{ .wait = 5 }, .{ .feed = ">" }, .{ .wait = 100 }, .{ .feed = "abc" } }, &([_]Expect{frag("\x1bP>")} ++ typed("abc")) },
        .{ "W3", &.{ .{ .feed = "\x1b_" }, .{ .wait = 5 }, .{ .feed = "G" }, .{ .wait = 100 }, .{ .feed = "abc" } }, &([_]Expect{frag("\x1b_Ga")} ++ typed("bc")) },
        .{ "W4", &.{.{ .feed = "\x1b]1hello\r" }}, &([_]Expect{frag("\x1b]1")} ++ typed("hello\r")) },
        .{ "W5", &.{.{ .feed = "\x1bP>abc" }}, &([_]Expect{frag("\x1bP>")} ++ typed("abc")) },
        .{ "W6", &.{.{ .feed = "\x1b_Gabc" }}, &([_]Expect{frag("\x1b_Ga")} ++ typed("bc")) },
        // Two pauses, after the Escape and after the introducer, still leave the reply whole.
        .{ "K1[", &.{ .{ .feed = "\x1b" }, .{ .wait = 25 }, .{ .feed = "[" }, .{ .wait = 25 }, .{ .feed = "?62cj" } }, &.{ esc, reply(da1), ch('j') } },
        .{ "K1]", &.{ .{ .feed = "\x1b" }, .{ .wait = 25 }, .{ .feed = "]" }, .{ .wait = 25 }, .{ .feed = "11;rgb:0/0/0\x07j" } }, &.{ esc, reply("\x1b]11;rgb:0/0/0\x07"), ch('j') } },
        .{ "K1P", &.{ .{ .feed = "\x1b" }, .{ .wait = 25 }, .{ .feed = "P" }, .{ .wait = 25 }, .{ .feed = ">|k\x1b\\j" } }, &.{ esc, reply("\x1bP>|k\x1b\\"), ch('j') } },
        .{ "K1_", &.{ .{ .feed = "\x1b" }, .{ .wait = 25 }, .{ .feed = "_" }, .{ .wait = 25 }, .{ .feed = "Gi=1;OK\x1b\\j" } }, &.{ esc, reply("\x1b_Gi=1;OK\x1b\\"), ch('j') } },
    }) |case| {
        var harness = try Harness.create();
        defer harness.deinit();
        harness.parser.setExpectations(.{ .replies = true, .sentinel = true });
        for (case[1]) |step| _ = switch (step) {
            .feed => |bytes| try harness.feed(bytes),
            .wait => |milliseconds| try harness.wait(milliseconds),
            .clear => harness.parser.setExpectations(.{ .replies = true }),
        };
        harness.parser.setExpectations(.{ .replies = true });
        _ = try harness.wait(20);
        expectGot(case[0], case[2], harness.out.items) catch {
            failed += 1;
        };
    }
    try testing.expectEqual(@as(u32, 0), failed);
}

test "input parser recovers mouse reports after a timed-out Escape" {
    const Case = struct { []const []const u8, []const Expect };
    for ([_]Case{
        .{ &.{"[<64;38;15M"}, &.{Expect{ .kind = .mouse, .action = 5, .code = 0, .x = 37, .y = 14, .raw = "\x1b[<64;38;15M" }} },
        .{ &.{"[<35;20;5m"}, &.{mouse(.move, none, 19, 4, NONE)} },
        .{ &.{"[<0;10;5M"}, &.{down(0, 9, 4)} },
        .{ &.{ "[", "<35;20;5m" }, &.{mouse(.move, none, 19, 4, NONE)} },
        .{ &.{ "[M", " !!" }, &.{Expect{ .kind = .mouse, .action = 1, .code = 0, .raw = "\x1b[M !!" }} },
        .{ &.{"[<x"}, &.{ frag("[<"), ch('x') } },
        .{ &.{"[<0M"}, &.{frag("[<0M")} },
        .{ &.{"[<64;11;6m"}, &.{frag("[<64;11;6m")} },
        .{ &.{"[A"}, &.{ kt('[', NONE, "["), ch('A') } },
        .{ &.{"[M \x01"}, &.{ frag("[M "), k('a', CTRL) } },
        .{ &.{"q[<0;1;1M"}, &.{ ch('q'), ch('['), ch('<'), ch('0'), ch(';'), ch('1'), ch(';'), ch('1'), ch('M') } },
        .{ &.{"[<" ++ utils.repeat(u8, "1", 260)}, &([_]Expect{frag("[<" ++ utils.repeat(u8, "1", 253))} ++ @as([7]Expect, @splat(ch('1')))) },
        .{ &.{"[<35;"}, &.{} },
        .{ &.{"[<"}, &.{} },
    }) |case| {
        var harness = try Harness.create();
        defer harness.deinit();
        _ = try harness.feed("\x1b");
        try expectGot("", &.{k(K.escape, NONE)}, try harness.wait(20));
        try expectGot(case[0][0], case[1], try split(&harness, case[0]));
    }
    // A partial report then times out like any other unit, and so does a lone `[`.
    var harness = try Harness.create();
    defer harness.deinit();
    _ = try harness.feed("\x1b");
    _ = try harness.wait(20);
    try expectGot("", &.{}, try harness.feed("[<35;20"));
    try expectGot("", &.{frag("[<35;20")}, try harness.wait(20));
    try expectGot("", &.{ ch(';'), ch('5'), ch('m') }, try harness.feed(";5m"));
    _ = try harness.feed("\x1b");
    _ = try harness.wait(20);
    try expectGot("", &.{}, try harness.feed("[M "));
    try expectGot("", &.{frag("[M ")}, try harness.wait(20));
    _ = try harness.feed("\x1b");
    _ = try harness.wait(20);
    try expectGot("", &.{}, try harness.feed("["));
    try expectGot("", &.{}, try harness.wait(19));
    try expectGot("", &.{kr('[', NONE, "[")}, try harness.wait(1));
    // Without a timed-out Escape, `[<` is text.
    try check("[<35;20;5m", &.{ ch('['), ch('<'), ch('3'), ch('5'), ch(';'), ch('2'), ch('0'), ch(';'), ch('5'), ch('m') });
    // With SENTINEL an introducer and a byte that begin a reply resume it; other bytes are typed,
    // and a lone introducer is held like a bare one.
    const sentinel: ip.Expectations = .{ .replies = true, .sentinel = true };
    for ([_]struct { ip.Expectations, []const u8, []const Expect }{
        .{ sentinel, "]11;rgb:0/0/0\x07", &.{reply("\x1b]11;rgb:0/0/0\x07")} },
        .{ sentinel, "[24;80R", &.{report("\x1b[24;80R")} },
        .{ sentinel, "[<0;1;1M", &.{down(0, 0, 0)} },
        .{ sentinel, "[A", &.{ kt('[', NONE, "["), ch('A') } },
        .{ sentinel, "]x", &.{ kt(']', NONE, "]"), ch('x') } },
        .{ sentinel, "P+", &.{ kt('P', NONE, "P"), ch('+') } },
        .{ sentinel, "_g", &.{ kt('_', NONE, "_"), ch('g') } },
        .{ .{ .replies = true }, "[?", &.{ kt('[', NONE, "["), ch('?') } },
        .{ .{ .replies = true }, "]", &.{kt(']', NONE, "]")} },
        .{ .{ .replies = true }, "P", &.{kt('P', NONE, "P")} },
        .{ .{ .replies = true }, "_", &.{kt('_', NONE, "_")} },
        .{ .{ .replies = true }, "]1", &.{ kt(']', NONE, "]"), ch('1') } },
        .{ .{ .replies = true }, "P>", &.{ kt('P', NONE, "P"), ch('>') } },
    }) |case| {
        harness.parser.setExpectations(case[0]);
        _ = try harness.feed("\x1b");
        try expectGot("", &.{k(K.escape, NONE)}, try harness.wait(20));
        try expectGot(case[1], case[2], try harness.feed(case[1]));
    }
    harness.parser.setExpectations(sentinel);
    _ = try harness.feed("\x1b");
    _ = try harness.wait(20);
    try expectGot("", &.{}, try harness.feed("_"));
    try expectGot("", &.{}, try harness.wait(60_000));
    try expectGot("", &.{ kt('_', NONE, "_"), ch('x') }, try harness.feed("x"));
}

test "input parser stays split invariant" {
    for ([_][]const u8{
        "abc",                                                                                                                         "\x1b[A",                    "\x1bOP",               "\x1b[[A",           "\x1b[[5~",
        "\x1b[<0;10;20M",                                                                                                              "\x1b[M !!",                 "\x1b]4;0;#ffffff\x07", "\x1bP>|test\x1b\\", "\x1b_OK\x1b\\",
        "\x1b[200~hello\x1b[201~",                                                                                                     "\x1b[I",                    "\x1b[1;5A",            "\x1b[97u",          "\x1b[27;2;13~",
        "\x1b\x1b[A",                                                                                                                  "\x1b\x1ba\x1b\x1b[<0;1;1M", "\x1b[2$x\x1bOa\xe9x",  "\x1b[0;;104:105u",  "\x1b\xe4a\xffb",
        "\x1b[200~\x1b\x1b[20\x1b[201~",
        "x\x1b[<64;10;5M\x1b[I\x1b]4;0;#fff\x07\x1b[200~paste\x1b[201~👍",
        "\x1b[1;5A\x1b]10;rgb:1/2/3\x1b\\\x1b[<0;3;4M\x1b[200~x\x1b[201~\x1b[M !!\x1b\x1b[A\x1b[[A\x1b[2$\xe9x\x1b[0;;104:105u\x1bOa",
    }) |stream| try expectSplitInvariant(stream);
    const atoms = [_][]const u8{ "xy", "👍", "\x1b[A", "\x1b[<64;10;5M", "\x1b[M !!", "\x1b]4;0;#fff\x07", "\x1b[200~p\x1b[201~", "\x1b[97u", "\x1bé" };
    for (atoms) |first| for (atoms) |second| {
        const stream = try std.mem.concat(testing.allocator, u8, &.{ first, second });
        defer testing.allocator.free(stream);
        try expectSplitInvariant(stream);
    };
}

test "input parser timeouts split byte by byte reads like whole input" {
    const input = "\x1b[1;5A\x1b]10;rgb:1/2/3\x1b\\\x1b[<0;3;4M\x1b[200~x\x1b[201~\x1b[M !!\x1b\x1b[A\x1b[[A\x1b[2$\xe9x\x1b[0;;104:105u\x1bOa";
    var whole = try Harness.create();
    defer whole.deinit();
    _ = try whole.feed(input);
    var slow = try Harness.create();
    defer slow.deinit();
    // The timeout counts from each byte, so a unit can take far longer than it as a whole.
    for (0..input.len) |index| {
        _ = try slow.wait(19);
        _ = try slow.feed(input[index..][0..1]);
    }
    try testing.expect(gotEql(whole.out.items, slow.out.items));
    try testing.expectEqual(@as(usize, 12), whole.out.items.len);
}

/// A deterministic generator keeps the random tests reproducible.
fn next(seed: *u64) u64 {
    seed.* ^= seed.* << 13;
    seed.* ^= seed.* >> 7;
    seed.* ^= seed.* << 17;
    return seed.*;
}

/// Random bytes biased toward the bytes and fragments that start or shape sequences.
fn arbitraryBytes(allocator: std.mem.Allocator, seed: *u64, length: usize) ![]u8 {
    const fragments = [_][]const u8{
        "\x1b", "\x1b[", "\x1b[<", "\x1b[M", "\x1bO", "\x1b]", "\x1bP", "\x1b\\", "\x07", "\x1b[200~", "\x1b[201~", "\x1b\x1b[", "\x1b[?", "\xe4\xb8",
    };
    var bytes: std.ArrayList(u8) = .empty;
    errdefer bytes.deinit(allocator);
    while (bytes.items.len < length) {
        const value = next(seed);
        switch (value % 8) {
            0, 1 => try bytes.appendSlice(allocator, fragments[(value >> 8) % fragments.len]),
            2 => try bytes.append(allocator, ";:$<M[~u"[(value >> 8) % 8]),
            3 => try bytes.append(allocator, @as(u8, @intCast((value >> 8) % 10)) + '0'),
            else => try bytes.append(allocator, @truncate(value >> 16)),
        }
    }
    return bytes.toOwnedSlice(allocator);
}

test "input parser arbitrary bytes parse the same in any fragments" {
    var seed: u64 = 0x9e37_79b9_7f4a_7c15;
    const stream = try arbitraryBytes(testing.allocator, &seed, 64 * 1024);
    defer testing.allocator.free(stream);
    var whole = try Harness.create();
    defer whole.deinit();
    _ = try whole.feed(stream);
    _ = try whole.wait(20);
    var pieces = try Harness.create();
    defer pieces.deinit();
    var rest = stream;
    while (rest.len > 0) {
        const len = @min(next(&seed) % 9 + 1, rest.len);
        _ = try pieces.feed(rest[0..len]);
        rest = rest[len..];
    }
    _ = try pieces.wait(20);
    try testing.expect(gotEql(whole.out.items, pieces.out.items));
    // G5: the smallest sink that ABI callers may pass produces the same events.
    var small = try Harness.init(ip.events_per_byte_max, ip.payload_per_byte_max);
    defer small.deinit();
    _ = try small.feed(stream);
    _ = try small.wait(20);
    try testing.expect(gotEql(whole.out.items, small.out.items));
    try testing.expect(small.feeds > whole.feeds);
}

test "input parser accounts for every input byte" {
    var seed: u64 = 0x2545_f491_4f6c_dd1d;
    for (0..8) |_| {
        const stream = try arbitraryBytes(testing.allocator, &seed, 16 * 1024);
        defer testing.allocator.free(stream);
        var harness = try Harness.create();
        defer harness.deinit();
        _ = try harness.feed(stream);
        _ = try harness.wait(20);
        try testing.expectEqual(@as(u32, 0), harness.parser.discarded_count);
        // G3: raw spans, paste text and markers, and the pending unit cover the input.
        var total: usize = 0;
        for (harness.out.items) |got| {
            total += got.raw.len + got.text.len * @intFromBool(got.kind == .paste);
            if (got.kind == .paste) {
                if (got.flags & ip.flags.paste_start != 0) total += 6;
                if (got.flags & ip.flags.paste_end != 0) total += 6;
            }
        }
        const parser = harness.parser;
        total += switch (parser.state) {
            .ground, .expired => 0,
            .paste => |paste_state| paste_state.matched,
            .csi => |csi| parser.unit_len + @intFromBool(csi.alt),
            else => return error.TestUnexpectedResult,
        };
        try testing.expectEqual(stream.len, total);
    }
}

test "input parser arbitrary bytes with uneven time stay bounded" {
    var seed: u64 = 0x2545_f491_4f6c_dd1d;
    var harness = try Harness.init(ip.events_per_byte_max, ip.payload_per_byte_max);
    defer harness.deinit();
    for (0..4000) |_| {
        const chunk = try arbitraryBytes(testing.allocator, &seed, 64);
        defer testing.allocator.free(chunk);
        harness.now += (next(&seed) % 30) * ms;
        // SENTINEL implies REPLIES.
        const bits: u8 = @intCast(next(&seed) % 16);
        harness.parser.setExpectations(@bitCast(bits | bits >> 3));
        _ = try harness.feed(chunk);
        if (next(&seed) % 4 == 0) _ = try harness.wait(20);
        harness.out.clearRetainingCapacity();
        try testing.expect(harness.parser.unit_len <= ip.unit_bytes_max);
    }
}

test "input parser reaches every state" {
    const Tag = std.meta.Tag(@TypeOf(@as(ip.InputParser, .{}).state));
    var seen: std.EnumSet(Tag) = .empty;
    var harness = try Harness.create();
    defer harness.deinit();
    for ([_][]const u8{
        "a\xe4\xb8\xad", "\x1b\x1b", "\x1b[<0;1;1M", "\x1bOA", "\x1b[M !!", "\x1b]x\x1b\\", "\x1b[200~p\x1b[201~",
    }) |stream| {
        for (stream) |byte| {
            _ = try harness.feed(&.{byte});
            seen.insert(harness.parser.state);
        }
    }
    _ = try harness.feed("\x1b");
    _ = try harness.wait(20);
    seen.insert(harness.parser.state);
    for ("[<0;1;1M") |byte| {
        _ = try harness.feed(&.{byte});
        seen.insert(harness.parser.state);
    }
    _ = try harness.feed("\x1b[<0;1");
    _ = try harness.wait(20);
    seen.insert(harness.parser.state);
    const nines: [300]u8 = @splat('9');
    _ = try harness.feed("\x1b[");
    _ = try harness.feed(&nines);
    seen.insert(harness.parser.state);
    try testing.expectEqual(std.EnumSet(Tag).full, seen);
}

test "input parser reset drops the pending unit and X10 button, or keeps a reply" {
    var harness = try Harness.create();
    defer harness.deinit();
    harness.parser.setExpectations(.{ .kitty_keyboard = true });
    _ = try harness.feed("\x1b[M\"!!\x1b[97;");
    harness.parser.reset(false);
    try testing.expectEqual(null, harness.parser.deadlineNs());
    try expectGot("", &.{ ch('u'), mouse(.up, 0, 0, 0, NONE) }, try harness.feed("u\x1b[M#!!"));
    try testing.expect(harness.parser.expect.kitty_keyboard);
    // Keeping a reply keeps only a CSI unit shaped like one, deferred without a deadline.
    for ([_]struct { []const u8, []const u8, []const Expect }{
        .{ "\x1b[M\"!!\x1b\x1b[4;80", ";80t\x1b[M#!!", &.{ reply("\x1b[4;80;80t"), mouse(.up, 0, 0, 0, NONE) } },
        .{ "\x1b[4;80", "a", &.{ frag("\x1b[4;80"), ch('a') } },
        .{ "\x1b[?62", "c", &.{reply("\x1b[?62c")} },
        .{ "\x1b[24", ";1R", &.{ ch(';'), ch('1'), ch('R') } },
        .{ "\x1b[<35;10", "42x", &.{ ch('4'), ch('2'), ch('x') } },
        .{ "\x1b[200~half", "x", &.{ch('x')} },
        .{ "\x1b", "x", &.{ch('x')} },
    }) |case| {
        var kept = try Harness.create();
        defer kept.deinit();
        kept.parser.setExpectations(.{ .replies = true });
        _ = try kept.feed(case[0]);
        kept.parser.reset(true);
        try testing.expectEqual(null, kept.parser.deadlineNs());
        try expectGot(case[0], case[2], try kept.feed(case[1]));
    }
    // With SENTINEL a bare or numeric prefix is kept too, before and after it defers.
    for ([_]struct { []const u8, []const u8, []const Expect }{
        .{ "\x1b[", "?62c", &.{reply("\x1b[?62c")} },
        .{ "\x1b[24", ";80R", &.{report("\x1b[24;80R")} },
        .{ "\x1b[1", "5~", &.{ frag("\x1b[15"), ch('~') } },
    }) |case| for ([_]u64{ 0, 60_000 }) |pause| {
        var kept = try Harness.create();
        defer kept.deinit();
        kept.parser.setExpectations(.{ .replies = true, .sentinel = true });
        _ = try kept.feed(case[0]);
        _ = try kept.wait(pause);
        kept.parser.reset(true);
        try testing.expectEqual(null, kept.parser.deadlineNs());
        try expectGot(case[0], case[2], try kept.feed(case[1]));
    };
}

test "input parser sink stays within its per-byte bounds" {
    var events: [ip.events_per_byte_max]ip.Event = undefined;
    var payload: [ip.payload_per_byte_max]u8 = undefined;
    var sink: ip.Sink = .{ .events = &events, .payload = &payload };
    try testing.expect(sink.hasRoomForOneByte());
    var parser: ip.InputParser = .{};
    // A full sink consumes nothing, not even an expiry.
    sink.count = 1;
    _ = parser.feed("\x1b", start_ns, &sink);
    try testing.expectEqual(@as(u32, 0), parser.feed("a", start_ns, &sink));
    try testing.expectEqual(@as(u32, 1), sink.count);
    // The longest emission per byte: three fallback keys and the re-stepped byte.
    sink = .{ .events = &events, .payload = &payload };
    parser = .{};
    try testing.expectEqual(@as(u32, 4), parser.feed("\xf0\x9f\x98a", start_ns, &sink));
    try testing.expectEqual(@as(u32, 4), sink.count);
}

// Core's conformance vectors (packages/core/src/lib/stdin-parser.conformance.json): byte steps and
// the events Core reports for them, in the notation that the file's `format` field defines.
test "input parser passes Core's conformance vectors, whole and one byte at a time" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const file = try std.json.parseFromSliceLeaky(std.json.Value, allocator, @embedFile("input_conformance"), .{});
    const rows = file.object.get("rows").?.array.items;
    try testing.expect(rows.len > 0);
    // The notation's strings match JSON.stringify, here of the latin1 bytes 08 09 0a 0c 0d 01 7f 22 5c e9.
    var json: std.ArrayList(u8) = .empty;
    try appendJson(&json, allocator, "\x08\t\n\x0c\r\x01\x7f\"\\\xe9", true);
    try testing.expectEqualStrings("\"\\b\\t\\n\\f\\r\\u0001\x7f\\\"\\\\é\"", json.items);
    for (rows) |row| {
        const fields = row.array.items;
        // A step is one read; null is the Escape timeout passing.
        var whole: std.ArrayList(?[]const u8) = .empty;
        var bytewise: std.ArrayList(?[]const u8) = .empty;
        for (fields[1].array.items) |step| {
            const bytes: ?[]const u8 = switch (step) {
                .null => null,
                .string => |text| text,
                .array => |values| bytes: {
                    const bytes = try allocator.alloc(u8, values.items.len);
                    for (values.items, bytes) |value, *byte| byte.* = utils.unsigned(u8, value.integer);
                    break :bytes bytes;
                },
                else => return error.InvalidConformanceStep,
            };
            try whole.append(allocator, bytes);
            if (bytes) |read| {
                for (0..read.len) |index| try bytewise.append(allocator, read[index..][0..1]);
            } else try bytewise.append(allocator, null);
        }
        const expected = fields[2].array.items;
        // The parser state the row needs, set as stdin-parser-native.ts expectationFlags sets it.
        var expect: ip.Expectations = .{};
        if (fields.len > 4) {
            const context = fields[4].object;
            if (context.get("kitty")) |kitty| expect.kitty_keyboard = kitty.bool;
            if (context.get("pending")) |pending| for (pending.array.items) |query| {
                expect.replies = true;
                if (std.mem.eql(u8, query.string, "cpr")) {
                    expect.cursor_position = true;
                } else if (!std.mem.eql(u8, query.string, "pixel")) return error.UnknownConformanceQuery;
            };
        }
        for ([_][]const ?[]const u8{ whole.items, bytewise.items }) |steps| {
            const got = try conformanceRun(allocator, steps, expect);
            const same = got.len == expected.len and for (got, expected) |a, b| {
                if (!std.mem.eql(u8, a, b.string)) break false;
            } else true;
            if (!same) {
                std.debug.print("conformance row {s} ({d} steps):\n  expected:", .{ fields[0].string, steps.len });
                for (expected) |event| std.debug.print(" {s}", .{event.string});
                std.debug.print("\n  got:     ", .{});
                for (got) |event| std.debug.print(" {s}", .{event});
                std.debug.print("\n", .{});
                return error.TestUnexpectedResult;
            }
        }
    }
}

/// Feeds each step, then lets the timeout pass once more, and writes every event in notation.
fn conformanceRun(allocator: std.mem.Allocator, steps: []const ?[]const u8, expect: ip.Expectations) ![]const []const u8 {
    var harness = try Harness.create();
    defer harness.deinit();
    harness.parser.setExpectations(expect);
    const timeout_ms = ip.timeout_ns / ms;
    for (steps) |step| _ = if (step) |bytes| try harness.feed(bytes) else try harness.wait(timeout_ms);
    _ = try harness.wait(timeout_ms);
    var out: std.ArrayList([]const u8) = .empty;
    for (harness.out.items) |got| try out.append(allocator, try notation(allocator, got));
    return out.items;
}

/// Writes one event as Core reports it: the TypeScript adapter's names and button numbers
/// (stdin-parser-native.ts parsedKey and rawMouseEvent) for the fields the notation shows.
fn notation(allocator: std.mem.Allocator, got: Got) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    const modifiers: Mods = @bitCast(got.mods);
    switch (got.kind) {
        .key => {
            var shift = modifiers.shift;
            var scalar: [4]u8 = undefined;
            const name = if (got.code == 0) got.text else if (coreKeyName(got.code)) |core| core else name: {
                if (got.code >= K.functional_first and got.code <= K.functional_last) {
                    std.debug.print("no notation name for key code {d}; add Core's name to coreKeyName\n", .{got.code});
                    return error.UnnamedKey;
                }
                const len = try std.unicode.utf8Encode(@intCast(got.code), &scalar);
                // Core names a typed uppercase letter by its lowercase key with Shift; Alt keeps the case.
                if (got.flags & ip.flags.key_kitty == 0 and got.code >= 'A' and got.code <= 'Z') {
                    shift = true;
                    if (!modifiers.alt) scalar[0] += 'a' - 'A';
                }
                break :name scalar[0..len];
            };
            try out.appendSlice(allocator, "key(");
            try appendJson(&out, allocator, name, false);
            if (modifiers.ctrl) try out.appendSlice(allocator, " ctrl");
            if (modifiers.alt or modifiers.meta) try out.appendSlice(allocator, " meta");
            if (shift) try out.appendSlice(allocator, " shift");
            if (got.action == @backingInt(ip.KeyAction.release)) try out.appendSlice(allocator, " release");
            try out.append(allocator, ')');
        },
        .mouse => {
            const action: ip.MouseAction = @fromBackingInt(@intCast(got.action));
            const sgr = got.raw.len > 2 and got.raw[2] == '<';
            // Core: SGR motion and wheels without a button report 0, X10 motion -1.
            var button: i64 = got.code;
            if (got.code == ip.mouse_button_none) button = if (sgr) 0 else -1;
            if (action == .scroll and (!sgr or got.code == 3)) button = 0;
            try out.print(allocator, "mouse({s} {d},{d} b{d})", .{ @tagName(action), got.x, got.y, button });
        },
        .paste => {
            try testing.expect(got.flags & ip.flags.paste_end != 0);
            try out.appendSlice(allocator, "paste(");
            try appendJson(&out, allocator, got.text, false);
            try out.append(allocator, ')');
        },
        // Core reports focus as a response, and the renderer matches its raw bytes.
        .focus, .reply => {
            try out.appendSlice(allocator, "response(");
            try appendJson(&out, allocator, got.raw, true);
            try out.append(allocator, ')');
        },
    }
    return out.items;
}

/// Core's names (parse.keypress-kitty.ts kittyKeyMap) for the codes the vectors use.
fn coreKeyName(code: u32) ?[]const u8 {
    return switch (code) {
        ' ' => "space",
        K.escape => "escape",
        K.enter => "return",
        K.tab => "tab",
        K.backspace => "backspace",
        K.insert => "insert",
        K.delete => "delete",
        K.left => "left",
        K.right => "right",
        K.up => "up",
        K.down => "down",
        K.page_up => "pageup",
        K.page_down => "pagedown",
        K.home => "home",
        K.end => "end",
        K.f(1) => "f1",
        K.f(2) => "f2",
        K.f(3) => "f3",
        K.f(4) => "f4",
        else => null,
    };
}

/// Writes `text` as a JSON string the way JavaScript's JSON.stringify does: `"` and `\` escaped,
/// \b \t \n \f \r short, other C0 controls as lowercase \u00xx, and the rest literal. With
/// `latin1`, each byte is one code point, so bytes from 0x80 up are written as UTF-8.
fn appendJson(out: *std.ArrayList(u8), allocator: std.mem.Allocator, text: []const u8, latin1: bool) !void {
    try out.append(allocator, '"');
    for (text) |byte| switch (byte) {
        '"' => try out.appendSlice(allocator, "\\\""),
        '\\' => try out.appendSlice(allocator, "\\\\"),
        0x08 => try out.appendSlice(allocator, "\\b"),
        0x09 => try out.appendSlice(allocator, "\\t"),
        0x0a => try out.appendSlice(allocator, "\\n"),
        0x0c => try out.appendSlice(allocator, "\\f"),
        0x0d => try out.appendSlice(allocator, "\\r"),
        0x00...0x07, 0x0b, 0x0e...0x1f => try out.print(allocator, "\\u{x:0>4}", .{byte}),
        0x80...0xff => if (latin1) {
            try out.appendSlice(allocator, &.{ 0xc0 | byte >> 6, 0x80 | (byte & 0x3f) });
        } else try out.append(allocator, byte),
        else => try out.append(allocator, byte),
    };
    try out.append(allocator, '"');
}
