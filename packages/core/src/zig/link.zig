const std = @import("std");

pub const LinkPoolError = error{
    OutOfMemory,
    InvalidId,
    WrongGeneration,
    UrlTooLong,
};

// ID layout within 24 bits: [ generation (8 bits) | slot_index (16 bits) ]
pub const GEN_BITS: u5 = 8;
pub const SLOT_BITS: u5 = 16;
pub const GEN_MASK: u32 = (@as(u32, 1) << GEN_BITS) - 1;
pub const SLOT_MASK: u32 = (@as(u32, 1) << SLOT_BITS) - 1;
pub const MAX_URL_LENGTH: usize = 512;
const RETIRED_GENERATION = GEN_MASK + 1;

pub const IdPayload = u32;

const SlotHeader = extern struct {
    len: u32,
    refcount: u32,
    generation: u32,
};

/// Simple link pool for storing URL strings with reusable IDs
pub const LinkPool = struct {
    allocator: std.mem.Allocator,
    slot_capacity: u32,
    slots_per_page: u32,
    slot_size_bytes: usize,
    slots: std.ArrayListUnmanaged(u8),
    free_list: std.ArrayListUnmanaged(u32),
    num_slots: u32,
    retired_slot_count: u32,
    interned_live_ids: std.StringHashMapUnmanaged(IdPayload),

    pub fn init(allocator: std.mem.Allocator) LinkPool {
        const slot_capacity = MAX_URL_LENGTH;
        const slots_per_page = 64;
        const slot_size_bytes = @sizeOf(SlotHeader) + slot_capacity;
        return .{
            .allocator = allocator,
            .slot_capacity = slot_capacity,
            .slots_per_page = slots_per_page,
            .slot_size_bytes = slot_size_bytes,
            .slots = .{},
            .free_list = .{},
            .num_slots = 0,
            .retired_slot_count = 0,
            .interned_live_ids = .{},
        };
    }

    pub fn deinit(self: *LinkPool) void {
        var key_it = self.interned_live_ids.keyIterator();
        while (key_it.next()) |key_ptr| {
            self.allocator.free(@constCast(key_ptr.*));
        }
        self.interned_live_ids.deinit(self.allocator);

        self.slots.deinit(self.allocator);
        self.free_list.deinit(self.allocator);
        self.* = undefined;
    }

    fn grow(self: *LinkPool) LinkPoolError!void {
        const slot_count_max = SLOT_MASK + 1;
        if (self.num_slots > slot_count_max - self.slots_per_page) return LinkPoolError.OutOfMemory;

        const add_bytes = self.slot_size_bytes * self.slots_per_page;

        try self.slots.ensureTotalCapacity(self.allocator, self.slots.items.len + add_bytes);
        try self.slots.appendNTimes(self.allocator, 0, add_bytes);

        var i: u32 = 0;
        while (i < self.slots_per_page) : (i += 1) {
            try self.free_list.append(self.allocator, self.num_slots + i);
        }
        self.num_slots += self.slots_per_page;
    }

    fn slotPtr(self: *LinkPool, slot_index: u32) *u8 {
        const offset: usize = @as(usize, slot_index) * self.slot_size_bytes;
        return &self.slots.items[offset];
    }

    fn slotHeaderPtr(p: *u8) *align(1) SlotHeader {
        return @ptrCast(p);
    }

    fn packId(slot_index: u32, generation: u32) LinkPoolError!IdPayload {
        if (slot_index > SLOT_MASK) return LinkPoolError.OutOfMemory;
        return ((generation & GEN_MASK) << SLOT_BITS) | (slot_index & SLOT_MASK);
    }

    fn unpackId(id: IdPayload) struct { slot_index: u32, generation: u32 } {
        return .{
            .slot_index = id & SLOT_MASK,
            .generation = (id >> SLOT_BITS) & GEN_MASK,
        };
    }

    fn removeInternedLiveId(self: *LinkPool, url: []const u8, expected_id: IdPayload) void {
        const live_id = self.interned_live_ids.get(url) orelse return;
        if (live_id != expected_id) return;
        if (self.interned_live_ids.fetchRemove(url)) |removed| {
            self.allocator.free(@constCast(removed.key));
        }
    }

    fn lookupOrInvalidate(self: *LinkPool, url: []const u8) ?IdPayload {
        const live_id = self.interned_live_ids.get(url) orelse return null;

        const live_url = self.get(live_id) catch {
            self.removeInternedLiveId(url, live_id);
            return null;
        };

        if (!std.mem.eql(u8, live_url, url)) {
            self.removeInternedLiveId(url, live_id);
            return null;
        }

        const live_refcount = self.getRefcount(live_id) catch {
            self.removeInternedLiveId(url, live_id);
            return null;
        };

        if (live_refcount == 0) {
            self.removeInternedLiveId(url, live_id);
            return null;
        }

        return live_id;
    }

    fn internLiveId(self: *LinkPool, id: IdPayload, url: []const u8) LinkPoolError!void {
        if (self.lookupOrInvalidate(url) != null) {
            return;
        }

        const owned_key = self.allocator.dupe(u8, url) catch return LinkPoolError.OutOfMemory;
        errdefer self.allocator.free(owned_key);

        if (self.interned_live_ids.fetchPut(self.allocator, owned_key, id) catch return LinkPoolError.OutOfMemory) |replaced| {
            self.allocator.free(@constCast(replaced.key));
        }
    }

    pub fn alloc(self: *LinkPool, url: []const u8) LinkPoolError!IdPayload {
        if (url.len > self.slot_capacity) {
            return LinkPoolError.UrlTooLong;
        }

        if (self.lookupOrInvalidate(url)) |live_id| {
            return live_id;
        }

        if (self.free_list.items.len == 0) try self.grow();

        const slot_index = self.free_list.pop().?;
        const p = self.slotPtr(slot_index);
        const header_ptr = slotHeaderPtr(p);

        std.debug.assert(header_ptr.generation < GEN_MASK);
        const new_generation = header_ptr.generation + 1;

        header_ptr.* = .{
            .len = @intCast(url.len),
            .refcount = 0,
            .generation = new_generation,
        };

        const data_ptr = @as([*]u8, @ptrCast(p)) + @sizeOf(SlotHeader);
        @memcpy(data_ptr[0..url.len], url);

        return packId(slot_index, new_generation);
    }

    pub fn incref(self: *LinkPool, id: IdPayload) LinkPoolError!void {
        const unpacked = unpackId(id);
        if (unpacked.slot_index >= self.num_slots) return LinkPoolError.InvalidId;

        const p = self.slotPtr(unpacked.slot_index);
        const header_ptr = slotHeaderPtr(p);

        if (header_ptr.generation != unpacked.generation) {
            return LinkPoolError.WrongGeneration;
        }

        const old_refcount = header_ptr.refcount;
        header_ptr.refcount +%= 1;

        if (old_refcount == 0) {
            const live_url = try self.get(id);
            try self.internLiveId(id, live_url);
        }
    }

    pub fn decref(self: *LinkPool, id: IdPayload) LinkPoolError!void {
        const unpacked = unpackId(id);
        if (unpacked.slot_index >= self.num_slots) return LinkPoolError.InvalidId;

        const p = self.slotPtr(unpacked.slot_index);
        const header_ptr = slotHeaderPtr(p);

        if (header_ptr.refcount == 0) return LinkPoolError.InvalidId;
        if (header_ptr.generation != unpacked.generation) return LinkPoolError.WrongGeneration;

        if (header_ptr.refcount == 1) {
            const live_url = try self.get(id);
            self.removeInternedLiveId(live_url, id);
        }

        header_ptr.refcount -%= 1;

        if (header_ptr.refcount == 0) {
            if (header_ptr.generation == GEN_MASK) {
                header_ptr.generation = RETIRED_GENERATION;
                self.retired_slot_count += 1;
            } else {
                try self.free_list.append(self.allocator, unpacked.slot_index);
            }
        }
    }

    pub fn get(self: *LinkPool, id: IdPayload) LinkPoolError![]const u8 {
        const unpacked = unpackId(id);
        if (unpacked.slot_index >= self.num_slots) return LinkPoolError.InvalidId;

        const p = self.slotPtr(unpacked.slot_index);
        const header_ptr = slotHeaderPtr(p);

        if (header_ptr.generation != unpacked.generation) return LinkPoolError.WrongGeneration;

        const data_ptr = @as([*]u8, @ptrCast(p)) + @sizeOf(SlotHeader);
        return data_ptr[0..header_ptr.len];
    }

    pub fn getRefcount(self: *LinkPool, id: IdPayload) LinkPoolError!u32 {
        const unpacked = unpackId(id);
        if (unpacked.slot_index >= self.num_slots) return LinkPoolError.InvalidId;

        const p = self.slotPtr(unpacked.slot_index);
        const header_ptr = slotHeaderPtr(p);

        if (header_ptr.generation != unpacked.generation) return LinkPoolError.WrongGeneration;

        return header_ptr.refcount;
    }

    pub fn getTotalSlots(self: *const LinkPool) u64 {
        return self.num_slots;
    }

    pub fn getFreeSlotCount(self: *const LinkPool) u64 {
        return self.free_list.items.len;
    }

    pub fn getLiveSlotCount(self: *const LinkPool) u64 {
        return self.num_slots - @as(u32, @intCast(self.free_list.items.len)) - self.retired_slot_count;
    }
};

/// Track link usage per buffer with per-cell refcounting
pub const LinkTracker = struct {
    pool: *LinkPool,
    used_ids: std.AutoHashMap(u32, u32), // id -> cell_count

    pub fn init(allocator: std.mem.Allocator, pool: *LinkPool) LinkTracker {
        return .{
            .pool = pool,
            .used_ids = std.AutoHashMap(u32, u32).init(allocator),
        };
    }

    fn decRefAll(self: *LinkTracker) void {
        var it = self.used_ids.iterator();
        while (it.next()) |entry| {
            const id = entry.key_ptr.*;
            self.pool.decref(id) catch {};
        }
    }

    pub fn deinit(self: *LinkTracker) void {
        self.decRefAll();
        self.used_ids.deinit();
        self.* = undefined;
    }

    pub fn clear(self: *LinkTracker) void {
        self.decRefAll();
        self.used_ids.clearRetainingCapacity();
    }

    pub fn addCellRef(self: *LinkTracker, id: u32) void {
        const res = self.used_ids.getOrPut(id) catch |err| {
            std.debug.panic("LinkTracker.addCellRef getOrPut failed: {}\n", .{err});
        };
        if (!res.found_existing) {
            // First time seeing this ID - try to incref in pool
            self.pool.incref(id) catch {
                // Invalid ID (not allocated in pool) - silently ignore
                // This can happen with garbage in attribute bits
                return;
            };
            res.value_ptr.* = 1;
        } else {
            res.value_ptr.* += 1;
        }
    }

    pub fn removeCellRef(self: *LinkTracker, id: u32) void {
        if (self.used_ids.getPtr(id)) |count_ptr| {
            if (count_ptr.* > 0) {
                count_ptr.* -= 1;
                if (count_ptr.* == 0) {
                    _ = self.used_ids.remove(id);
                    self.pool.decref(id) catch {};
                }
            }
        }
    }

    pub fn hasAny(self: *const LinkTracker) bool {
        return self.used_ids.count() > 0;
    }

    pub fn getLinkCount(self: *const LinkTracker) u32 {
        return @intCast(self.used_ids.count());
    }
};

var GLOBAL_LINK_POOL: ?LinkPool = null;

pub fn initGlobalLinkPool(allocator: std.mem.Allocator) *LinkPool {
    if (GLOBAL_LINK_POOL == null) {
        GLOBAL_LINK_POOL = LinkPool.init(allocator);
    }
    return &GLOBAL_LINK_POOL.?;
}

pub fn deinitGlobalLinkPool() void {
    if (GLOBAL_LINK_POOL) |*p| {
        p.deinit();
        GLOBAL_LINK_POOL = null;
    }
}
