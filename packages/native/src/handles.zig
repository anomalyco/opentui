const std = @import("std");

pub const Handle = u32;

const INDEX_BITS = 16;
const GENERATION_BITS = 12;
const KIND_BITS = 4;
const INDEX_MASK: u32 = (1 << INDEX_BITS) - 1;
const GENERATION_MASK: u32 = (1 << GENERATION_BITS) - 1;
const MAX_SLOTS: usize = INDEX_MASK;

comptime {
    std.debug.assert(INDEX_BITS + GENERATION_BITS + KIND_BITS == 32);
}

pub const ObjectKind = enum(u4) {
    renderer = 0,
    optimized_buffer = 1,
    text_buffer = 2,
    text_buffer_view = 3,
    edit_buffer = 4,
    editor_view = 5,
    syntax_style = 6,
    event_sink = 7,
    audio_engine = 8,
    native_renderable = 9,
    image = 10,
    clipboard_service = 11,
    clipboard_operation = 12,
    embedded_terminal = 13,
};

const SlotState = enum(u8) {
    vacant,
    alive,
    destroying,
};

const ObjectSlot = struct {
    generation: u32 = 1,
    kind: u8 = 0,
    state: SlotState = .vacant,
    ptr: usize = 0,
    owner: Handle = 0,
    first_child: u16 = 0,
    previous_sibling: u16 = 0,
    next_sibling: u16 = 0,
};

pub const Error = error{
    OutOfHandles,
    InvalidOwner,
};

pub fn DestroyToken(comptime T: type) type {
    return struct {
        handle: Handle,
        ptr: *T,
    };
}

fn encode(index: u32, generation: u32, kind: ObjectKind) Handle {
    return (@as(u32, @intFromEnum(kind)) << (INDEX_BITS + GENERATION_BITS)) |
        ((generation & GENERATION_MASK) << INDEX_BITS) |
        (index & INDEX_MASK);
}

fn slotIndex(handle: Handle) u32 {
    return handle & INDEX_MASK;
}

fn slotGeneration(handle: Handle) u32 {
    return (handle >> INDEX_BITS) & GENERATION_MASK;
}

fn slotKind(handle: Handle) u4 {
    return @intCast(handle >> (INDEX_BITS + GENERATION_BITS));
}

fn nextGeneration(generation: u32) ?u32 {
    const next = generation + 1;
    return if (next > GENERATION_MASK) null else next;
}

/// The shipped 32-bit handle table. Entry is serialized by its owner; renderer
/// and audio threads do not enter it. Handles are local to one registry, without
/// a context identity. Resource destructors remain the caller's responsibility.
pub const Registry = struct {
    slots: [MAX_SLOTS + 1]ObjectSlot = [_]ObjectSlot{.{}} ** (MAX_SLOTS + 1),
    slot_count: u32 = 1,
    free_indices: [MAX_SLOTS]u16 = undefined,
    free_index_count: usize = 0,

    /// Initialize in place: the fixed-capacity table is too large for test stacks.
    pub fn init(self: *Registry) void {
        @memset(&self.slots, .{});
        self.slot_count = 1;
        self.free_index_count = 0;
    }

    pub fn insert(self: *Registry, kind: ObjectKind, ptr_value: *anyopaque) Error!Handle {
        return self.insertOwnedChild(kind, ptr_value, 0);
    }

    pub fn acquire(self: *const Registry, handle: Handle, expected_kind: ObjectKind, comptime T: type) ?*T {
        const index = self.validateSlot(handle, expected_kind) orelse return null;
        const opaque_ptr: *anyopaque = @ptrFromInt(self.slots[index].ptr);
        return @ptrCast(@alignCast(opaque_ptr));
    }

    pub fn beginDestroy(self: *Registry, handle: Handle, expected_kind: ObjectKind, comptime T: type) ?DestroyToken(T) {
        const index = self.validateSlot(handle, expected_kind) orelse return null;
        const slot = &self.slots[index];
        slot.state = .destroying;

        const opaque_ptr: *anyopaque = @ptrFromInt(slot.ptr);
        const typed_ptr: *T = @ptrCast(@alignCast(opaque_ptr));
        return .{ .handle = handle, .ptr = typed_ptr };
    }

    pub fn finishDestroy(self: *Registry, handle: Handle) void {
        const index = self.validateIdentity(handle) orelse return;
        if (self.slots[index].state != .destroying) return;
        self.invalidateChildren(handle);
        self.vacateSlot(index);
    }

    pub fn isValid(self: *const Registry, handle: Handle, expected_kind: ObjectKind) bool {
        return self.validateSlot(handle, expected_kind) != null;
    }

    pub fn isEmpty(self: *const Registry) bool {
        // Slot zero anchors roots, including roots whose destructors are running.
        return self.slots[0].first_child == 0;
    }

    pub fn invalidate(self: *Registry, handle: Handle, expected_kind: ObjectKind) void {
        const index = self.validateSlot(handle, expected_kind) orelse return;
        self.invalidateChildren(handle);
        self.vacateSlot(index);
    }

    /// Invalidate identities, not resources. Walk child links in postorder without
    /// recursion or allocation. Each descendant is descended into and vacated once.
    pub fn invalidateChildren(self: *Registry, owner: Handle) void {
        const owner_index = if (owner == 0) 0 else self.validateIdentity(owner) orelse return;
        var index: u16 = owner_index;
        while (true) {
            if (self.slots[index].first_child != 0) {
                index = self.slots[index].first_child;
                continue;
            }
            if (index == owner_index) return;
            const parent: u16 = @intCast(slotIndex(self.slots[index].owner));
            self.vacateSlot(index);
            index = parent;
        }
    }

    fn validateIdentity(self: *const Registry, handle: Handle) ?u16 {
        const index_u32 = slotIndex(handle);
        if (index_u32 == 0 or index_u32 >= self.slot_count) return null;
        const index: u16 = @intCast(index_u32);
        const slot = &self.slots[index];
        if (slot.generation != slotGeneration(handle) or slot.kind != slotKind(handle)) return null;
        if (slot.state == .vacant or slot.ptr == 0) return null;
        return index;
    }

    fn validateSlot(self: *const Registry, handle: Handle, expected_kind: ObjectKind) ?u16 {
        if (slotKind(handle) != @intFromEnum(expected_kind)) return null;
        const index = self.validateIdentity(handle) orelse return null;
        if (self.slots[index].state != .alive) return null;
        return index;
    }

    fn validateOwner(self: *const Registry, owner: Handle) Error!u16 {
        if (owner == 0) return 0;
        const index = self.validateIdentity(owner) orelse return error.InvalidOwner;
        if (self.slots[index].state != .alive) return error.InvalidOwner;
        return index;
    }

    pub fn insertOwnedChild(self: *Registry, kind: ObjectKind, ptr_value: *anyopaque, owner: Handle) Error!Handle {
        const owner_index = try self.validateOwner(owner);
        const index: u16 = if (self.free_index_count > 0) blk: {
            self.free_index_count -= 1;
            break :blk self.free_indices[self.free_index_count];
        } else blk: {
            if (self.slot_count > MAX_SLOTS) return Error.OutOfHandles;
            const new_index: u16 = @intCast(self.slot_count);
            self.slot_count += 1;
            break :blk new_index;
        };

        const slot = &self.slots[index];
        std.debug.assert(slot.state == .vacant and slot.first_child == 0);
        slot.owner = owner;
        slot.kind = @intFromEnum(kind);
        slot.ptr = @intFromPtr(ptr_value);
        slot.state = .alive;
        slot.previous_sibling = 0;
        slot.next_sibling = self.slots[owner_index].first_child;
        if (slot.next_sibling != 0) self.slots[slot.next_sibling].previous_sibling = index;
        self.slots[owner_index].first_child = index;
        return encode(index, slot.generation, kind);
    }

    fn vacateSlot(self: *Registry, index: u16) void {
        const slot = &self.slots[index];
        std.debug.assert(slot.state != .vacant and slot.first_child == 0);
        if (slot.previous_sibling != 0) {
            self.slots[slot.previous_sibling].next_sibling = slot.next_sibling;
        } else {
            const owner_index = if (slot.owner == 0) 0 else self.validateIdentity(slot.owner).?;
            std.debug.assert(self.slots[owner_index].first_child == index);
            self.slots[owner_index].first_child = slot.next_sibling;
        }
        if (slot.next_sibling != 0) {
            self.slots[slot.next_sibling].previous_sibling = slot.previous_sibling;
        }
        slot.ptr = 0;
        slot.owner = 0;
        slot.kind = 0;
        slot.state = .vacant;
        slot.previous_sibling = 0;
        slot.next_sibling = 0;

        const next = nextGeneration(slot.generation) orelse return;
        slot.generation = next;
        std.debug.assert(self.free_index_count < self.free_indices.len);
        self.free_indices[self.free_index_count] = index;
        self.free_index_count += 1;
    }
};
