//! The far side of fd 1 as a model: a pty buffer with a write lock, an ssh-like socket buffer,
//! and a link with a rate, a latency and stall windows. Every byte that enters the pty is kept
//! in one `wire` log with its source, so invariants can ask who wrote what, and where.
//! Time is passed in; the model never reads a clock.
const std = @import("std");
const presets = @import("presets.zig");

pub const Source = union(enum) {
    /// Session output, by its offset in the Session's stream.
    session: u64,
    /// An outside writer's marker, by its index.
    external: u32,
};

pub const Segment = struct { wire: u64, len: u32, source: Source };

/// Who holds or waits for the pty's write lock.
pub const Writer = struct {
    kind: enum { owner, external },
    bytes: []const u8,
    done: usize = 0,
    /// The write returns once this many bytes are in (a partial count), or at `bytes.len`.
    limit: usize,
    /// Bytes written since this writer last let another one enter (`chunked`).
    run: usize = 0,
    external: u32 = 0,
};

/// One escape-sequence tokenizer state, for I5. Ground means between tokens.
pub const Tokenizer = struct {
    state: enum { ground, esc, esc_intermediate, csi, string, string_esc, utf8 } = .ground,
    utf8_left: u8 = 0,

    pub fn feed(self: *Tokenizer, bytes: []const u8) void {
        for (bytes) |byte| self.step(byte);
    }

    fn step(self: *Tokenizer, byte: u8) void {
        switch (self.state) {
            .ground => {
                if (byte == 0x1b) {
                    self.state = .esc;
                } else if (byte >= 0xc0) {
                    self.utf8_left = if (byte >= 0xf0) 3 else if (byte >= 0xe0) 2 else 1;
                    self.state = .utf8;
                }
            },
            .utf8 => {
                self.utf8_left -= 1;
                if (self.utf8_left == 0 or byte & 0xc0 != 0x80) self.state = .ground;
            },
            .esc => self.state = switch (byte) {
                '[' => .csi,
                ']', 'P', '_', '^', 'X' => .string,
                0x20...0x2f => .esc_intermediate,
                else => .ground,
            },
            .esc_intermediate => if (byte >= 0x30) {
                self.state = .ground;
            },
            .csi => if (byte >= 0x40 and byte <= 0x7e) {
                self.state = .ground;
            },
            .string => switch (byte) {
                0x07 => self.state = .ground,
                0x1b => self.state = .string_esc,
                else => {},
            },
            .string_esc => self.state = if (byte == '\\') .ground else .string,
        }
    }
};

pub const Link = struct {
    allocator: std.mem.Allocator,
    env: *const presets.Env,
    wire: std.ArrayList(u8) = .empty,
    segments: std.ArrayList(Segment) = .empty,
    /// Wire offsets: read by the ssh-like reader into the socket, sent onto the link, arrived.
    read: u64 = 0,
    sent: u64 = 0,
    arrived: u64 = 0,
    departures: std.ArrayList(struct { end: u64, at_ns: u64 }) = .empty,
    departure_head: usize = 0,
    /// Byte-nanoseconds of rate credit, so a slow rate moves whole bytes without drift.
    credit: u128 = 0,
    last_ns: u64 = 0,
    /// The lock holder first, then the writers that wait for it.
    queue: std.ArrayList(Writer) = .empty,
    /// The Session's bytes in the pty so far: the next session segment starts here.
    session_end: u64 = 0,
    tokenizer: Tokenizer = .{},
    /// I5: outside writes that entered inside a Session token.
    cut_tokens: u32 = 0,
    /// The last owner write stopped inside its Session span, and cuts there.
    mid_span: bool = false,
    cuts_mid_span: u32 = 0,
    /// I10: session segments that did not continue the previous one (a replay or a gap).
    discontinuities: u32 = 0,
    /// The terminal hung up: every later write fails.
    hangup: ?presets.FaultKind = null,
    /// A completed external write, or a finished owner write, since the caller last looked.
    finished: std.ArrayList(Writer) = .empty,

    pub fn deinit(self: *Link) void {
        for (self.queue.items) |writer| if (writer.kind == .external) self.allocator.free(writer.bytes);
        for (self.finished.items) |writer| if (writer.kind == .external) self.allocator.free(writer.bytes);
        inline for (.{ &self.wire, &self.segments, &self.departures, &self.queue, &self.finished }) |list| list.deinit(self.allocator);
    }

    pub fn ptyFill(self: *const Link) u64 {
        return self.wire.items.len - self.read;
    }

    fn room(self: *const Link) u64 {
        return self.env.pty_capacity -| self.ptyFill();
    }

    /// Appends accepted bytes to the wire with their source.
    fn accept(self: *Link, writer: *const Writer, bytes: []const u8) !void {
        std.debug.assert(bytes.len != 0);
        const source: Source = switch (writer.kind) {
            .owner => .{ .session = self.session_end },
            .external => .{ .external = writer.external },
        };
        switch (source) {
            .session => {
                self.tokenizer.feed(bytes);
                self.session_end += bytes.len;
            },
            // Once per write: a blocking write that the pty takes in pieces still holds the lock.
            .external => if (writer.done == 0 and self.tokenizer.state != .ground) {
                self.cut_tokens += 1;
                // After a write that stopped short of its span, or inside a write still running.
                var inside = self.mid_span;
                for (self.queue.items) |held| inside = inside or (held.kind == .owner and held.done != 0);
                self.cuts_mid_span += @intFromBool(inside);
            },
        }
        // Consecutive session bytes extend one segment.
        if (self.segments.items.len != 0) {
            const last = &self.segments.items[self.segments.items.len - 1];
            if (last.source == .session and source == .session and last.wire + last.len == self.wire.items.len) {
                last.len += @intCast(bytes.len);
                try self.wire.appendSlice(self.allocator, bytes);
                return;
            }
        }
        try self.segments.append(self.allocator, .{ .wire = self.wire.items.len, .len = @intCast(bytes.len), .source = source });
        try self.wire.appendSlice(self.allocator, bytes);
    }

    /// Session bytes that must start where the last ones ended, for I10.
    pub fn expectContinuous(self: *Link, offset: u64) void {
        if (offset != self.session_end) self.discontinuities += 1;
    }

    /// Queues a blocking writer. It enters when the lock is free and room appears.
    pub fn enqueue(self: *Link, writer: Writer) !void {
        try self.queue.append(self.allocator, writer);
        try self.pump();
    }

    /// One non-blocking write: what fits now, if nobody holds the lock.
    pub fn writeNow(self: *Link, bytes: []const u8) !usize {
        if (self.queue.items.len != 0) return 0;
        const count: usize = @intCast(@min(self.room(), bytes.len, self.env.partial_max orelse bytes.len));
        if (count != 0) try self.accept(&.{ .kind = .owner, .bytes = bytes, .limit = count }, bytes[0..count]);
        return count;
    }

    /// Moves bytes from the lock holder into the pty while it has room, passing the lock on.
    pub fn pump(self: *Link) !void {
        const chunk: ?usize = if (self.env.external) |external| switch (external.atomicity) {
            .whole => null,
            .chunked => |size| size,
        } else null;
        while (self.queue.items.len != 0) {
            const head = &self.queue.items[0];
            const space = self.room();
            if (space == 0) return;
            var count: usize = @intCast(@min(space, head.limit - head.done));
            if (chunk) |size| count = @min(count, size - head.run);
            try self.accept(head, head.bytes[head.done..][0..count]);
            head.done += count;
            head.run += count;
            if (head.done == head.limit) {
                try self.finished.append(self.allocator, self.queue.orderedRemove(0));
                continue;
            }
            const size = chunk orelse continue;
            if (head.run < size) continue;
            head.run = 0;
            // Above the high-water mark, the next writer enters before this one goes on.
            if (self.queue.items.len > 1 and self.ptyFill() * 2 >= self.env.pty_capacity) {
                const held = self.queue.orderedRemove(0);
                try self.queue.insert(self.allocator, 1, held);
            }
        }
    }

    fn stalled(self: *const Link, now_ns: u64) bool {
        for (self.env.stalls) |window| if (now_ns >= window.start_ns and now_ns < window.end_ns) return true;
        return false;
    }

    /// Advances the reader, the link and arrivals to `now_ns`, then lets writers into the room.
    pub fn advance(self: *Link, now_ns: u64) !void {
        std.debug.assert(now_ns >= self.last_ns);
        const elapsed = now_ns - self.last_ns;
        self.last_ns = now_ns;
        self.moveToSocket();
        const queued = self.read - self.sent;
        var leaving: u64 = queued;
        if (self.env.rate_bps) |rate| {
            if (self.stalled(now_ns) or queued == 0) {
                self.credit = 0;
                leaving = 0;
            } else {
                // At most one tick of credit carries over, as a sender with nothing queued
                // sends nothing.
                self.credit = @min(self.credit + @as(u128, rate) * elapsed, @as(u128, rate) * tick_ns + std.time.ns_per_s);
                leaving = @min(queued, @as(u64, @intCast(self.credit / std.time.ns_per_s)));
                self.credit -= @as(u128, leaving) * std.time.ns_per_s;
            }
        }
        if (leaving != 0) {
            self.sent += leaving;
            try self.departures.append(self.allocator, .{ .end = self.sent, .at_ns = now_ns + self.env.latency_ns });
        }
        self.moveToSocket();
        while (self.departure_head < self.departures.items.len and self.departures.items[self.departure_head].at_ns <= now_ns) {
            self.arrived = self.departures.items[self.departure_head].end;
            self.departure_head += 1;
        }
        try self.pump();
    }

    fn moveToSocket(self: *Link) void {
        const space = self.env.socket_capacity -| (self.read - self.sent);
        self.read += @min(space, self.ptyFill());
    }

    pub const tick_ns: u64 = std.time.ns_per_ms;

    /// When the link next changes on its own, or null when it is idle.
    pub fn nextWake(self: *const Link, now_ns: u64) ?u64 {
        if (self.ptyFill() != 0 or self.read != self.sent) {
            if (self.env.rate_bps == null) return now_ns;
            return now_ns + tick_ns;
        }
        if (self.departure_head < self.departures.items.len) return @max(now_ns, self.departures.items[self.departure_head].at_ns);
        return null;
    }

    /// Everything accepted has arrived.
    pub fn drained(self: *const Link) bool {
        return self.arrived == self.wire.items.len and self.queue.items.len == 0;
    }
};
