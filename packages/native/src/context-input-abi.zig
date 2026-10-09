const std = @import("std");
const c = @import("context_abi_c");
const abi = @import("context-abi.zig");
const transport = @import("context-editor-abi.zig");
const input_parser = @import("input-parser.zig");
const fail = transport.fail;

comptime {
    const Event = input_parser.Event;
    if (@sizeOf(Event) != @sizeOf(c.ot_input_event) or @alignOf(Event) != @alignOf(c.ot_input_event))
        @compileError("ot_input_event differs from input_parser.Event");
    for (std.meta.fields(Event)) |field| {
        if (@offsetOf(Event, field.name) != @offsetOf(c.ot_input_event, field.name))
            @compileError("ot_input_event differs from input_parser.Event: " ++ field.name);
    }
    @setEvalBranchQuota(20_000);
    // Every parser constant has an equal header twin named OT_INPUT_<prefix><NAME>.
    for (std.meta.tags(input_parser.Kind)) |tag| checkTwin("", @tagName(tag), @intFromEnum(tag));
    for (std.meta.tags(input_parser.KeyAction)) |tag| checkTwin("KEY_", @tagName(tag), @intFromEnum(tag));
    for (std.meta.tags(input_parser.MouseAction)) |tag| checkTwin("MOUSE_", @tagName(tag), @intFromEnum(tag));
    for (std.meta.tags(input_parser.Protocol)) |tag| checkTwin("REPLY_", @tagName(tag), @intFromEnum(tag));
    for (std.meta.fields(input_parser.Modifiers), 0..) |field, bit| checkTwin("MOD_", field.name, 1 << bit);
    for (std.meta.fields(input_parser.Expectations)[0..2], 0..) |field, bit| checkTwin("EXPECT_", field.name, 1 << bit);
    for (@typeInfo(input_parser.flags).@"struct".decls) |decl| checkTwin("", decl.name, @field(input_parser.flags, decl.name));
    for (@typeInfo(input_parser.key).@"struct".decls) |decl| {
        // Range bounds and the F(n) helper have no twin of their own.
        if (std.mem.startsWith(u8, decl.name, "functional_") or std.mem.eql(u8, decl.name, "f")) continue;
        checkTwin("KEY_", decl.name, @field(input_parser.key, decl.name));
    }
    checkTwin("", "mouse_button_none", input_parser.mouse_button_none);
    checkTwin("", "events_min", input_parser.events_per_byte_max);
    checkTwin("", "payload_bytes_min", input_parser.payload_per_byte_max);
    checkTwin("", "timeout_ns", input_parser.timeout_ns);
}

fn checkTwin(comptime prefix: []const u8, comptime name: []const u8, comptime value: u64) void {
    comptime var upper: [name.len]u8 = undefined;
    _ = std.ascii.upperString(&upper, name);
    const twin = "OT_INPUT_" ++ prefix ++ upper;
    if (!@hasDecl(c, twin) or @field(c, twin) != value) @compileError(twin ++ " differs from input_parser");
}

const expect_flags: u32 = c.OT_INPUT_EXPECT_REPLIES | c.OT_INPUT_EXPECT_KITTY_KEYBOARD;

pub fn ot_session_input_feed(
    context: ?*abi.ContextHandle,
    session: ?*const c.ot_handle,
    bytes: ?[*]const u8,
    byte_count: u32,
    now_ns: u64,
    records: ?[*]c.ot_input_event,
    capacity: u32,
    payload: ?[*]u8,
    payload_capacity: u32,
    out_drain: ?*c.ot_input_drain,
) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    _ = transport.record(c.ot_input_drain, out_drain) catch |err| return fail(context, err);
    if (session == null or (byte_count != 0 and bytes == null) or records == null or payload == null or
        capacity < c.OT_INPUT_EVENTS_MIN or payload_capacity < c.OT_INPUT_PAYLOAD_BYTES_MIN) return fail(context, error.InvalidOptions);
    const events: [*]input_parser.Event = @ptrCast(records.?);
    var sink: input_parser.Sink = .{ .events = events[0..capacity], .payload = payload.?[0..payload_capacity] };
    const input = if (bytes) |pointer| pointer[0..byte_count] else &.{};
    const result = context.?.core.sessionInputFeed(abi.handleFromC(session.?.*), input, now_ns, &sink) catch |err| return fail(context, err);
    out_drain.?.* = .{
        .struct_size = @sizeOf(c.ot_input_drain),
        .abi_version = c.OT_CONTEXT_ABI_VERSION,
        .consumed = result.consumed,
        .count = sink.count,
        .payload_len = sink.payload_len,
        .discarded = result.discarded,
        .deadline_ns = result.deadline_ns orelse 0,
    };
    return c.OT_OK;
}

pub fn ot_session_input_expect(context: ?*abi.ContextHandle, session: ?*const c.ot_handle, flags: u32) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    if (session == null or flags & ~expect_flags != 0) return fail(context, error.InvalidOptions);
    const expect: input_parser.Expectations = .{
        .replies = flags & c.OT_INPUT_EXPECT_REPLIES != 0,
        .kitty_keyboard = flags & c.OT_INPUT_EXPECT_KITTY_KEYBOARD != 0,
    };
    context.?.core.sessionInputExpect(abi.handleFromC(session.?.*), expect) catch |err| return fail(context, err);
    return c.OT_OK;
}

pub fn ot_session_input_reset(context: ?*abi.ContextHandle, session: ?*const c.ot_handle, flags: u32) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    if (session == null or flags & ~c.OT_INPUT_RESET_KEEP_REPLY != 0) return fail(context, error.InvalidOptions);
    const keep_reply = flags & c.OT_INPUT_RESET_KEEP_REPLY != 0;
    context.?.core.sessionInputReset(abi.handleFromC(session.?.*), keep_reply) catch |err| return fail(context, err);
    return c.OT_OK;
}

const Fixture = struct {
    context: *abi.ContextHandle,
    session: c.ot_handle,
    records: [64]c.ot_input_event = undefined,
    payload: [16 * 1024]u8 = undefined,
    drain: c.ot_input_drain = .{ .struct_size = @sizeOf(c.ot_input_drain), .abi_version = c.OT_CONTEXT_ABI_VERSION, .consumed = 0, .count = 0, .payload_len = 0, .discarded = 0, .deadline_ns = 0 },

    fn init() !*Fixture {
        const fixture = try std.testing.allocator.create(Fixture);
        errdefer std.testing.allocator.destroy(fixture);
        const context = try abi.createTestContext(.{ .object_capacity = 16, .render_cells_max = 16 });
        errdefer std.testing.expectEqual(c.OT_OK, abi.ot_context_destroy(context)) catch unreachable;
        fixture.* = .{ .context = context, .session = abi.handleToC(try context.core.createSession(.{ .chunk_size = 4096, .chunk_count = 2, .span_capacity = 2 })) };
        return fixture;
    }

    fn deinit(self: *Fixture) void {
        std.testing.expectEqual(c.OT_OK, abi.ot_context_destroy(self.context)) catch unreachable;
        std.testing.allocator.destroy(self);
    }

    fn feed(self: *Fixture, bytes: []const u8, now_ns: u64) c.ot_status {
        return ot_session_input_feed(self.context, &self.session, bytes.ptr, @intCast(bytes.len), now_ns, &self.records, self.records.len, &self.payload, self.payload.len, &self.drain);
    }

    fn raw(self: *const Fixture, index: usize) []const u8 {
        const record = self.records[index];
        return self.payload[record.raw_offset..][0..record.raw_len];
    }
};

test "Context input ABI parses into caller records and resolves timeouts" {
    const f = try Fixture.init();
    defer f.deinit();
    try std.testing.expectEqual(c.OT_OK, f.feed("a\x1b[1;5A\x1b[<0;3;4M\x1b", 10));
    try std.testing.expectEqual(@as(u32, 17), f.drain.consumed);
    try std.testing.expectEqual(@as(u32, 3), f.drain.count);
    try std.testing.expectEqual(@as(u64, 10 + c.OT_INPUT_TIMEOUT_NS), f.drain.deadline_ns);
    try std.testing.expectEqual(@as(u8, c.OT_INPUT_KEY), f.records[0].kind);
    try std.testing.expectEqual(@as(u32, 'a'), f.records[0].code);
    try std.testing.expectEqualStrings("a", f.payload[f.records[0].text_offset..][0..f.records[0].text_len]);
    try std.testing.expectEqual(@as(u32, c.OT_INPUT_KEY_UP), f.records[1].code);
    try std.testing.expectEqual(@as(u8, c.OT_INPUT_MOD_CTRL), f.records[1].modifiers);
    try std.testing.expectEqualStrings("\x1b[1;5A", f.raw(1));
    try std.testing.expectEqual(@as(u8, c.OT_INPUT_MOUSE), f.records[2].kind);
    try std.testing.expectEqual(@as(u16, 2), f.records[2].x);
    try std.testing.expectEqual(@as(u16, 3), f.records[2].y);
    // Zero bytes only expires; an earlier time is not the deadline yet.
    try std.testing.expectEqual(c.OT_OK, ot_session_input_feed(f.context, &f.session, null, 0, 11, &f.records, f.records.len, &f.payload, f.payload.len, &f.drain));
    try std.testing.expectEqual(@as(u32, 0), f.drain.count);
    try std.testing.expectEqual(c.OT_OK, f.feed("", 10 + c.OT_INPUT_TIMEOUT_NS));
    try std.testing.expectEqual(@as(u32, 1), f.drain.count);
    try std.testing.expectEqual(@as(u32, c.OT_INPUT_KEY_ESCAPE), f.records[0].code);
    try std.testing.expectEqual(@as(u64, 0), f.drain.deadline_ns);
    // Input time is independent of pump time but must not go backwards.
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, f.feed("b", 9));
    try std.testing.expectEqual(@as(u32, 1), f.drain.count);
    // Expectations defer an awaited reply.
    try std.testing.expectEqual(c.OT_OK, ot_session_input_expect(f.context, &f.session, c.OT_INPUT_EXPECT_REPLIES));
    try std.testing.expectEqual(c.OT_OK, f.feed("\x1b[?62", 50_000_000));
    try std.testing.expectEqual(c.OT_OK, f.feed("", 50_000_000 + c.OT_INPUT_TIMEOUT_NS));
    try std.testing.expectEqual(@as(u32, 0), f.drain.count);
    try std.testing.expectEqual(@as(u64, 0), f.drain.deadline_ns);
    // Reset drops a reply prefix, unless KEEP_REPLY asks for it while REPLIES is set.
    for ([_]struct { u32, u32, []const u8 }{
        .{ c.OT_INPUT_EXPECT_REPLIES, 0, "c" },
        .{ c.OT_INPUT_EXPECT_REPLIES, c.OT_INPUT_RESET_KEEP_REPLY, "\x1b[?62c" },
        .{ 0, c.OT_INPUT_RESET_KEEP_REPLY, "c" },
    }) |case| {
        try std.testing.expectEqual(c.OT_OK, ot_session_input_expect(f.context, &f.session, case[0]));
        try std.testing.expectEqual(c.OT_OK, ot_session_input_reset(f.context, &f.session, case[1]));
        try std.testing.expectEqual(c.OT_OK, f.feed("c", 80_000_000));
        try std.testing.expectEqualStrings(case[2], f.raw(0));
        try std.testing.expectEqual(c.OT_OK, ot_session_input_expect(f.context, &f.session, c.OT_INPUT_EXPECT_REPLIES));
        try std.testing.expectEqual(c.OT_OK, f.feed("\x1b[?62", 80_000_000));
    }
    // Overlong units are counted in every drain.
    var long: [300]u8 = @splat('9');
    long[0] = 0x1b;
    long[1] = '[';
    try std.testing.expectEqual(c.OT_OK, f.feed(&long, 90_000_000));
    try std.testing.expectEqual(c.OT_OK, f.feed("~", 90_000_000));
    try std.testing.expectEqual(@as(u32, 1), f.drain.discarded);
}

test "Context input ABI stops at the sink minimums and resumes without loss" {
    const f = try Fixture.init();
    defer f.deinit();
    var records: [c.OT_INPUT_EVENTS_MIN]c.ot_input_event = undefined;
    var payload: [c.OT_INPUT_PAYLOAD_BYTES_MIN]u8 = undefined;
    const input = "abcdefghij";
    var offset: usize = 0;
    var text: [16]u8 = undefined;
    var len: usize = 0;
    while (offset < input.len) {
        const rest = input[offset..];
        try std.testing.expectEqual(c.OT_OK, ot_session_input_feed(f.context, &f.session, rest.ptr, @intCast(rest.len), 1, &records, records.len, &payload, payload.len, &f.drain));
        try std.testing.expect(f.drain.consumed > 0 and f.drain.consumed <= records.len);
        for (records[0..f.drain.count]) |record| {
            @memcpy(text[len..][0..record.text_len], payload[record.text_offset..][0..record.text_len]);
            len += record.text_len;
        }
        offset += f.drain.consumed;
    }
    try std.testing.expectEqualStrings(input, text[0..len]);
    // Smaller sinks are rejected without touching the drain.
    f.drain.consumed = 77;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_input_feed(f.context, &f.session, "x", 1, 1, &records, records.len - 1, &payload, payload.len, &f.drain));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_input_feed(f.context, &f.session, "x", 1, 1, &records, records.len, &payload, payload.len - 1, &f.drain));
    try std.testing.expectEqual(@as(u32, 77), f.drain.consumed);
}

test "Context input ABI rejects malformed calls, foreign handles, and closed sessions" {
    const f = try Fixture.init();
    defer f.deinit();
    const context = f.context;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_input_feed(null, &f.session, "a", 1, 0, &f.records, f.records.len, &f.payload, f.payload.len, &f.drain));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_input_feed(context, null, "a", 1, 0, &f.records, f.records.len, &f.payload, f.payload.len, &f.drain));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_input_feed(context, &f.session, null, 1, 0, &f.records, f.records.len, &f.payload, f.payload.len, &f.drain));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_input_feed(context, &f.session, "a", 1, 0, null, f.records.len, &f.payload, f.payload.len, &f.drain));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_input_feed(context, &f.session, "a", 1, 0, &f.records, f.records.len, null, f.payload.len, &f.drain));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_input_feed(context, &f.session, "a", 1, 0, &f.records, f.records.len, &f.payload, f.payload.len, null));
    var drain = f.drain;
    drain.struct_size -= 1;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_input_feed(context, &f.session, "a", 1, 0, &f.records, f.records.len, &f.payload, f.payload.len, &drain));
    drain = f.drain;
    drain.abi_version += 1;
    try std.testing.expectEqual(c.OT_UNSUPPORTED_VERSION, ot_session_input_feed(context, &f.session, "a", 1, 0, &f.records, f.records.len, &f.payload, f.payload.len, &drain));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_input_expect(context, &f.session, 4));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_input_expect(context, null, 0));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_input_reset(context, null, 0));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_session_input_reset(context, &f.session, 2));
    var foreign = f.session;
    foreign.context_id += 1;
    try std.testing.expectEqual(c.OT_WRONG_CONTEXT, ot_session_input_feed(context, &foreign, "a", 1, 0, &f.records, f.records.len, &f.payload, f.payload.len, &f.drain));
    try std.testing.expectEqual(c.OT_WRONG_CONTEXT, ot_session_input_reset(context, &foreign, 0));
    try std.testing.expectEqual(c.OT_WRONG_CONTEXT, ot_session_input_expect(context, &foreign, 0));
    // A busy Context rejects input without parsing it.
    context.core.mutating = true;
    try std.testing.expectEqual(c.OT_CONTEXT_BUSY, f.feed("\x1b", 1));
    context.core.mutating = false;
    try std.testing.expectEqual(c.OT_OK, f.feed("\x1b", 1));
    try std.testing.expectEqual(c.OT_OK, f.feed("", 1 + c.OT_INPUT_TIMEOUT_NS));
    // One plain Escape: a parsed rejected ESC would make this Alt+Escape.
    try std.testing.expectEqual(@as(u8, 0), f.records[0].modifiers);
    const thread = try std.Thread.spawn(.{}, struct {
        fn run(owner: *abi.ContextHandle, session: *const c.ot_handle) void {
            std.testing.expectEqual(c.OT_WRONG_THREAD, ot_session_input_feed(owner, session, null, 0, 0, null, 0, null, 0, null)) catch unreachable;
            std.testing.expectEqual(c.OT_WRONG_THREAD, ot_session_input_expect(owner, session, 0)) catch unreachable;
            std.testing.expectEqual(c.OT_WRONG_THREAD, ot_session_input_reset(owner, session, 0)) catch unreachable;
        }
    }.run, .{ context, &f.session });
    thread.join();
    try std.testing.expectEqual(c.OT_OK, abi.ot_session_close(context, &f.session));
    try std.testing.expectEqual(c.OT_SESSION_CLOSED, f.feed("a", 2));
    try std.testing.expectEqual(c.OT_SESSION_CLOSED, ot_session_input_expect(context, &f.session, 0));
    try std.testing.expectEqual(c.OT_SESSION_CLOSED, ot_session_input_reset(context, &f.session, 0));
    try std.testing.expectEqual(c.OT_OK, abi.ot_session_destroy(context, &f.session));
    try std.testing.expectEqual(c.OT_STALE_HANDLE, f.feed("a", 2));
}

test "Context input ABI applies the terminal's Kitty keyboard state" {
    const context = try abi.createTestContext(.{ .object_capacity = 16, .render_cells_max = 64 });
    defer std.testing.expectEqual(c.OT_OK, abi.ot_context_destroy(context)) catch unreachable;
    const id = try context.core.createSession(.{ .chunk_size = 4096, .chunk_count = 2, .span_capacity = 2 });
    try context.core.attachSessionRenderer(id, 4, 2, .{ .forwarded_env = &.{} });
    const session = abi.handleToC(id);
    var records: [8]c.ot_input_event = undefined;
    var payload: [c.OT_INPUT_PAYLOAD_BYTES_MIN]u8 = undefined;
    var drain = std.mem.zeroes(c.ot_input_drain);
    drain.struct_size = @sizeOf(c.ot_input_drain);
    drain.abi_version = c.OT_CONTEXT_ABI_VERSION;
    (try context.core.raw().getSessionRenderer(id)).terminal.state.kitty_keyboard = true;
    try std.testing.expectEqual(c.OT_OK, ot_session_input_feed(context, &session, "\x1b[97;", 5, 1, &records, records.len, &payload, payload.len, &drain));
    try std.testing.expectEqual(c.OT_OK, ot_session_input_feed(context, &session, null, 0, 1 + c.OT_INPUT_TIMEOUT_NS, &records, records.len, &payload, payload.len, &drain));
    try std.testing.expectEqual(@as(u32, 0), drain.count);
    try std.testing.expectEqual(@as(u64, 0), drain.deadline_ns);
    (try context.core.raw().getSessionRenderer(id)).terminal.state.kitty_keyboard = false;
    try std.testing.expectEqual(c.OT_OK, ot_session_input_feed(context, &session, null, 0, 2 + c.OT_INPUT_TIMEOUT_NS, &records, records.len, &payload, payload.len, &drain));
    try std.testing.expectEqual(@as(u32, 1), drain.count);
    try std.testing.expectEqual(@as(u32, c.OT_INPUT_REPLY_FRAGMENT), records[0].flags);
    try std.testing.expectEqual(c.OT_OK, abi.ot_session_cancel(context, &session));
}
