const std = @import("std");
const Allocator = std.mem.Allocator;

pub const MemRegistryError = error{
    OutOfMemory,
    InvalidMemId,
};

/// Memory buffer reference in the registry
pub const MemBuffer = struct {
    data: []const u8,
    owned: bool,
    active: bool, // Track if slot is in use
};

/// Registry for multiple memory buffers
pub const MemRegistry = struct {
    buffers: std.ArrayListUnmanaged(MemBuffer),
    free_slots: std.ArrayListUnmanaged(u8), // Track free slot indices
    allocator: Allocator,

    pub fn init(allocator: Allocator) MemRegistry {
        return .{
            .buffers = .empty,
            .free_slots = .empty,
            .allocator = allocator,
        };
    }

    pub fn deinit(self: *MemRegistry) void {
        for (self.buffers.items) |mem_buf| {
            if (mem_buf.active and mem_buf.owned) {
                self.allocator.free(mem_buf.data);
            }
        }
        self.buffers.deinit(self.allocator);
        self.free_slots.deinit(self.allocator);
        self.* = undefined;
    }

    pub fn register(self: *MemRegistry, data: []const u8, owned: bool) MemRegistryError!u8 {
        // Try to reuse a free slot first
        if (self.free_slots.items.len > 0) {
            const id = self.free_slots.items[self.free_slots.items.len - 1];
            _ = self.free_slots.pop();
            self.buffers.items[id] = MemBuffer{
                .data = data,
                .owned = owned,
                .active = true,
            };
            return id;
        }

        // No free slots, allocate a new one
        if (self.buffers.items.len >= 255) {
            return MemRegistryError.OutOfMemory;
        }
        const id: u8 = @intCast(self.buffers.items.len);
        try self.buffers.append(self.allocator, .{
            .data = data,
            .owned = owned,
            .active = true,
        });
        return id;
    }

    pub fn get(self: *const MemRegistry, id: u8) ?[]const u8 {
        if (id >= self.buffers.items.len) return null;
        const buf = self.buffers.items[id];
        if (!buf.active) return null;
        return buf.data;
    }

    pub fn replace(self: *MemRegistry, id: u8, data: []const u8, owned: bool) MemRegistryError!void {
        if (id >= self.buffers.items.len) return MemRegistryError.InvalidMemId;
        const prev = self.buffers.items[id];
        if (!prev.active) return MemRegistryError.InvalidMemId;
        if (prev.owned) {
            self.allocator.free(prev.data);
        }
        self.buffers.items[id] = .{ .data = data, .owned = owned, .active = true };
    }

    pub fn unregister(self: *MemRegistry, id: u8) MemRegistryError!void {
        if (id >= self.buffers.items.len) return MemRegistryError.InvalidMemId;
        var buf = &self.buffers.items[id];
        if (!buf.active) return MemRegistryError.InvalidMemId;

        // Free owned memory
        if (buf.owned) {
            self.allocator.free(buf.data);
        }

        // Mark slot as inactive
        buf.active = false;
        buf.data = &[_]u8{};
        buf.owned = false;

        // Add to free slots list
        try self.free_slots.append(self.allocator, id);
    }

    pub fn clear(self: *MemRegistry) void {
        for (self.buffers.items) |mem_buf| {
            if (mem_buf.active and mem_buf.owned) {
                self.allocator.free(mem_buf.data);
            }
        }
        self.buffers.clearRetainingCapacity();
        self.free_slots.clearRetainingCapacity();
    }

    pub fn getUsedSlots(self: *const MemRegistry) usize {
        // Count only active slots
        var count: usize = 0;
        for (self.buffers.items) |buf| {
            if (buf.active) count += 1;
        }
        return count;
    }

    pub fn getFreeSlots(self: *const MemRegistry) usize {
        // Total capacity (255) minus buffers allocated plus explicitly freed slots
        return 255 - self.buffers.items.len + self.free_slots.items.len;
    }
};
