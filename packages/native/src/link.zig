const std = @import("std");
const assert = std.debug.assert;

pub const LinkPoolError = error{
    OutOfMemory,
    InvalidId,
    WrongGeneration,
    UrlTooLong,
    RefcountOverflow,
};

// ID layout within 24 bits: [ generation (8 bits) | slot_index (16 bits) ]
pub const GEN_BITS: u5 = 8;
pub const SLOT_BITS: u5 = 16;
pub const GEN_MASK: u32 = (@as(u32, 1) << GEN_BITS) - 1;
pub const SLOT_MASK: u32 = (@as(u32, 1) << SLOT_BITS) - 1;
pub const MAX_URL_LENGTH: usize = 512;
const RETIRED_GENERATION = GEN_MASK + 1;

pub const IdPayload = u32;

/// Bytes appended to a URL to form the intern key of a fragment entry.
const KEY_SUFFIX_BYTES = @sizeOf(u32);

/// Interning identity of an entry: the URL bytes followed by the little-endian fragment key.
/// Two entries share an id only when both their URL and their key are equal.
const InternKey = struct {
    bytes: [MAX_URL_LENGTH + KEY_SUFFIX_BYTES]u8 = undefined,
    len: usize = 0,

    fn init(url: []const u8, key: u32) InternKey {
        assert(url.len <= MAX_URL_LENGTH);
        var value: InternKey = .{ .len = url.len + KEY_SUFFIX_BYTES };
        @memcpy(value.bytes[0..url.len], url);
        std.mem.writeInt(u32, value.bytes[url.len..][0..KEY_SUFFIX_BYTES], key, .little);
        return value;
    }

    fn slice(self: *const InternKey) []const u8 {
        return self.bytes[0..self.len];
    }
};

const SlotHeader = extern struct {
    len: u32,
    refcount: u32,
    generation: u32,
    /// Application fragment key; 0 for an entry that carries only a URL.
    key: u32,
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
            .slots = .empty,
            .free_list = .empty,
            .num_slots = 0,
            .retired_slot_count = 0,
            .interned_live_ids = .empty,
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

        const new_num_slots = self.num_slots + self.slots_per_page;
        const add_bytes = self.slot_size_bytes * self.slots_per_page;

        try self.slots.ensureTotalCapacity(self.allocator, self.slots.items.len + add_bytes);
        // Every published slot must be able to return without allocating.
        try self.free_list.ensureTotalCapacity(self.allocator, new_num_slots);
        self.slots.appendNTimesAssumeCapacity(0, add_bytes);

        var i: u32 = 0;
        while (i < self.slots_per_page) : (i += 1) {
            self.free_list.appendAssumeCapacity(self.num_slots + i);
        }
        self.num_slots = new_num_slots;
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

    fn removeInternedLiveId(self: *LinkPool, url: []const u8, key: u32, id: IdPayload) void {
        const intern_key = InternKey.init(url, key);
        const removed = self.interned_live_ids.fetchRemove(intern_key.slice()).?;
        assert(removed.value == id);
        self.allocator.free(@constCast(removed.key));
    }

    /// The map holds exactly the live IDs: acquireNew adds an entry after its
    /// last fallible step, and the decref that releases the slot removes it.
    fn lookupLive(self: *LinkPool, url: []const u8, key: u32) ?IdPayload {
        const intern_key = InternKey.init(url, key);
        const id = self.interned_live_ids.get(intern_key.slice()) orelse return null;
        if (std.debug.runtime_safety) {
            assert(std.mem.eql(u8, self.get(id) catch unreachable, url));
            assert((self.getKey(id) catch unreachable) == key);
            assert((self.getRefcount(id) catch unreachable) > 0);
        }
        return id;
    }

    /// The live id for a URL entry without a fragment key, if any.
    pub fn lookupLiveUrl(self: *LinkPool, url: []const u8) ?IdPayload {
        if (url.len > MAX_URL_LENGTH) return null;
        return self.lookupLive(url, 0);
    }

    fn internLiveId(self: *LinkPool, id: IdPayload, url: []const u8, key: u32) LinkPoolError!void {
        const intern_key = InternKey.init(url, key);
        const owned_key = try self.allocator.dupe(u8, intern_key.slice());
        errdefer self.allocator.free(owned_key);
        try self.interned_live_ids.putNoClobber(self.allocator, owned_key, id);
    }

    /// Return one owned live reference. Failed acquisition leaves no stranded
    /// slot or interned identity. Internal pages may remain allocated.
    pub fn acquire(self: *LinkPool, url: []const u8) LinkPoolError!IdPayload {
        return self.acquireFragment(url, 0);
    }

    /// Like acquire, for an entry identified by both a URL and an application fragment key.
    /// url may be empty when key is non-zero; such an entry carries no hyperlink, and
    /// renderers never emit it as OSC 8. An empty URL with key 0 is not an entry.
    pub fn acquireFragment(self: *LinkPool, url: []const u8, key: u32) LinkPoolError!IdPayload {
        if (url.len > self.slot_capacity) {
            return LinkPoolError.UrlTooLong;
        }
        if (url.len == 0 and key == 0) return LinkPoolError.InvalidId;
        if (self.lookupLive(url, key)) |live_id| {
            try self.incref(live_id);
            return live_id;
        }
        return self.acquireNew(url, key);
    }

    fn acquireNew(self: *LinkPool, url: []const u8, key: u32) LinkPoolError!IdPayload {
        var copy: [MAX_URL_LENGTH]u8 = undefined;
        @memcpy(copy[0..url.len], url);
        const owned = copy[0..url.len];

        if (self.free_list.items.len == 0) try self.grow();

        const slot_index = self.free_list.pop().?;
        const p = self.slotPtr(slot_index);
        const header_ptr = slotHeaderPtr(p);

        assert(header_ptr.generation < GEN_MASK);
        const new_generation = header_ptr.generation + 1;
        header_ptr.* = .{
            .len = @intCast(owned.len),
            .refcount = 0,
            .generation = new_generation,
            .key = key,
        };
        const data_ptr = @as([*]u8, @ptrCast(p)) + @sizeOf(SlotHeader);
        @memcpy(data_ptr[0..owned.len], owned);
        errdefer self.releaseSlot(slot_index, new_generation);

        const id = try packId(slot_index, new_generation);
        try self.internLiveId(id, owned, key);
        header_ptr.refcount = 1;
        return id;
    }

    fn releaseSlot(self: *LinkPool, slot_index: u32, expected_generation: u32) void {
        const p = self.slotPtr(slot_index);
        const header_ptr = slotHeaderPtr(p);
        assert(header_ptr.generation == expected_generation);
        assert(header_ptr.refcount == 0);
        assert(self.free_list.items.len + self.retired_slot_count < self.num_slots);
        if (header_ptr.generation == GEN_MASK) {
            header_ptr.generation = RETIRED_GENERATION;
            self.retired_slot_count += 1;
        } else {
            self.free_list.appendAssumeCapacity(slot_index);
        }
    }

    /// Retain an already-live ID. First-use interning stays inside acquire.
    pub fn incref(self: *LinkPool, id: IdPayload) LinkPoolError!void {
        const unpacked = unpackId(id);
        if (unpacked.slot_index >= self.num_slots) return LinkPoolError.InvalidId;

        const p = self.slotPtr(unpacked.slot_index);
        const header_ptr = slotHeaderPtr(p);

        if (header_ptr.generation != unpacked.generation) {
            return LinkPoolError.WrongGeneration;
        }
        if (header_ptr.refcount == 0) return LinkPoolError.InvalidId;
        if (header_ptr.refcount == std.math.maxInt(u32)) return LinkPoolError.RefcountOverflow;
        header_ptr.refcount += 1;
    }

    pub fn decref(self: *LinkPool, id: IdPayload) LinkPoolError!void {
        const unpacked = unpackId(id);
        if (unpacked.slot_index >= self.num_slots) return LinkPoolError.InvalidId;

        const p = self.slotPtr(unpacked.slot_index);
        const header_ptr = slotHeaderPtr(p);

        if (header_ptr.refcount == 0) return LinkPoolError.InvalidId;
        if (header_ptr.generation != unpacked.generation) return LinkPoolError.WrongGeneration;

        if (header_ptr.refcount == 1) {
            self.removeInternedLiveId(self.get(id) catch unreachable, header_ptr.key, id);
        }

        header_ptr.refcount -%= 1;

        if (header_ptr.refcount == 0) {
            self.releaseSlot(unpacked.slot_index, unpacked.generation);
        }
    }

    /// The id to emit as an OSC 8 hyperlink for a cell link id: the id itself when its entry has a
    /// URL, else 0. Key-only fragment entries, and unknown ids, are not hyperlinks.
    pub fn hyperlinkId(self: *LinkPool, id: IdPayload) IdPayload {
        if (id == 0) return 0;
        const url = self.get(id) catch return 0;
        return if (url.len == 0) 0 else id;
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

    /// The application fragment key of an entry; 0 when the entry carries only a URL.
    pub fn getKey(self: *LinkPool, id: IdPayload) LinkPoolError!u32 {
        const unpacked = unpackId(id);
        if (unpacked.slot_index >= self.num_slots) return LinkPoolError.InvalidId;
        const header_ptr = slotHeaderPtr(self.slotPtr(unpacked.slot_index));
        if (header_ptr.generation != unpacked.generation) return LinkPoolError.WrongGeneration;
        return header_ptr.key;
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

    /// Track document membership once per URL, independent of its chunk count.
    pub fn trackUrl(self: *LinkTracker, url: []const u8) LinkPoolError!IdPayload {
        return self.trackFragment(url, 0);
    }

    /// Track document membership once per (url, key) entry, independent of its chunk count.
    pub fn trackFragment(self: *LinkTracker, url: []const u8, key: u32) LinkPoolError!IdPayload {
        if (url.len <= MAX_URL_LENGTH) {
            if (self.pool.lookupLive(url, key)) |id| {
                if (self.used_ids.contains(id)) return id;
            }
        }
        const id = try self.pool.acquireFragment(url, key);
        errdefer self.pool.decref(id) catch unreachable;
        try self.used_ids.put(id, 1);
        return id;
    }

    pub fn addCellRef(self: *LinkTracker, id: u32) void {
        self.tryAddCellRef(id) catch |err| {
            std.debug.panic("LinkTracker.addCellRef getOrPut failed: {}\n", .{err});
        };
    }

    /// Like addCellRef, but reports allocation failure instead of aborting. An id whose pool
    /// slot cannot take another reference is skipped, as in addCellRef.
    pub fn tryAddCellRef(self: *LinkTracker, id: u32) std.mem.Allocator.Error!void {
        const res = try self.used_ids.getOrPut(id);
        if (!res.found_existing) {
            self.pool.incref(id) catch {
                _ = self.used_ids.remove(id);
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
