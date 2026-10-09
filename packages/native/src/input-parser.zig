//! Frames the terminal-to-application byte stream into key, mouse, paste, focus,
//! and reply events. Allocation-free and clock-free: the host passes the time with
//! every feed and calls again with zero bytes at `deadlineNs()`. See
//! docs/input-parser.md for the grammar, the state table, and the guarantees.
const std = @import("std");

pub const timeout_ns: u64 = 20 * std.time.ns_per_ms;
pub const unit_bytes_max: u16 = 4096;
pub const sequence_bytes_max: u16 = 256;
pub const key_text_bytes_max: u8 = 32;
pub const params_max: u8 = 16;
pub const subparams_max: u8 = 8;
pub const events_per_byte_max: u32 = 4;
pub const payload_per_byte_max: u32 = unit_bytes_max + sequence_bytes_max + key_text_bytes_max;

comptime {
    // A Kitty text field keeps at most subparams_max scalars, so key text never truncates by bytes.
    std.debug.assert(key_text_bytes_max >= @as(u32, subparams_max) * 4);
}

pub const Expectations = packed struct(u8) {
    replies: bool = false,
    kitty_keyboard: bool = false,
    _reserved: u6 = 0,
};

/// Kitty's modifier layout: the wire parameter minus one.
pub const Modifiers = packed struct(u8) {
    shift: bool = false,
    alt: bool = false,
    ctrl: bool = false,
    super: bool = false,
    hyper: bool = false,
    meta: bool = false,
    caps_lock: bool = false,
    num_lock: bool = false,

    fn with(self: Modifiers, other: Modifiers) Modifiers {
        return @bitCast(@as(u8, @bitCast(self)) | @as(u8, @bitCast(other)));
    }
};

pub const Kind = enum(u8) { key = 1, mouse = 2, paste = 3, focus = 4, reply = 5 };
pub const KeyAction = enum(u8) { press = 1, repeat = 2, release = 3 };
pub const MouseAction = enum(u8) { down = 1, up = 2, move = 3, drag = 4, scroll = 5 };
pub const Protocol = enum(u8) { csi = 1, ss3 = 2, osc = 3, dcs = 4, apc = 5 };

pub const flags = struct {
    pub const key_kitty: u8 = 1;
    pub const key_text_truncated: u8 = 2;
    pub const paste_start: u8 = 1;
    pub const paste_end: u8 = 2;
    pub const reply_fragment: u8 = 1;
    pub const reply_cursor_position: u8 = 2;
};

pub const mouse_button_none: u32 = 255;

/// Key codes are Unicode scalars. Functional keys use the Kitty keyboard protocol
/// assignments; Escape, Enter, Tab, and Backspace are their C0/DEL scalars.
pub const key = struct {
    pub const escape: u32 = 27;
    pub const enter: u32 = 13;
    pub const tab: u32 = 9;
    pub const backspace: u32 = 127;
    pub const insert: u32 = 57348;
    pub const delete: u32 = 57349;
    pub const left: u32 = 57350;
    pub const right: u32 = 57351;
    pub const up: u32 = 57352;
    pub const down: u32 = 57353;
    pub const page_up: u32 = 57354;
    pub const page_down: u32 = 57355;
    pub const home: u32 = 57356;
    pub const end: u32 = 57357;
    pub const menu: u32 = 57363;
    pub const f1: u32 = 57364;
    pub const kp_0: u32 = 57399;
    pub const kp_begin: u32 = 57427;
    pub const functional_first: u32 = 57344;
    pub const functional_last: u32 = 57454;

    pub fn f(number: u32) u32 {
        std.debug.assert(number >= 1 and number <= 35);
        return f1 + number - 1;
    }
};

/// Identical to ot_input_event. Written straight into the caller's records.
pub const Event = extern struct {
    kind: u8,
    action: u8,
    modifiers: u8,
    flags: u8,
    code: u32,
    base_code: u32,
    x: u16,
    y: u16,
    raw_offset: u32,
    raw_len: u32,
    text_offset: u32,
    text_len: u32,
};

const Span = struct { offset: u32, len: u32 };

/// Caller-owned records and payload bytes that one feed writes into. Spans in the
/// records index `payload` and stay valid until the caller reuses the sink.
pub const Sink = struct {
    events: []Event,
    payload: []u8,
    count: u32 = 0,
    payload_len: u32 = 0,

    pub fn hasRoomForOneByte(self: *const Sink) bool {
        return self.events.len - self.count >= events_per_byte_max and
            self.payload.len - self.payload_len >= payload_per_byte_max;
    }

    pub fn raw(self: *const Sink, record: Event) []const u8 {
        return self.payload[record.raw_offset..][0..record.raw_len];
    }

    pub fn text(self: *const Sink, record: Event) []const u8 {
        return self.payload[record.text_offset..][0..record.text_len];
    }

    fn copy(self: *Sink, parts: []const []const u8) Span {
        const offset = self.payload_len;
        for (parts) |part| {
            std.debug.assert(self.payload.len - self.payload_len >= part.len);
            @memcpy(self.payload[self.payload_len..][0..part.len], part);
            self.payload_len += @intCast(part.len);
        }
        return .{ .offset = offset, .len = self.payload_len - offset };
    }

    fn push(self: *Sink, event: Event) void {
        std.debug.assert(self.count < self.events.len);
        self.events[self.count] = event;
        self.count += 1;
    }

    /// The paste in progress, unless this sink has no records yet. Paste state writes only paste
    /// records, and it starts with a START record, so a nonempty sink ends with the open paste.
    fn openPaste(self: *Sink) ?*Event {
        if (self.count == 0) return null;
        const last = &self.events[self.count - 1];
        std.debug.assert(last.kind == @intFromEnum(Kind.paste) and last.flags & flags.paste_end == 0);
        return last;
    }

    fn startPaste(self: *Sink, start: bool) *Event {
        self.push(.{
            .kind = @intFromEnum(Kind.paste),
            .action = 0,
            .modifiers = 0,
            .flags = if (start) flags.paste_start else 0,
            .code = 0,
            .base_code = 0,
            .x = 0,
            .y = 0,
            .raw_offset = self.payload_len,
            .raw_len = 0,
            .text_offset = self.payload_len,
            .text_len = 0,
        });
        return &self.events[self.count - 1];
    }

    fn appendPaste(self: *Sink, bytes: []const u8) void {
        if (bytes.len == 0) return;
        const record = self.openPaste() orelse self.startPaste(false);
        // Nothing else writes payload while a paste record is open.
        std.debug.assert(record.text_offset + record.text_len == self.payload_len);
        _ = self.copy(&.{bytes});
        record.text_len += @intCast(bytes.len);
    }

    fn endPaste(self: *Sink) void {
        const record = self.openPaste() orelse self.startPaste(false);
        record.flags |= flags.paste_end;
    }
};

const State = union(enum) {
    ground,
    /// Ground right after a lone Escape timed out; a `[` may continue a mouse report.
    expired,
    utf8: struct { expected: u3, alt: bool },
    escape: struct { alt: bool },
    recover,
    recover_sgr,
    /// `deferred`: timed out on a prefix that may still be a mouse report, a Kitty
    /// key, or an awaited reply. It waits without a deadline (docs §6.6).
    csi: struct { alt: bool, deferred: bool },
    ss3: struct { alt: bool },
    /// `recovered`: the unit's ESC was reinstated after a timed-out Escape key.
    x10: struct { alt: bool, recovered: bool },
    /// `kind` is `.osc`, `.dcs`, or `.apc`.
    string: struct { kind: Protocol, escaped: bool },
    /// `osc`: BEL also ends the discarded string, as it ends only OSC.
    discard: struct { string: bool, escaped: bool, osc: bool },
    paste: struct { matched: u3 },
};

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
const paste_end_marker = "\x1b[201~";

pub const InputParser = struct {
    state: State = .ground,
    expect: Expectations = .{},
    unit: [unit_bytes_max]u8 = undefined,
    unit_len: u16 = 0,
    /// Arrival time of the last byte of the pending unit.
    since_ns: u64 = 0,
    x10_button: u8 = 0,
    discarded_count: u32 = 0,

    /// Parses bytes that arrived at now_ns and returns how many it consumed; it
    /// stops when the sink cannot hold one more byte's events. Zero bytes only
    /// expires. now_ns must not go backwards (the caller checks).
    pub fn feed(self: *InputParser, bytes: []const u8, now_ns: u64, sink: *Sink) u32 {
        std.debug.assert(bytes.len <= std.math.maxInt(u32));
        if (!sink.hasRoomForOneByte()) return 0;
        // A new batch never extends a unit whose deadline already passed.
        self.expire(now_ns, sink);
        var consumed: usize = 0;
        while (consumed < bytes.len) {
            if (!sink.hasRoomForOneByte()) break;
            const run = self.pasteRun(bytes[consumed..], sink);
            if (run > 0) {
                sink.appendPaste(bytes[consumed..][0..run]);
                consumed += run;
                continue;
            }
            const count_before = sink.count;
            const payload_before = sink.payload_len;
            self.step(bytes[consumed], sink);
            std.debug.assert(sink.count - count_before <= events_per_byte_max);
            std.debug.assert(sink.payload_len - payload_before <= payload_per_byte_max);
            consumed += 1;
        }
        if (consumed > 0) self.since_ns = now_ns;
        self.assertValid();
        return @intCast(consumed);
    }

    /// When the host should call feed with zero bytes, or null.
    pub fn deadlineNs(self: *const InputParser) ?u64 {
        const waits = switch (self.state) {
            .ground, .expired, .paste => false,
            .csi => |csi| !csi.deferred or !self.deferrable(),
            else => true,
        };
        return if (waits) self.since_ns +| timeout_ns else null;
    }

    /// Changes expectations without emitting; the next feed re-evaluates a deferred unit.
    pub fn setExpectations(self: *InputParser, expect: Expectations) void {
        std.debug.assert(expect._reserved == 0);
        self.expect = expect;
    }

    /// Drops the pending unit and mouse state; keeps expectations.
    pub fn reset(self: *InputParser) void {
        self.state = .ground;
        self.unit_len = 0;
        self.x10_button = 0;
    }

    fn assertValid(self: *const InputParser) void {
        std.debug.assert(self.unit_len <= unit_bytes_max);
        switch (self.state) {
            .utf8 => |utf8| std.debug.assert(utf8.expected >= 2 and utf8.expected <= 4 and self.unit_len < utf8.expected),
            .csi, .ss3 => std.debug.assert(self.unit_len >= 2 and self.unit_len <= sequence_bytes_max),
            .x10 => std.debug.assert(self.unit_len >= 3 and self.unit_len < 6),
            .recover_sgr => std.debug.assert(self.unit_len >= 3 and self.unit_len <= sequence_bytes_max),
            .string => |string| std.debug.assert(self.unit_len >= @as(u16, 2) + @intFromBool(string.escaped)),
            .paste => |paste| std.debug.assert(paste.matched < paste_end_marker.len),
            .ground, .expired, .escape, .recover, .discard => {},
        }
    }

    /// Paste bytes that contain no ESC go straight into the open record.
    fn pasteRun(self: *const InputParser, bytes: []const u8, sink: *const Sink) usize {
        switch (self.state) {
            .paste => |paste| if (paste.matched != 0) return 0,
            else => return 0,
        }
        const run = std.mem.indexOfScalar(u8, bytes, ESC) orelse bytes.len;
        const room = sink.payload.len - sink.payload_len - payload_per_byte_max;
        return @min(run, room);
    }

    fn expire(self: *InputParser, now_ns: u64, sink: *Sink) void {
        const deadline = self.deadlineNs() orelse return;
        if (now_ns < deadline) return;
        switch (self.state) {
            .escape => |esc| {
                if (esc.alt) {
                    emitKey(sink, &.{"\x1b\x1b"}, key.escape, .{ .alt = true }, .{});
                    self.state = .ground;
                } else {
                    emitKey(sink, &.{"\x1b"}, key.escape, .{}, .{});
                    self.state = .expired;
                }
            },
            .recover => {
                emitKey(sink, &.{"["}, '[', .{}, .{ .text = "[" });
                self.state = .ground;
            },
            .recover_sgr => {
                self.state = .ground;
                emitReply(sink, self.unit[1..self.unit_len], .csi, flags.reply_fragment);
            },
            .utf8 => |utf8| self.utf8Fallback(utf8.alt, sink),
            .csi => |csi| {
                if (!csi.deferred and self.deferrable()) {
                    self.state = .{ .csi = .{ .alt = csi.alt, .deferred = true } };
                } else self.cutShort(csi.alt, .csi, 0, sink);
            },
            .ss3 => |ss3| self.cutShort(ss3.alt, .ss3, 0, sink),
            .x10 => |x10| self.cutShort(x10.alt, .csi, @intFromBool(x10.recovered), sink),
            .string => |string| {
                self.state = .ground;
                emitReply(sink, self.unit[0..self.unit_len], string.kind, flags.reply_fragment);
            },
            // After 20 ms of silence the rest of the garbage is more likely typing.
            .discard => self.state = .ground,
            .ground, .expired, .paste => unreachable,
        }
    }

    fn step(self: *InputParser, byte: u8, sink: *Sink) void {
        var pending: ?u8 = byte;
        var iterations: u8 = 0;
        while (pending) |b| {
            pending = null;
            iterations += 1;
            std.debug.assert(iterations <= 3);
            switch (self.state) {
                .ground => self.ground(b, false, .of(false, b), sink),
                .expired => if (b == '[') {
                    self.state = .recover;
                } else {
                    self.state = .ground;
                    pending = b;
                },
                .utf8 => |utf8| if (b & 0xc0 == 0x80) {
                    self.append(b);
                    if (self.unit_len == utf8.expected) self.utf8Complete(utf8.alt, sink);
                } else {
                    self.utf8Fallback(utf8.alt, sink);
                    pending = b;
                },
                .escape => |esc| pending = self.escapeByte(b, esc.alt, sink),
                .recover => switch (b) {
                    '<' => {
                        self.begin(.recover_sgr, '[');
                        self.append(b);
                    },
                    'M' => {
                        self.begin(.{ .x10 = .{ .alt = false, .recovered = true } }, '[');
                        self.append(b);
                    },
                    else => {
                        self.state = .ground;
                        emitKey(sink, &.{"["}, '[', .{}, .{ .text = "[" });
                        pending = b;
                    },
                },
                .recover_sgr => pending = self.recoverSgrByte(b, sink),
                .csi => |csi| if (csi.deferred) {
                    if (self.continuesDeferred(b)) {
                        self.state = .{ .csi = .{ .alt = csi.alt, .deferred = false } };
                    } else self.cutShort(csi.alt, .csi, 0, sink);
                    pending = b;
                } else self.sequenceByte(b, csi.alt, true, sink),
                .ss3 => |ss3| self.sequenceByte(b, ss3.alt, false, sink),
                .x10 => |x10| if (b >= 0x01 and b <= 0x1f) {
                    // Payload bytes are offset by 32 and 0 is xterm's past-end marker,
                    // so another control byte means the report was cut short.
                    self.cutShort(x10.alt, .csi, @intFromBool(x10.recovered), sink);
                    self.ground(b, false, .of(false, b), sink);
                } else {
                    self.append(b);
                    if (self.unit_len == 6) {
                        self.state = .ground;
                        self.dispatchX10(x10.alt, sink);
                    }
                },
                .string => |string| pending = self.stringByte(b, string.kind, string.escaped, sink),
                .discard => |discard| pending = self.discardByte(b, discard),
                .paste => |paste| self.pasteByte(b, paste.matched, sink),
            }
        }
    }

    fn ground(self: *InputParser, b: u8, alt: bool, wire: Wire, sink: *Sink) void {
        const mods: Modifiers = .{ .alt = alt };
        const ctrl: Modifiers = .{ .alt = alt, .ctrl = true };
        const raw: []const []const u8 = &.{wire.slice()};
        switch (b) {
            ESC => {
                std.debug.assert(!alt);
                self.escape();
            },
            '\r', '\n' => emitKey(sink, raw, key.enter, mods, .{}),
            '\t' => emitKey(sink, raw, key.tab, mods, .{}),
            0x7f, 0x08 => emitKey(sink, raw, key.backspace, mods, .{}),
            0x00 => emitKey(sink, raw, ' ', ctrl, .{}),
            0x01...0x07, 0x0b, 0x0c, 0x0e...0x1a => emitKey(sink, raw, 'a' + @as(u32, b) - 1, ctrl, .{}),
            0x1c...0x1f => emitKey(sink, raw, '\\' + @as(u32, b) - 0x1c, ctrl, .{}),
            0x20...0x7e => emitKey(sink, raw, b, mods, .{ .text = if (alt) "" else wire.slice() }),
            0xc2...0xdf => self.beginUtf8(b, 2, alt),
            0xe0...0xef => self.beginUtf8(b, 3, alt),
            0xf0...0xf4 => self.beginUtf8(b, 4, alt),
            else => self.eightBit(b, wire, sink),
        }
    }

    /// A byte that is not UTF-8: terminals that set the eighth bit for Alt send Alt+ASCII so.
    fn eightBit(self: *InputParser, b: u8, wire: Wire, sink: *Sink) void {
        const ascii = b & 0x7f;
        if (ascii == ESC) return emitKey(sink, &.{wire.slice()}, key.escape, .{ .alt = true }, .{});
        self.ground(ascii, true, wire, sink);
    }

    fn beginUtf8(self: *InputParser, lead: u8, expected: u3, alt: bool) void {
        self.unit[0] = lead;
        self.unit_len = 1;
        self.state = .{ .utf8 = .{ .expected = expected, .alt = alt } };
    }

    fn utf8Complete(self: *InputParser, alt: bool, sink: *Sink) void {
        self.state = .ground;
        const bytes = self.unit[0..self.unit_len];
        const scalar: u21 = std.unicode.utf8Decode(bytes) catch std.unicode.replacement_character;
        var buffer: [4]u8 = undefined;
        const text = if (alt) "" else utf8Encode(scalar, &buffer);
        emitKey(sink, if (alt) &.{ "\x1b", bytes } else &.{bytes}, scalar, .{ .alt = alt }, .{ .text = text });
    }

    /// Not UTF-8 after all: every buffered byte is an eight-bit Alt key.
    fn utf8Fallback(self: *InputParser, alt: bool, sink: *Sink) void {
        self.state = .ground;
        const len = self.unit_len;
        self.unit_len = 0;
        // Each byte decodes to one key without touching the unit buffer.
        for (self.unit[0..len], 0..) |b, index| self.eightBit(b, .of(alt and index == 0, b), sink);
    }

    fn escapeByte(self: *InputParser, b: u8, alt: bool, sink: *Sink) ?u8 {
        if (alt) {
            // Only key sequences take the `ESC ESC` prefix; otherwise the first Escape is a key.
            switch (b) {
                '[' => self.begin(.{ .csi = .{ .alt = true, .deferred = false } }, b),
                'O' => self.begin(.{ .ss3 = .{ .alt = true } }, b),
                ESC => emitKey(sink, &.{"\x1b"}, key.escape, .{}, .{}),
                else => {
                    emitKey(sink, &.{"\x1b"}, key.escape, .{}, .{});
                    self.state = .{ .escape = .{ .alt = false } };
                    return b;
                },
            }
            return null;
        }
        switch (b) {
            '[' => self.begin(.{ .csi = .{ .alt = false, .deferred = false } }, b),
            'O' => self.begin(.{ .ss3 = .{ .alt = false } }, b),
            ESC => self.state = .{ .escape = .{ .alt = true } },
            ']' => self.begin(.{ .string = .{ .kind = .osc, .escaped = false } }, b),
            'P' => self.begin(.{ .string = .{ .kind = .dcs, .escaped = false } }, b),
            '_' => self.begin(.{ .string = .{ .kind = .apc, .escaped = false } }, b),
            // Terminal.app's old Option+Left and Option+Right.
            'B', 'F' => {
                self.state = .ground;
                const wire = Wire.of(true, b);
                emitKey(sink, &.{wire.slice()}, if (b == 'B') key.left else key.right, .{ .alt = true }, .{});
            },
            else => {
                self.state = .ground;
                self.ground(b, true, .of(true, b), sink);
            },
        }
        return null;
    }

    fn recoverSgrByte(self: *InputParser, b: u8, sink: *Sink) ?u8 {
        switch (b) {
            '0'...'9', ';' => if (self.unit_len < sequence_bytes_max) {
                self.append(b);
                return null;
            },
            'M', 'm' => {
                self.state = .ground;
                self.append(b);
                const unit = self.unit[0..self.unit_len];
                if (sgrMouse(unit[3 .. unit.len - 1], b == 'M')) |mouse| {
                    emitMouse(sink, unit, mouse);
                } else emitReply(sink, unit[1..], .csi, flags.reply_fragment);
                return null;
            },
            else => {},
        }
        // Recovery replies omit the reinstated ESC: raw bytes are reported as received.
        self.state = .ground;
        emitReply(sink, self.unit[1..self.unit_len], .csi, flags.reply_fragment);
        return b;
    }

    fn sequenceByte(self: *InputParser, b: u8, alt: bool, csi: bool, sink: *Sink) void {
        const protocol: Protocol = if (csi) .csi else .ss3;
        if (b == ESC) {
            self.cutShort(alt, protocol, 0, sink);
            self.escape();
        } else if (b < 0x20 or b == 0x7f) {
            // A control byte cannot continue a sequence: report the fragment and type the byte.
            self.cutShort(alt, protocol, 0, sink);
            self.ground(b, false, .of(false, b), sink);
        } else if (csi and self.unit_len == 2 and b == 'M') {
            self.append(b);
            self.state = .{ .x10 = .{ .alt = alt, .recovered = false } };
        } else if (csi and self.unit_len == 2 and b == '[') {
            // The Linux console sends F1 through F5 as `ESC [ [ A` through `ESC [ [ E`.
            self.append(b);
        } else if ((b >= 0x40 and b <= 0x7e) or (csi and b == '$' and self.unit_len > 2 and allDigits(self.unit[2..self.unit_len]))) {
            // rxvt ends Shift+Insert and similar keys with `$`, which is otherwise an intermediate.
            self.append(b);
            self.state = .ground;
            if (csi) self.dispatchCsi(alt, sink) else self.dispatchSs3(alt, sink);
        } else if (self.unit_len >= sequence_bytes_max) {
            self.state = .{ .discard = .{ .string = false, .escaped = false, .osc = false } };
            self.discarded_count +|= 1;
        } else self.append(b);
    }

    fn stringByte(self: *InputParser, b: u8, kind: Protocol, escaped: bool, sink: *Sink) ?u8 {
        if (escaped) {
            if (b == '\\') {
                self.append(b);
                self.state = .ground;
                emitReply(sink, self.unit[0..self.unit_len], kind, 0);
                return null;
            }
            // The Escape starts a new unit: report the unterminated string without it.
            self.unit_len -= 1;
            emitReply(sink, self.unit[0..self.unit_len], kind, flags.reply_fragment);
            self.escape();
            return b;
        }
        if (b == BEL and kind == .osc) {
            // BEL ends only OSC; in DCS and APC it is payload.
            self.state = .ground;
            if (self.unit_len < unit_bytes_max) {
                self.append(b);
                emitReply(sink, self.unit[0..self.unit_len], .osc, 0);
            } else self.discarded_count +|= 1;
        } else if (b == ESC) {
            // Keep room for the `\` that may complete the terminator.
            if (self.unit_len + 2 <= unit_bytes_max) {
                self.append(b);
                self.state = .{ .string = .{ .kind = kind, .escaped = true } };
            } else {
                self.state = .{ .discard = .{ .string = true, .escaped = true, .osc = kind == .osc } };
                self.discarded_count +|= 1;
            }
        } else if (self.unit_len >= unit_bytes_max) {
            self.state = .{ .discard = .{ .string = true, .escaped = false, .osc = kind == .osc } };
            self.discarded_count +|= 1;
        } else self.append(b);
        return null;
    }

    fn discardByte(self: *InputParser, b: u8, discard: @FieldType(State, "discard")) ?u8 {
        if (!discard.string) {
            if (b == ESC) {
                self.escape();
            } else if (b >= 0x40 and b <= 0x7e) self.state = .ground;
            return null;
        }
        if (discard.escaped) {
            if (b == '\\') {
                self.state = .ground;
                return null;
            }
            self.escape();
            return b;
        }
        if (b == BEL and discard.osc) {
            self.state = .ground;
        } else if (b == ESC) {
            self.state = .{ .discard = .{ .string = true, .escaped = true, .osc = discard.osc } };
        }
        return null;
    }

    fn pasteByte(self: *InputParser, b: u8, matched: u3, sink: *Sink) void {
        // The payload is opaque: only the exact end marker ends it.
        if (b == paste_end_marker[matched]) {
            if (matched + 1 == paste_end_marker.len) {
                sink.endPaste();
                self.state = .ground;
            } else self.state = .{ .paste = .{ .matched = matched + 1 } };
            return;
        }
        sink.appendPaste(paste_end_marker[0..matched]);
        if (b == ESC) {
            self.state = .{ .paste = .{ .matched = 1 } };
        } else {
            sink.appendPaste(&.{b});
            self.state = .{ .paste = .{ .matched = 0 } };
        }
    }

    fn append(self: *InputParser, byte: u8) void {
        std.debug.assert(self.unit_len < unit_bytes_max);
        self.unit[self.unit_len] = byte;
        self.unit_len += 1;
    }

    fn begin(self: *InputParser, state: State, introducer: u8) void {
        self.unit[0] = ESC;
        self.unit[1] = introducer;
        self.unit_len = 2;
        self.state = state;
    }

    fn escape(self: *InputParser) void {
        self.unit_len = 0;
        self.state = .{ .escape = .{ .alt = false } };
    }

    /// Reports a unit ended by something other than its terminator as a fragment, from `start`
    /// (1 skips an ESC that recovery reinstated). After `ESC ESC`, the first Escape is a key.
    fn cutShort(self: *InputParser, alt: bool, protocol: Protocol, start: u16, sink: *Sink) void {
        self.state = .ground;
        if (alt) emitKey(sink, &.{"\x1b"}, key.escape, .{}, .{});
        emitReply(sink, self.unit[start..self.unit_len], protocol, flags.reply_fragment);
    }

    fn dispatchCsi(self: *InputParser, alt: bool, sink: *Sink) void {
        const unit = self.unit[0..self.unit_len];
        const params = unit[2 .. unit.len - 1];
        const final = unit[unit.len - 1];
        if (final == '~' and std.mem.eql(u8, params, "200")) {
            if (alt) emitKey(sink, &.{"\x1b"}, key.escape, .{}, .{});
            self.state = .{ .paste = .{ .matched = 0 } };
            _ = sink.startPaste(true);
            return;
        }
        if (params.len == 0 and (final == 'I' or final == 'O')) {
            if (alt) emitKey(sink, &.{"\x1b"}, key.escape, .{}, .{});
            const span = sink.copy(&.{unit});
            sink.push(makeEvent(.focus, @intFromBool(final == 'I'), .{}, 0, span, .{ .offset = sink.payload_len, .len = 0 }));
            return;
        }
        if (params.len > 0 and params[0] == '<') {
            const mouse = if (final == 'M' or final == 'm') sgrMouse(params[1..], final == 'M') else null;
            if (alt) emitKey(sink, &.{"\x1b"}, key.escape, .{}, .{});
            if (mouse) |value| return emitMouse(sink, unit, value);
            return emitReply(sink, unit, .csi, 0);
        }
        var cursor_report = false;
        const decoded: ?Key = decoded: {
            if (params.len > 0 and params[0] == '[') break :decoded bracketKey(params[1..], final);
            // Private-prefixed and intermediate-bearing sequences are never keys.
            const fields = Fields.parse(params) orelse break :decoded null;
            cursor_report = final == 'R' and fields.count == 2 and fields.single(0) != null and fields.single(1) != null;
            break :decoded self.csiKey(&fields, final);
        };
        if (decoded) |value| return emitDecodedKey(sink, alt, unit, value);
        if (alt) emitKey(sink, &.{"\x1b"}, key.escape, .{}, .{});
        emitReply(sink, unit, .csi, if (cursor_report) flags.reply_cursor_position else 0);
    }

    fn csiKey(self: *const InputParser, fields: *const Fields, final: u8) ?Key {
        return switch (final) {
            'u' => kittyKey(fields),
            '~' => tildeKey(fields),
            // rxvt marks Shift, Ctrl, and both with `$`, `^`, and `@` in place of `~`.
            '$', '^', '@' => if (fields.count == 1) rxvt: {
                var value = tildeKey(fields) orelse break :rxvt null;
                value.mods = switch (final) {
                    '$' => .{ .shift = true },
                    '^' => .{ .ctrl = true },
                    else => .{ .shift = true, .ctrl = true },
                };
                break :rxvt value;
            } else null,
            // Cursor position reports share this form: F3 needs modifiers and no awaited replies.
            'R' => if (!self.expect.replies and fields.count == 2 and fields.single(0) == 1 and
                fields.single(1) != null and fields.single(1).? > 1)
                .{ .code = key.f(3), .mods = modsFromParam(fields.single(1).?) }
            else
                null,
            'A'...'H', 'P', 'Q', 'S', 'Z', 'a'...'e' => letterKey(final, fields),
            else => null,
        };
    }

    fn dispatchSs3(self: *InputParser, alt: bool, sink: *Sink) void {
        const unit = self.unit[0..self.unit_len];
        if (ss3Key(unit[unit.len - 1], unit[2 .. unit.len - 1])) |value| return emitDecodedKey(sink, alt, unit, value);
        if (alt) emitKey(sink, &.{"\x1b"}, key.escape, .{}, .{});
        emitReply(sink, unit, .ss3, 0);
    }

    fn dispatchX10(self: *InputParser, alt: bool, sink: *Sink) void {
        const unit = self.unit[0..self.unit_len];
        std.debug.assert(unit.len == 6);
        const code: u32 = unit[3] -% 32;
        var mouse = if (code & 0xe3 == 3)
            // X10 reports every release as button 3: assume the last one pressed.
            Mouse{ .action = .up, .button = self.x10_button }
        else
            // Only a press of button 3 without motion, wheel, or extra bits has no event.
            mouseKind(code, false).?;
        if (mouse.action == .down) self.x10_button = @intCast(mouse.button);
        mouse.mods = mouseModifiers(code);
        // Coordinates are one-based after the offset; xterm's 0 wraps to cell 223.
        mouse.x = unit[4] -% 33;
        mouse.y = unit[5] -% 33;
        if (alt) emitKey(sink, &.{"\x1b"}, key.escape, .{}, .{});
        emitMouse(sink, unit, mouse);
    }

    /// Whether a timed-out CSI may still be a mouse report, a Kitty key, or an awaited
    /// reply, which slow links can split (docs §6.6).
    fn deferrable(self: *const InputParser) bool {
        const params = self.unit[2..self.unit_len];
        if (params.len == 0) return false;
        return switch (params[0]) {
            '<' => allOf(params[1..], "0123456789;"),
            '?' => self.expect.replies and allOf(params[1..], "0123456789;$"),
            else => {
                const shape = Shape.of(params, self.expect.kitty_keyboard) orelse return false;
                return self.expect.kitty_keyboard or
                    (self.expect.replies and (shape.semicolons == 1 or (shape.semicolons == 2 and shape.first == 4)));
            },
        };
    }

    /// Whether `b` continues a deferred CSI. Final bytes count only where they complete it.
    fn continuesDeferred(self: *const InputParser, b: u8) bool {
        const params = self.unit[2..self.unit_len];
        std.debug.assert(params.len > 0);
        const digit = isDigit(b);
        // Whether the field being read has a digit; a mode report's `$` follows its digits.
        const field = std.mem.trimEnd(u8, params, "$");
        const has_digit = isDigit(field[field.len - 1]);
        switch (params[0]) {
            '<' => return digit or b == ';' or b == 'M' or b == 'm',
            '?' => {
                if (digit or b == ';' or b == '$') return true;
                if (std.mem.indexOfScalar(u8, params, '$') != null) return has_digit and b == 'y';
                return switch (b) {
                    'c' => has_digit or std.mem.indexOfScalar(u8, params, ';') != null,
                    'n', 'u' => has_digit,
                    else => false,
                };
            },
            else => {
                const kitty = self.expect.kitty_keyboard;
                const shape = Shape.of(params, kitty) orelse return false;
                if (digit or b == ':' or b == ';') return true;
                if (!has_digit) return false;
                const kitty_final = b == 'u' or (shape.semicolons == 1 and shape.segments > 1 and (b == '~' or (b >= 'A' and b <= 'Z')));
                const reply_final = (shape.semicolons == 1 and b == 'R') or (shape.semicolons == 2 and shape.first == 4 and b == 't');
                return (kitty and kitty_final) or (self.expect.replies and reply_final);
            },
        }
    }
};

/// The wire bytes of a one-byte key, with the ESC of an Alt prefix.
const Wire = struct {
    bytes: [2]u8,
    len: u8,

    fn of(escaped: bool, byte: u8) Wire {
        return if (escaped) .{ .bytes = .{ ESC, byte }, .len = 2 } else .{ .bytes = .{ byte, 0 }, .len = 1 };
    }

    fn slice(self: *const Wire) []const u8 {
        return self.bytes[0..self.len];
    }
};

fn makeEvent(kind: Kind, action: u8, modifiers: Modifiers, code: u32, raw: Span, text: Span) Event {
    return .{
        .kind = @intFromEnum(kind),
        .action = action,
        .modifiers = @bitCast(modifiers),
        .flags = 0,
        .code = code,
        .base_code = 0,
        .x = 0,
        .y = 0,
        .raw_offset = raw.offset,
        .raw_len = raw.len,
        .text_offset = text.offset,
        .text_len = text.len,
    };
}

const KeyOptions = struct {
    action: KeyAction = .press,
    flags: u8 = 0,
    base: u32 = 0,
    text: []const u8 = "",
};

fn emitKey(sink: *Sink, raw: []const []const u8, code: u32, mods: Modifiers, options: KeyOptions) void {
    const raw_span = sink.copy(raw);
    const text_span = sink.copy(&.{options.text});
    var value = makeEvent(.key, @intFromEnum(options.action), mods, code, raw_span, text_span);
    value.flags = options.flags;
    value.base_code = options.base;
    sink.push(value);
}

fn emitDecodedKey(sink: *Sink, alt: bool, unit: []const u8, value: Key) void {
    emitKey(sink, if (alt) &.{ "\x1b", unit } else &.{unit}, value.code, value.mods.with(.{ .alt = alt }), .{
        .action = value.action,
        .flags = value.flags,
        .base = value.base,
        .text = value.text.slice(),
    });
}

fn emitReply(sink: *Sink, raw: []const u8, protocol: Protocol, reply_flags: u8) void {
    const span = sink.copy(&.{raw});
    var value = makeEvent(.reply, 0, .{}, @intFromEnum(protocol), span, .{ .offset = sink.payload_len, .len = 0 });
    value.flags = reply_flags;
    sink.push(value);
}

fn emitMouse(sink: *Sink, raw: []const u8, mouse: Mouse) void {
    const span = sink.copy(&.{raw});
    var value = makeEvent(.mouse, @intFromEnum(mouse.action), mouse.mods, mouse.button, span, .{ .offset = sink.payload_len, .len = 0 });
    value.x = mouse.x;
    value.y = mouse.y;
    sink.push(value);
}

/// Text an editor inserts for a key, at most key_text_bytes_max bytes.
const Text = struct {
    bytes: [key_text_bytes_max]u8 = undefined,
    len: u8 = 0,

    fn slice(self: *const Text) []const u8 {
        return self.bytes[0..self.len];
    }

    fn append(self: *Text, scalar: u21) void {
        var buffer: [4]u8 = undefined;
        const encoded = utf8Encode(scalar, &buffer);
        @memcpy(self.bytes[self.len..][0..encoded.len], encoded);
        self.len += @intCast(encoded.len);
    }
};

const Key = struct {
    code: u32,
    mods: Modifiers = .{},
    action: KeyAction = .press,
    flags: u8 = 0,
    base: u32 = 0,
    text: Text = .{},
};

const Mouse = struct {
    action: MouseAction,
    button: u32,
    x: u16 = 0,
    y: u16 = 0,
    mods: Modifiers = .{},
};

/// Numeric CSI parameters: up to params_max `;` fields of up to subparams_max `:`
/// subfields. Extra fields and subfields are ignored. Values saturate.
const Fields = struct {
    values: [params_max][subparams_max]u32 = undefined,
    present: [params_max]u8 = @splat(0),
    subcounts: [params_max]u8 = @splat(0),
    /// Fields with subfields past subparams_max.
    overflow: u16 = 0,
    count: u8 = 0,

    /// Null when the bytes are not only digits, `;`, and `:`.
    fn parse(params: []const u8) ?Fields {
        var fields: Fields = .{};
        if (params.len == 0) return fields;
        var field: usize = 0;
        var sub: usize = 0;
        fields.count = 1;
        fields.subcounts[0] = 1;
        for (params) |b| switch (b) {
            '0'...'9' => if (field < params_max and sub < subparams_max) {
                const bit = @as(u8, 1) << @intCast(sub);
                const previous = if (fields.present[field] & bit != 0) fields.values[field][sub] else 0;
                fields.values[field][sub] = previous *| 10 +| (b - '0');
                fields.present[field] |= bit;
            },
            ';' => {
                field += 1;
                sub = 0;
                if (field < params_max) {
                    fields.count += 1;
                    fields.subcounts[field] = 1;
                }
            },
            ':' => {
                sub += 1;
                if (field < params_max) {
                    if (sub < subparams_max) {
                        fields.subcounts[field] += 1;
                    } else fields.overflow |= @as(u16, 1) << @intCast(field);
                }
            },
            else => return null,
        };
        return fields;
    }

    fn get(self: *const Fields, field: usize, sub: usize) ?u32 {
        if (field >= self.count or sub >= self.subcounts[field]) return null;
        if (self.present[field] & (@as(u8, 1) << @intCast(sub)) == 0) return null;
        return self.values[field][sub];
    }

    /// The field's value when it has exactly one subfield.
    fn single(self: *const Fields, field: usize) ?u32 {
        if (field >= self.count or self.subcounts[field] != 1) return null;
        return self.get(field, 0);
    }
};

/// The shape of a numeric CSI prefix, as Core's parametric states tracked it.
const Shape = struct {
    semicolons: u8,
    /// Parts of the last field, split at `:`.
    segments: u8,
    first: ?u32,

    /// A number first (or, with Kitty, a number with alternate keys after `:`), then
    /// one or two more fields of up to three `:` parts where each `:` follows a digit.
    fn of(params: []const u8, kitty: bool) ?Shape {
        var fields = std.mem.splitScalar(u8, params, ';');
        const first = fields.first();
        const head = first[0 .. std.mem.indexOfScalar(u8, first, ':') orelse first.len];
        if (head.len == 0 or !allDigits(head)) return null;
        if (head.len != first.len and !(kitty and allOf(first, "0123456789:"))) return null;
        var shape: Shape = .{ .semicolons = 0, .segments = 0, .first = parseDigits(head) };
        while (fields.next()) |field| {
            shape.semicolons += 1;
            if (shape.semicolons > 2) return null;
            var parts = std.mem.splitScalar(u8, field, ':');
            var count: u8 = 0;
            while (parts.next()) |part| {
                count += 1;
                if (count > 3) return null;
                // Every part but the last must have a digit.
                if (!allDigits(part) or (parts.peek() != null and part.len == 0)) return null;
            }
            shape.segments = count;
        }
        if (shape.semicolons == 0) return null;
        return shape;
    }
};

fn isDigit(b: u8) bool {
    return b >= '0' and b <= '9';
}

fn allDigits(bytes: []const u8) bool {
    for (bytes) |b| if (!isDigit(b)) return false;
    return true;
}

fn allOf(bytes: []const u8, set: []const u8) bool {
    for (bytes) |b| if (std.mem.indexOfScalar(u8, set, b) == null) return false;
    return true;
}

fn parseDigits(bytes: []const u8) u32 {
    var value: u32 = 0;
    for (bytes) |b| value = value *| 10 +| (b - '0');
    return value;
}

fn utf8Encode(scalar: u21, buffer: *[4]u8) []const u8 {
    const len = std.unicode.utf8Encode(scalar, buffer) catch unreachable;
    return buffer[0..len];
}

fn isScalar(value: u32) bool {
    return value <= 0x10ffff and !(value >= 0xd800 and value <= 0xdfff);
}

fn isControl(value: u32) bool {
    return value < 0x20 or (value >= 0x7f and value <= 0x9f);
}

fn modsFromParam(value: u32) Modifiers {
    return @bitCast(std.math.cast(u8, value -| 1) orelse 0);
}

const ModsAndAction = struct { mods: Modifiers, action: KeyAction, event: bool };

/// The modifiers and event type in the second parameter, `mods[:event]`.
fn modsAndAction(fields: *const Fields) ModsAndAction {
    const event_type = fields.get(1, 1);
    return .{
        .mods = modsFromParam(fields.get(1, 0) orelse 1),
        .action = switch (event_type orelse 1) {
            2 => .repeat,
            3 => .release,
            else => .press,
        },
        .event = event_type != null,
    };
}

/// Kitty's functional codes, with the legacy C0/DEL codes canonical.
fn functionalKey(code: u32) ?u32 {
    return switch (code) {
        27, 57344 => key.escape,
        13, 57345 => key.enter,
        9, 57346 => key.tab,
        8, 127, 57347 => key.backspace,
        57348...key.functional_last => code,
        else => null,
    };
}

/// What a printable keypad key inserts.
fn keypadText(code: u32) ?u8 {
    return switch (code) {
        key.kp_0...key.kp_0 + 9 => @as(u8, @intCast('0' + code - key.kp_0)),
        57409 => '.',
        57410 => '/',
        57411 => '*',
        57412 => '-',
        57413 => '+',
        57415 => '=',
        57416 => ',',
        else => null,
    };
}

/// A key code without alternates or text, as in xterm's `CSI 27 ; mods ; code ~`.
fn codeKey(code: u32, mods: Modifiers) ?Key {
    var value: Key = .{ .code = code, .mods = mods };
    if (functionalKey(code)) |functional| {
        value.code = functional;
        if (keypadText(functional)) |text| value.text.append(text);
        return value;
    }
    if (code == 0 or !isScalar(code) or isControl(code)) return null;
    value.text.append(@intCast(code));
    return value;
}

/// `CSI code[:shifted[:base]] ; mods[:event] ; text[:text...] u`
fn kittyKey(fields: *const Fields) ?Key {
    const code = fields.get(0, 0) orelse return null;
    const shape = modsAndAction(fields);
    var value: Key = .{ .code = code, .mods = shape.mods, .action = shape.action, .flags = flags.key_kitty };
    if (fields.count > 2) {
        if (fields.overflow & (1 << 2) != 0) value.flags |= flags.key_text_truncated;
        for (0..fields.subcounts[2]) |sub| {
            const scalar = fields.get(2, sub) orelse continue;
            if (scalar == 0 or !isScalar(scalar) or isControl(scalar)) continue;
            value.text.append(@intCast(scalar));
        }
    }
    // Text without a key, such as input method output.
    if (code == 0) return if (value.text.len == 0) null else value;
    if (functionalKey(code)) |functional| {
        value.code = functional;
        if (value.text.len == 0) if (keypadText(functional)) |text| value.text.append(text);
        return value;
    }
    if (!isScalar(code) or isControl(code)) return null;
    if (fields.get(0, 2)) |base| {
        if (base != 0 and isScalar(base)) value.base = base;
    }
    if (value.text.len == 0) {
        var scalar = code;
        if (shape.mods.shift) {
            const shifted = fields.get(0, 1) orelse 0;
            if (shifted != 0 and isScalar(shifted) and !isControl(shifted)) {
                scalar = shifted;
            } else if (upper(code)) |uppercase| scalar = uppercase;
        }
        value.text.append(@intCast(scalar));
    }
    return value;
}

/// `CSI number [; mods[:event]] ~`, and xterm's `CSI 27 ; mods ; code ~`.
fn tildeKey(fields: *const Fields) ?Key {
    const number = fields.get(0, 0) orelse return null;
    const shape = modsAndAction(fields);
    const code: u32 = switch (number) {
        1, 7 => key.home,
        2 => key.insert,
        3 => key.delete,
        4, 8 => key.end,
        5 => key.page_up,
        6 => key.page_down,
        11...15 => key.f(number - 10),
        17...21 => key.f(number - 11),
        23...26 => key.f(number - 12),
        28 => key.f(15),
        // xterm, Kitty, and VTE send Menu here; rxvt sends Shift+F6.
        29 => key.menu,
        31...34 => key.f(number - 14),
        27 => return codeKey(fields.get(2, 0) orelse return null, shape.mods),
        key.kp_begin => key.kp_begin,
        else => return null,
    };
    return .{ .code = code, .mods = shape.mods, .action = shape.action, .flags = if (shape.event) flags.key_kitty else 0 };
}

/// `CSI [1 ; mods[:event]] letter`, or `CSI mods letter` from older terminals.
fn letterKey(letter: u8, fields: *const Fields) ?Key {
    var value: Key = switch (fields.count) {
        0 => .{ .code = 0 },
        1 => .{ .code = 0, .mods = modsFromParam(fields.get(0, 0) orelse 1) },
        2 => if ((fields.get(0, 0) orelse 1) == 1) letter: {
            const shape = modsAndAction(fields);
            break :letter .{ .code = 0, .mods = shape.mods, .action = shape.action, .flags = if (shape.event) flags.key_kitty else 0 };
        } else return null,
        else => return null,
    };
    value.code = switch (letter) {
        'A', 'a' => key.up,
        'B', 'b' => key.down,
        'C', 'c' => key.right,
        'D', 'd' => key.left,
        'E', 'e' => key.kp_begin,
        'F' => key.end,
        'H' => key.home,
        'P' => key.f(1),
        'Q' => key.f(2),
        'S' => key.f(4),
        'Z' => key.tab,
        else => return null,
    };
    // rxvt reports Shift with the arrow letters in lowercase; `CSI Z` is Shift+Tab.
    if (letter == 'Z' or (letter >= 'a' and letter <= 'e')) value.mods.shift = true;
    return value;
}

/// The Linux console's F1 through F5, `CSI [ A` to `CSI [ E`, and PuTTY's `CSI [ number ~`.
fn bracketKey(params: []const u8, final: u8) ?Key {
    if (params.len == 0 and final >= 'A' and final <= 'E') return .{ .code = key.f(final - 'A' + 1) };
    if (final != '~') return null;
    const fields = Fields.parse(params) orelse return null;
    return tildeKey(&fields);
}

/// `ESC O [mods] final`
fn ss3Key(final: u8, params: []const u8) ?Key {
    if (!allDigits(params)) return null;
    var value: Key = .{ .code = 0, .mods = modsFromParam(if (params.len == 0) 1 else parseDigits(params)) };
    const keypad: ?u8 = switch (final) {
        'X' => '=',
        'j' => '*',
        'k' => '+',
        'l' => ',',
        'm' => '-',
        'n' => '.',
        'o' => '/',
        'p'...'y' => '0' + final - 'p',
        else => null,
    };
    if (keypad) |char| {
        value.code = char;
        value.text.append(char);
        return value;
    }
    value.code = switch (final) {
        'A', 'a' => key.up,
        'B', 'b' => key.down,
        'C', 'c' => key.right,
        'D', 'd' => key.left,
        'E', 'e' => key.kp_begin,
        'F' => key.end,
        'H' => key.home,
        'M' => key.enter,
        'P'...'S' => key.f(final - 'P' + 1),
        else => return null,
    };
    // rxvt reports Ctrl with the SS3 arrow letters in lowercase.
    if (final >= 'a' and final <= 'e') value.mods.ctrl = true;
    return value;
}

fn mouseModifiers(code: u32) Modifiers {
    return .{ .shift = code & 4 != 0, .alt = code & 8 != 0, .ctrl = code & 16 != 0 };
}

/// Decodes an xterm button code: buttons 0 to 2 (3 is none), +32 motion, +64 wheel,
/// +128 extra buttons (reported from 8).
fn mouseKind(code: u32, release: bool) ?Mouse {
    const low = code & 3;
    const button: u32 = if (code & 128 != 0) 8 + low else if (low == 3) mouse_button_none else low;
    if (code & 32 != 0) {
        // URxvt sets the wheel bit on motion while it scrolls.
        if (button != mouse_button_none and code & 64 == 0) return .{ .action = .drag, .button = button };
        return .{ .action = .move, .button = mouse_button_none };
    }
    if (code & 64 != 0) {
        // A wheel release carries nothing (issue 048).
        if (release) return null;
        return .{ .action = .scroll, .button = low };
    }
    if (button == mouse_button_none) return null;
    return .{ .action = if (release) .up else .down, .button = button };
}

/// `CSI < button ; column ; row M|m`, with one-based coordinates.
fn sgrMouse(params: []const u8, pressed: bool) ?Mouse {
    const fields = Fields.parse(params) orelse return null;
    if (fields.count != 3) return null;
    const code = fields.single(0) orelse return null;
    const column = fields.single(1) orelse return null;
    const row = fields.single(2) orelse return null;
    var mouse = mouseKind(code, !pressed) orelse return null;
    mouse.mods = mouseModifiers(code);
    mouse.x = std.math.cast(u16, column -| 1) orelse std.math.maxInt(u16);
    mouse.y = std.math.cast(u16, row -| 1) orelse std.math.maxInt(u16);
    return mouse;
}

/// Single-scalar uppercase for the scripts keyboards type, so Kitty's Shift+key
/// without a shifted code still inserts the shifted character.
fn upper(scalar: u32) ?u32 {
    return switch (scalar) {
        'a'...'z', 0xe0...0xf6, 0xf8...0xfe, 0x3b1...0x3c1, 0x3c3...0x3cb, 0x430...0x44f, 0xff41...0xff5a => scalar - 32,
        0xb5 => 0x39c,
        0xff => 0x178,
        0x131 => 'I',
        0x17f => 'S',
        0x3ac => 0x386,
        0x3ad...0x3af => scalar - 37,
        0x3c2 => 0x3a3,
        0x3cc => 0x38c,
        0x3cd, 0x3ce => scalar - 63,
        0x450...0x45f => scalar - 80,
        0x561...0x586 => scalar - 48,
        0x100...0x12f, 0x132...0x137, 0x14a...0x177, 0x460...0x481, 0x48a...0x4bf, 0x4d0...0x52f, 0x1e00...0x1e95, 0x1ea0...0x1eff => if (scalar & 1 == 1) scalar - 1 else null,
        0x139...0x148, 0x179...0x17e, 0x4c1...0x4ce => if (scalar & 1 == 0) scalar - 1 else null,
        else => null,
    };
}

test "input parser upper maps common scripts to one scalar" {
    const cases = [_][2]u32{
        .{ 'a', 'A' },     .{ 0xe9, 0xc9 },   .{ 0xff, 0x178 },  .{ 0x101, 0x100 },   .{ 0x13a, 0x139 },
        .{ 0x3b1, 0x391 }, .{ 0x3c2, 0x3a3 }, .{ 0x3ad, 0x388 }, .{ 0x3cd, 0x38e },   .{ 0x430, 0x410 },
        .{ 0x451, 0x401 }, .{ 0x561, 0x531 }, .{ 0x17e, 0x17d }, .{ 0x1e01, 0x1e00 },
    };
    for (cases) |case| try std.testing.expectEqual(case[1], upper(case[0]).?);
    for ([_]u32{ 'A', '1', 0xdf, 0xf7, 0x100, 0x139, 0x4e2d }) |scalar| try std.testing.expect(upper(scalar) == null);
}
