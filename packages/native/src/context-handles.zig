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
            .free_head = if (capacity == 0) null else 0,
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
