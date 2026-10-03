const std = @import("std");

pub const Handle = extern struct {
    context_id: u64,
    slot: u32,
    generation: u32,
};

pub const Kind = enum(u32) {
    native_renderable = 1,
    buffer_lease = 3,
    session,
    buffer,
    frame_buffer_lease,
    edit_buffer,
    editor_view,
    syntax_style,
    text_buffer,
    text_buffer_view,
    image,
    encoded_unicode,
    embedded_terminal,
    image_pixels_lease,
    audio_engine,
    clipboard_service,
    clipboard_operation,
};

pub const Error = error{
    OutOfMemory,
    ContextLimit,
    ObjectLimit,
    WrongContext,
    WrongKind,
    StaleHandle,
};

// Only identity allocation is shared. IDs never wrap or identify a later context.
var last_context_id: std.atomic.Value(u64) = .init(0);

const Slot = struct {
    generation: u32 = 1,
    kind: Kind = .native_renderable,
    state: enum { vacant, alive, destroying } = .vacant,
    ptr: ?*anyopaque = null,
    next_free: ?u32 = null,
};

pub const DestroyToken = struct {
    handle: Handle,
    kind: Kind,
    ptr: *anyopaque,
};

/// Single-owner storage. Different tables may be used on different threads.
pub const Table = struct {
    allocator: std.mem.Allocator,
    context_id: u64,
    slots: []Slot,
    free_head: ?u32,
    live_count: u32 = 0,

    pub fn init(allocator: std.mem.Allocator, capacity: u32) Error!Table {
        std.debug.assert(capacity > 0);
        const slots = try allocator.alloc(Slot, capacity);
        errdefer allocator.free(slots);
        var id = last_context_id.load(.monotonic);
        while (true) {
            if (id == std.math.maxInt(u64)) return error.ContextLimit;
            if (last_context_id.cmpxchgWeak(id, id + 1, .monotonic, .monotonic)) |current| {
                id = current;
            } else break;
        }
        for (slots, 0..) |*slot, index| {
            slot.* = .{ .next_free = if (index + 1 < slots.len) @intCast(index + 1) else null };
        }
        return .{
            .allocator = allocator,
            .context_id = id + 1,
            .slots = slots,
            .free_head = 0,
        };
    }

    pub fn deinit(self: *Table) void {
        std.debug.assert(self.live_count == 0);
        self.allocator.free(self.slots);
        self.* = undefined;
    }

    pub fn checkCapacity(self: *const Table) Error!void {
        if (self.free_head == null) return error.ObjectLimit;
    }

    pub fn insert(self: *Table, kind: Kind, ptr: *anyopaque) Error!Handle {
        const index = self.free_head orelse return error.ObjectLimit;
        const slot = &self.slots[index];
        std.debug.assert(slot.state == .vacant);
        std.debug.assert(self.live_count < self.slots.len);
        self.free_head = slot.next_free;
        slot.kind = kind;
        slot.ptr = ptr;
        slot.state = .alive;
        slot.next_free = null;
        self.live_count += 1;
        return .{ .context_id = self.context_id, .slot = index, .generation = slot.generation };
    }

    fn validate(self: *const Table, handle: Handle) Error!*Slot {
        if (handle.context_id != self.context_id) return error.WrongContext;
        if (handle.slot >= self.slots.len) return error.StaleHandle;
        const slot = &self.slots[handle.slot];
        if (slot.state != .alive or slot.generation != handle.generation) return error.StaleHandle;
        return slot;
    }

    pub fn get(self: *const Table, handle: Handle, kind: Kind, comptime T: type) Error!*T {
        const slot = try self.validate(handle);
        if (slot.kind != kind) return error.WrongKind;
        return @ptrCast(@alignCast(slot.ptr.?));
    }

    pub fn getKind(self: *const Table, handle: Handle) Error!Kind {
        return (try self.validate(handle)).kind;
    }

    pub fn beginDestroy(self: *Table, handle: Handle) Error!DestroyToken {
        const slot = try self.validate(handle);
        slot.state = .destroying;
        return .{ .handle = handle, .kind = slot.kind, .ptr = slot.ptr.? };
    }

    pub fn finishDestroy(self: *Table, token: DestroyToken) void {
        std.debug.assert(token.handle.context_id == self.context_id);
        const slot = &self.slots[token.handle.slot];
        std.debug.assert(slot.state == .destroying);
        std.debug.assert(slot.generation == token.handle.generation);
        std.debug.assert(slot.ptr == token.ptr);
        slot.ptr = null;
        slot.state = .vacant;
        self.live_count -= 1;
        // Retire an exhausted slot rather than aliasing an old generation.
        if (slot.generation == std.math.maxInt(u32)) return;
        slot.generation += 1;
        slot.next_free = self.free_head;
        self.free_head = token.handle.slot;
    }

    pub fn next(self: *const Table, kind: Kind, cursor: *usize) ?Handle {
        while (cursor.* < self.slots.len) {
            const index = cursor.*;
            cursor.* += 1;
            const slot = &self.slots[index];
            if (slot.state == .alive and slot.kind == kind) {
                return .{ .context_id = self.context_id, .slot = @intCast(index), .generation = slot.generation };
            }
        }
        return null;
    }
};

// The model mirrors one slot per table slot. Slots 0 and 1 start one destroy away
// from generation retirement, so the random walk also covers exhausted slots.
const Model = struct {
    const capacity = 4;
    const kinds = [_]Kind{ .session, .buffer, .image };
    const State = enum { vacant, alive, destroying, retired };

    table: *Table,
    objects: [capacity]u32 = @splat(0),
    ptr: [capacity]*u32 = undefined,
    generation: [capacity]u32 = @splat(1),
    state: [capacity]State = @splat(.vacant),
    kind: [capacity]Kind = @splat(.session),
    issued: [16]Handle = undefined,
    issued_count: usize = 0,
    pending: ?DestroyToken = null,

    fn expectedGet(self: *const Model, handle: Handle, kind: Kind) Error!*u32 {
        if (handle.context_id != self.table.context_id) return error.WrongContext;
        if (handle.slot >= capacity) return error.StaleHandle;
        const slot = handle.slot;
        if (self.state[slot] != .alive or self.generation[slot] != handle.generation) return error.StaleHandle;
        if (self.kind[slot] != kind) return error.WrongKind;
        return self.ptr[slot];
    }

    fn checkProbe(self: *const Model, handle: Handle, kind: Kind) !void {
        const expected = self.expectedGet(handle, kind);
        const actual = self.table.get(handle, kind, u32);
        if (expected) |pointer| {
            try std.testing.expectEqual(pointer, try actual);
            try std.testing.expectEqual(kind, try self.table.getKind(handle));
        } else |err| {
            try std.testing.expectError(err, actual);
        }
    }

    fn checkInvariants(self: *const Model) !void {
        var live: u32 = 0;
        var vacant = false;
        for (self.state) |state| {
            live += @intFromBool(state == .alive or state == .destroying);
            vacant = vacant or state == .vacant;
        }
        try std.testing.expectEqual(live, self.table.live_count);
        if (vacant) try self.table.checkCapacity() else try std.testing.expectError(error.ObjectLimit, self.table.checkCapacity());
        for (kinds) |kind| {
            var cursor: usize = 0;
            var listed: u32 = 0;
            while (self.table.next(kind, &cursor)) |handle| : (listed += 1) {
                try std.testing.expectEqual(State.alive, self.state[handle.slot]);
                try std.testing.expectEqual(kind, self.kind[handle.slot]);
                try std.testing.expectEqual(self.generation[handle.slot], handle.generation);
            }
            var expected: u32 = 0;
            for (self.state, self.kind) |state, slot_kind| expected += @intFromBool(state == .alive and slot_kind == kind);
            try std.testing.expectEqual(expected, listed);
        }
    }

    fn releaseAll(self: *Model) void {
        if (self.pending) |token| self.table.finishDestroy(token);
        self.pending = null;
        for (self.table.slots, 0..) |slot, index| {
            if (slot.state != .alive) continue;
            const handle: Handle = .{ .context_id = self.table.context_id, .slot = @intCast(index), .generation = slot.generation };
            self.table.finishDestroy(self.table.beginDestroy(handle) catch unreachable);
        }
    }

    fn step(self: *Model, random: std.Random) !void {
        const kind = kinds[random.uintLessThan(usize, kinds.len)];
        switch (random.uintLessThan(u8, 4)) {
            0 => {
                const object = &self.objects[self.issued_count % capacity];
                const result = self.table.insert(kind, object);
                const handle = result catch |err| {
                    try std.testing.expectEqual(error.ObjectLimit, err);
                    try std.testing.expect(std.mem.findScalar(State, &self.state, .vacant) == null);
                    return;
                };
                try std.testing.expectEqual(State.vacant, self.state[handle.slot]);
                try std.testing.expectEqual(self.generation[handle.slot], handle.generation);
                self.ptr[handle.slot] = object;
                self.state[handle.slot] = .alive;
                self.kind[handle.slot] = kind;
                self.issued[self.issued_count % self.issued.len] = handle;
                self.issued_count += 1;
            },
            1 => if (self.pending == null and self.issued_count > 0) {
                const handle = self.issued[random.uintLessThan(usize, @min(self.issued_count, self.issued.len))];
                const result = self.table.beginDestroy(handle);
                const token = result catch |err| {
                    try std.testing.expectError(err, self.expectedGet(handle, self.kind[handle.slot]));
                    return;
                };
                try std.testing.expectEqual(State.alive, self.state[handle.slot]);
                try std.testing.expectEqual(self.kind[handle.slot], token.kind);
                self.state[handle.slot] = .destroying;
                self.pending = token;
            },
            2 => if (self.pending) |token| {
                self.table.finishDestroy(token);
                const slot = token.handle.slot;
                if (self.generation[slot] == std.math.maxInt(u32)) {
                    self.state[slot] = .retired;
                } else {
                    self.state[slot] = .vacant;
                    self.generation[slot] += 1;
                }
                self.pending = null;
            },
            else => {
                const random_generation = random.int(u32);
                const random_slot = random.uintLessThan(u32, capacity + 2);
                const probes = [_]Handle{
                    std.mem.zeroes(Handle),
                    .{ .context_id = self.table.context_id, .slot = capacity, .generation = 1 },
                    .{ .context_id = self.table.context_id + 1, .slot = 0, .generation = self.generation[0] },
                    .{ .context_id = self.table.context_id, .slot = random_slot, .generation = random_generation },
                    if (self.issued_count == 0) std.mem.zeroes(Handle) else self.issued[random.uintLessThan(usize, @min(self.issued_count, self.issued.len))],
                };
                for (probes) |handle| try self.checkProbe(handle, kind);
            },
        }
    }
};

test "Table matches a reference model under seeded random operations" {
    for (0..16) |seed| {
        var table = try Table.init(std.testing.allocator, Model.capacity);
        defer table.deinit();
        var model: Model = .{ .table = &table };
        // Runs before table.deinit, so a failed expectation does not trip its live_count assertion.
        defer model.releaseAll();
        for ([_]u32{ 0, 1 }) |slot| {
            table.slots[slot].generation = std.math.maxInt(u32) - slot;
            model.generation[slot] = std.math.maxInt(u32) - slot;
        }
        var prng = std.Random.DefaultPrng.init(seed);
        for (0..256) |step| {
            errdefer std.debug.print("handle table model failed: seed {d}, step {d}\n", .{ seed, step });
            try model.step(prng.random());
            try model.checkInvariants();
        }
    }
}
