const std = @import("std");
const assert = std.debug.assert;

pub const GraphemePoolError = error{
    OutOfMemory,
    GraphemeTooLong,
    InvalidId,
    WrongGeneration,
};

// Encoding flags for char buffer entries (u32)
// Bits 31-30: encoding type
//   00xxxxxxxx: direct unicode scalar value (30 bits, as-is)
//   10xxxxxxxx: grapheme start cell with pool ID (26 bits total payload)
//   11xxxxxxxx: continuation cell marker for wide/grapheme rendering
pub const CHAR_FLAG_GRAPHEME: u32 = 0x8000_0000;
pub const CHAR_FLAG_CONTINUATION: u32 = 0xC000_0000;

// For grapheme start and continuation cells:
// Bits 29..28: right extent (u2), Bits 27..26: left extent (u2)
pub const CHAR_EXT_RIGHT_SHIFT: u5 = 28;
pub const CHAR_EXT_LEFT_SHIFT: u5 = 26;
pub const CHAR_EXT_MASK: u32 = 0x3;

// Grapheme ID payload layout (26 bits total):
// [ class (3 bits) | generation (7 bits) | slot_index (16 bits) ]
pub const GRAPHEME_ID_MASK: u32 = 0x03FF_FFFF;
pub const CLASS_BITS: u5 = 3;
pub const GENERATION_BITS: u5 = 7;
pub const SLOT_BITS: u5 = 16;
pub const CLASS_MASK: u32 = (@as(u32, 1) << CLASS_BITS) - 1; // 0b111
pub const GENERATION_MASK: u32 = (@as(u32, 1) << GENERATION_BITS) - 1; // 0b1111111
pub const SLOT_MASK: u32 = (@as(u32, 1) << SLOT_BITS) - 1; // 0xFFFF

comptime {
    assert(CLASS_BITS + GENERATION_BITS + SLOT_BITS == 26);
    assert(GRAPHEME_ID_MASK == (@as(u32, 1) << (CLASS_BITS + GENERATION_BITS + SLOT_BITS)) - 1);
    assert((CHAR_FLAG_GRAPHEME & GRAPHEME_ID_MASK) == 0);
    assert((CHAR_FLAG_CONTINUATION & GRAPHEME_ID_MASK) == 0);
    assert(CHAR_FLAG_GRAPHEME != CHAR_FLAG_CONTINUATION);
}

/// Global slab-allocated pool for grapheme clusters (byte slices)
/// This is total overkill probably, but fun
/// ID layout (26-bit payload):
/// [ class (3 bits) | generation (7 bits) | slot_index (16 bits) ]
pub const GraphemePool = struct {
    const MAX_CLASSES: u5 = 5; // 0..4 => 8,16,32,64,128
    const CLASS_SIZES = [_]u32{ 8, 16, 32, 64, 128 };
    const DEFAULT_SLOTS_PER_PAGE = [_]u32{ 256, 128, 64, 16, 8 };

    comptime {
        assert(CLASS_SIZES.len == MAX_CLASSES);
        assert(DEFAULT_SLOTS_PER_PAGE.len == MAX_CLASSES);
        assert(MAX_CLASSES <= (@as(u32, 1) << CLASS_BITS));
        assert(CLASS_SIZES[CLASS_SIZES.len - 1] <= std.math.maxInt(u16));
    }

    pub const IdPayload = u32;

    pub const InitOptions = struct {
        /// Slots per page for each size class. If null, uses DEFAULT_SLOTS_PER_PAGE.
        /// Used to limit pool size for testing.
        slots_per_page: ?[MAX_CLASSES]u32 = null,
    };

    allocator: std.mem.Allocator,
    classes: [MAX_CLASSES]ClassPool,
    interned_live_ids: std.StringHashMapUnmanaged(IdPayload),

    const SlotHeader = extern struct {
        len: u16,
        refcount: u32,
        generation: u32,
        is_owned: u32, // 0 = unowned (external memory), 1 = owned (copied into pool)
        is_allocated: u32, // 0 = free slot, 1 = pending or referenced slot.
    };

    pub fn init(allocator: std.mem.Allocator) GraphemePool {
        return initWithOptions(allocator, .{});
    }

    pub fn initWithOptions(allocator: std.mem.Allocator, options: InitOptions) GraphemePool {
        const slots_per_page = options.slots_per_page orelse DEFAULT_SLOTS_PER_PAGE;
        var classes: [MAX_CLASSES]ClassPool = undefined;
        var i: usize = 0;
        while (i < MAX_CLASSES) : (i += 1) {
            if (slots_per_page[i] == 0) {
                @panic("GraphemePool: slots_per_page must be non-zero");
            }
            assert(slots_per_page[i] > 0);
            classes[i] = ClassPool.init(allocator, CLASS_SIZES[i], slots_per_page[i]);
        }
        return .{ .allocator = allocator, .classes = classes, .interned_live_ids = .{} };
    }

    pub fn deinit(self: *GraphemePool) void {
        var key_it = self.interned_live_ids.keyIterator();
        while (key_it.next()) |key_ptr| {
            self.allocator.free(@constCast(key_ptr.*));
        }
        self.interned_live_ids.deinit(self.allocator);

        var i: usize = 0;
        while (i < MAX_CLASSES) : (i += 1) {
            self.classes[i].deinit();
        }

        self.* = undefined;
    }

    /// removeInternedLiveId removes an interned ID from the live set if it
    /// matches the expected ID.
    fn removeInternedLiveId(self: *GraphemePool, bytes: []const u8, expected_id: IdPayload) void {
        const live_id = self.interned_live_ids.get(bytes) orelse return;
        if (live_id != expected_id) return;
        if (self.interned_live_ids.fetchRemove(bytes)) |removed| {
            self.allocator.free(@constCast(removed.key));
        }
    }

    /// Return an existing interned live ID, removing stale entries encountered
    /// while validating the map.
    fn lookupOrInvalidate(self: *GraphemePool, bytes: []const u8) ?IdPayload {
        const live_id = self.interned_live_ids.get(bytes) orelse return null;

        // Verify that the live ID is still valid and matches the bytes. If get
        // fails, the ID is no longer valid, so remove it from the interned map.
        const live_bytes = self.get(live_id) catch {
            self.removeInternedLiveId(bytes, live_id);
            return null;
        };

        // If the bytes don't match, this means the ID was recycled and now points
        // to different data. Invalidate the interned ID.
        if (!std.mem.eql(u8, live_bytes, bytes)) {
            self.removeInternedLiveId(bytes, live_id);
            return null;
        }

        // check refcount > 0 to ensure the ID is still live. If refcount is 0,
        // the slot is free but hasn't been reused yet, so we can treat it as
        // not found.
        const live_refcount = self.getRefcount(live_id) catch {
            self.removeInternedLiveId(bytes, live_id);
            return null;
        };
        if (live_refcount == 0) {
            self.removeInternedLiveId(bytes, live_id);
            return null;
        }

        return live_id;
    }

    /// internLiveId interns the grapheme bytes.
    fn internLiveId(self: *GraphemePool, id: IdPayload, bytes: []const u8) GraphemePoolError!void {
        if (self.lookupOrInvalidate(bytes) != null) {
            // Keep existing interned ID if it's still valid.
            return;
        }

        const owned_key = self.allocator.dupe(u8, bytes) catch return GraphemePoolError.OutOfMemory;
        errdefer self.allocator.free(owned_key);

        if (self.interned_live_ids.fetchPut(
            self.allocator,
            owned_key,
            id,
        ) catch return GraphemePoolError.OutOfMemory) |replaced| {
            // A previous key allocation was replaced.
            self.allocator.free(@constCast(replaced.key));
        }
    }

    fn classForSize(size: usize) u32 {
        if (size <= 8) return 0;
        if (size <= 16) return 1;
        if (size <= 32) return 2;
        if (size <= 64) return 3;
        return 4; // up to 128
    }

    fn packId(class_id: u32, slot_index: u32, generation: u32) GraphemePoolError!IdPayload {
        assert(class_id < MAX_CLASSES);
        assert(generation <= GENERATION_MASK);
        if (slot_index > SLOT_MASK) return GraphemePoolError.OutOfMemory;
        const id = (class_id << (GENERATION_BITS + SLOT_BITS)) |
            ((generation & GENERATION_MASK) << SLOT_BITS) |
            (slot_index & SLOT_MASK);
        assert((id & ~GRAPHEME_ID_MASK) == 0);
        return id;
    }

    pub fn alloc(self: *GraphemePool, bytes: []const u8) GraphemePoolError!IdPayload {
        if (bytes.len > CLASS_SIZES[CLASS_SIZES.len - 1]) return GraphemePoolError.GraphemeTooLong;
        assert(bytes.len <= CLASS_SIZES[CLASS_SIZES.len - 1]);
        if (self.lookupOrInvalidate(bytes)) |live_id| {
            return live_id;
        }

        const class_id: u32 = classForSize(bytes.len);
        const slot_index = try self.classes[class_id].allocInternal(bytes, true);
        const generation = self.classes[class_id].getGeneration(slot_index);
        const id = try packId(class_id, slot_index, generation);
        assert((try self.getRefcount(id)) == 0);
        return id;
    }

    /// Allocate an ID for externally managed memory (no copy, just reference)
    /// The caller is responsible for keeping the memory valid while the ID is in use
    pub fn allocUnowned(self: *GraphemePool, bytes: []const u8) GraphemePoolError!IdPayload {
        // For unowned allocations, we need space for a pointer
        if (bytes.len > std.math.maxInt(u16)) return GraphemePoolError.GraphemeTooLong;
        assert(bytes.len <= std.math.maxInt(u16));
        const ptr_size = @sizeOf(usize);
        const class_id: u32 = classForSize(ptr_size);
        assert(ptr_size <= CLASS_SIZES[class_id]);
        const slot_index = try self.classes[class_id].allocInternal(bytes, false);
        const generation = self.classes[class_id].getGeneration(slot_index);
        const id = try packId(class_id, slot_index, generation);
        assert((try self.getRefcount(id)) == 0);
        return id;
    }

    pub fn incref(self: *GraphemePool, id: IdPayload) GraphemePoolError!void {
        const class_id: u32 = (id >> (GENERATION_BITS + SLOT_BITS)) & CLASS_MASK;
        if (class_id >= MAX_CLASSES) return GraphemePoolError.InvalidId;
        const slot_index: u32 = id & SLOT_MASK;
        const generation: u32 = (id >> SLOT_BITS) & GENERATION_MASK;
        const old_refcount = try self.classes[class_id].getRefcount(slot_index, generation);

        if (old_refcount == 0) {
            const is_owned = try self.classes[class_id].isOwned(slot_index, generation);
            if (is_owned) {
                // Intern before publishing the first live reference so OOM does
                // not leave the caller holding an unreported reference.
                const bytes = try self.classes[class_id].get(slot_index, generation);
                try self.internLiveId(id, bytes);
            }
        }

        try self.classes[class_id].incref(slot_index, generation);
        assert(
            (try self.classes[class_id].getRefcount(slot_index, generation)) ==
                old_refcount + 1,
        );
    }

    pub fn decref(self: *GraphemePool, id: IdPayload) GraphemePoolError!void {
        const class_id: u32 = (id >> (GENERATION_BITS + SLOT_BITS)) & CLASS_MASK;
        if (class_id >= MAX_CLASSES) return GraphemePoolError.InvalidId;
        const slot_index: u32 = id & SLOT_MASK;
        const generation: u32 = (id >> SLOT_BITS) & GENERATION_MASK;

        const old_refcount = try self.classes[class_id].getRefcount(slot_index, generation);
        if (old_refcount == 1) {
            const is_owned = try self.classes[class_id].isOwned(slot_index, generation);
            if (is_owned) {
                // This is a transition from 1 to 0 for owned bytes, remove map entry.
                const bytes = try self.classes[class_id].get(slot_index, generation);
                self.removeInternedLiveId(bytes, id);
            }
        }

        try self.classes[class_id].decref(slot_index, generation);
        if (old_refcount > 1) {
            assert(
                (try self.classes[class_id].getRefcount(slot_index, generation)) + 1 ==
                    old_refcount,
            );
        } else {
            assert(old_refcount == 1);
            if (self.classes[class_id].getRefcount(slot_index, generation)) |_| {
                unreachable;
            } else |err| {
                assert(err == GraphemePoolError.InvalidId);
            }
        }
    }

    /// Free a freshly allocated slot that was never incref'd (refcount=0).
    /// Use this for cleanup when allocation succeeded but the slot was never used.
    /// This prevents slot leaks when an error occurs between alloc and incref.
    pub fn freeUnreferenced(self: *GraphemePool, id: IdPayload) GraphemePoolError!void {
        const class_id: u32 = (id >> (GENERATION_BITS + SLOT_BITS)) & CLASS_MASK;
        if (class_id >= MAX_CLASSES) return GraphemePoolError.InvalidId;
        const slot_index: u32 = id & SLOT_MASK;
        const generation: u32 = (id >> SLOT_BITS) & GENERATION_MASK;

        const is_owned = try self.classes[class_id].isOwned(slot_index, generation);
        if (is_owned) {
            const bytes = try self.classes[class_id].get(slot_index, generation);
            self.removeInternedLiveId(bytes, id);
        }

        try self.classes[class_id].freeUnreferenced(slot_index, generation);
    }

    pub fn get(self: *GraphemePool, id: IdPayload) GraphemePoolError![]const u8 {
        const class_id: u32 = (id >> (GENERATION_BITS + SLOT_BITS)) & CLASS_MASK;
        if (class_id >= MAX_CLASSES) return GraphemePoolError.InvalidId;
        const slot_index: u32 = id & SLOT_MASK;
        const generation: u32 = (id >> SLOT_BITS) & GENERATION_MASK;
        return self.classes[class_id].get(slot_index, generation);
    }

    pub fn getRefcount(self: *GraphemePool, id: IdPayload) GraphemePoolError!u32 {
        const class_id: u32 = (id >> (GENERATION_BITS + SLOT_BITS)) & CLASS_MASK;
        if (class_id >= MAX_CLASSES) return GraphemePoolError.InvalidId;
        const slot_index: u32 = id & SLOT_MASK;
        const generation: u32 = (id >> SLOT_BITS) & GENERATION_MASK;
        return self.classes[class_id].getRefcount(slot_index, generation);
    }

    const ClassPool = struct {
        allocator: std.mem.Allocator,
        slot_capacity: u32,
        slots_per_page: u32,
        slot_size_bytes: usize,
        slots: std.array_list.Aligned(u8, std.mem.Alignment.of(SlotHeader)),
        free_list: std.ArrayListUnmanaged(u32),
        num_slots: u32,

        pub fn init(
            allocator: std.mem.Allocator,
            slot_capacity: u32,
            slots_per_page: u32,
        ) ClassPool {
            assert(slot_capacity > 0);
            assert(slots_per_page > 0);
            // Align slot size to SlotHeader alignment to prevent UB from misaligned access
            const raw_slot_size = @sizeOf(SlotHeader) + slot_capacity;
            const slot_size_bytes = std.mem.alignForward(
                usize,
                raw_slot_size,
                @alignOf(SlotHeader),
            );
            return .{
                .allocator = allocator,
                .slot_capacity = slot_capacity,
                .slots_per_page = slots_per_page,
                .slot_size_bytes = slot_size_bytes,
                .slots = .{},
                .free_list = .{},
                .num_slots = 0,
            };
        }

        fn assertInvariants(self: *const ClassPool) void {
            assert(self.slot_capacity > 0);
            assert(self.slots_per_page > 0);
            assert(self.slot_size_bytes >= @sizeOf(SlotHeader) + self.slot_capacity);
            assert(self.slot_size_bytes % @alignOf(SlotHeader) == 0);
            assert(self.slots.items.len == @as(usize, self.num_slots) * self.slot_size_bytes);
            assert(self.free_list.items.len <= self.num_slots);
            assert(self.free_list.capacity >= self.num_slots);
            if (self.num_slots > 0) {
                assert(@intFromPtr(self.slots.items.ptr) % @alignOf(SlotHeader) == 0);
            }
        }

        pub fn deinit(self: *ClassPool) void {
            self.slots.deinit(self.allocator);
            self.free_list.deinit(self.allocator);
            self.* = undefined;
        }

        fn grow(self: *ClassPool) GraphemePoolError!void {
            self.assertInvariants();
            if (self.slots_per_page > SLOT_MASK + 1) return GraphemePoolError.OutOfMemory;
            if (self.num_slots > SLOT_MASK + 1 - self.slots_per_page) {
                return GraphemePoolError.OutOfMemory;
            }
            const add_bytes = self.slot_size_bytes * self.slots_per_page;
            const free_slots_before = self.free_list.items.len;

            // Reserve both arrays first so an OOM cannot commit only half a page.
            try self.slots.ensureUnusedCapacity(self.allocator, add_bytes);
            try self.free_list.ensureTotalCapacity(
                self.allocator,
                @as(usize, self.num_slots) + self.slots_per_page,
            );
            self.slots.appendNTimesAssumeCapacity(0, add_bytes);

            var i: u32 = 0;
            while (i < self.slots_per_page) : (i += 1) {
                self.free_list.appendAssumeCapacity(self.num_slots + i);
            }
            self.num_slots += self.slots_per_page;
            assert(self.free_list.items.len == free_slots_before + @as(usize, self.slots_per_page));
            self.assertInvariants();
        }

        fn slotPtr(self: *ClassPool, slot_index: u32) *u8 {
            self.assertInvariants();
            assert(slot_index < self.num_slots);
            const offset: usize = @as(usize, slot_index) * self.slot_size_bytes;
            assert(offset + self.slot_size_bytes <= self.slots.items.len);
            return &self.slots.items[offset];
        }

        fn slotHeaderPtr(p: *u8) *align(1) SlotHeader {
            return @ptrCast(p);
        }

        pub fn allocInternal(
            self: *ClassPool,
            bytes: []const u8,
            is_owned: bool,
        ) GraphemePoolError!u32 {
            self.assertInvariants();
            if (is_owned and bytes.len > self.slot_capacity) {
                return GraphemePoolError.GraphemeTooLong;
            }
            if (!is_owned and bytes.len > std.math.maxInt(u16)) {
                return GraphemePoolError.GraphemeTooLong;
            }
            if (is_owned) assert(bytes.len <= self.slot_capacity);
            if (!is_owned) assert(bytes.len <= std.math.maxInt(u16));

            if (self.free_list.items.len == 0) try self.grow();

            const free_slots_before = self.free_list.items.len;
            const slot_index = self.free_list.pop().?;
            assert(slot_index < self.num_slots);
            assert(self.free_list.items.len + 1 == free_slots_before);
            const p = self.slotPtr(slot_index);
            const header_ptr = slotHeaderPtr(p);
            assert(header_ptr.refcount == 0);
            assert(header_ptr.is_allocated == 0);

            // Increment generation when reusing a slot, wrapping at 7 bits (128 values)
            const new_generation = (header_ptr.generation + 1) & GENERATION_MASK;

            // Calculate length based on ownership
            const len: u16 = if (is_owned)
                @intCast(@min(bytes.len, self.slot_capacity))
            else
                @intCast(bytes.len);

            header_ptr.* = .{
                .len = len,
                .refcount = 0,
                .generation = new_generation,
                .is_owned = if (is_owned) 1 else 0,
                .is_allocated = 1,
            };

            const data_ptr = @as([*]u8, @ptrCast(p)) + @sizeOf(SlotHeader);

            if (is_owned) {
                // Owned: copy bytes into our storage
                @memcpy(data_ptr[0..header_ptr.len], bytes[0..header_ptr.len]);
            } else {
                // Store the pointer as bytes because u8 slab storage does not
                // guarantee native pointer alignment.
                std.mem.writeInt(
                    usize,
                    data_ptr[0..@sizeOf(usize)],
                    @intFromPtr(bytes.ptr),
                    .little,
                );
            }

            assert(header_ptr.generation <= GENERATION_MASK);
            assert(header_ptr.refcount == 0);
            assert(header_ptr.is_owned == @as(u32, if (is_owned) 1 else 0));
            assert(header_ptr.is_allocated == 1);
            return slot_index;
        }

        pub fn getGeneration(self: *ClassPool, slot_index: u32) u32 {
            assert(slot_index < self.num_slots);
            const p = self.slotPtr(slot_index);
            const header_ptr = slotHeaderPtr(p);
            assert(header_ptr.is_allocated == 1);
            assert(header_ptr.generation <= GENERATION_MASK);
            return header_ptr.generation;
        }

        pub fn incref(
            self: *ClassPool,
            slot_index: u32,
            expected_generation: u32,
        ) GraphemePoolError!void {
            self.assertInvariants();
            if (slot_index >= self.num_slots) return GraphemePoolError.InvalidId;
            const p = self.slotPtr(slot_index);
            const header_ptr = slotHeaderPtr(p);
            if (header_ptr.generation != expected_generation) {
                // Generation mismatch - this is a stale reference
                return GraphemePoolError.WrongGeneration;
            }
            if (header_ptr.is_allocated != 1) return GraphemePoolError.InvalidId;
            assert(header_ptr.refcount < std.math.maxInt(u32));
            header_ptr.refcount +%= 1;
            assert(header_ptr.refcount > 0);
        }

        pub fn decref(
            self: *ClassPool,
            slot_index: u32,
            expected_generation: u32,
        ) GraphemePoolError!void {
            self.assertInvariants();
            if (slot_index >= self.num_slots) return GraphemePoolError.InvalidId;
            const p = self.slotPtr(slot_index);
            const header_ptr = slotHeaderPtr(p);

            if (header_ptr.generation != expected_generation) {
                return GraphemePoolError.WrongGeneration;
            }
            if (header_ptr.is_allocated != 1) return GraphemePoolError.InvalidId;
            if (header_ptr.refcount == 0) return GraphemePoolError.InvalidId;

            header_ptr.refcount -%= 1;

            if (header_ptr.refcount == 0) {
                header_ptr.is_allocated = 0;
                const free_slots_before = self.free_list.items.len;
                assert(self.free_list.capacity > self.free_list.items.len);
                self.free_list.appendAssumeCapacity(slot_index);
                assert(self.free_list.items.len == free_slots_before + 1);
            }
            self.assertInvariants();
        }

        /// Free a slot that has refcount=0 (freshly allocated, never incref'd).
        /// This is used for cleanup when allocation succeeded but the caller
        /// needs to abort before taking ownership via incref.
        pub fn freeUnreferenced(
            self: *ClassPool,
            slot_index: u32,
            expected_generation: u32,
        ) GraphemePoolError!void {
            if (slot_index >= self.num_slots) return GraphemePoolError.InvalidId;
            const p = self.slotPtr(slot_index);
            const header_ptr = slotHeaderPtr(p);

            if (header_ptr.generation != expected_generation) {
                return GraphemePoolError.WrongGeneration;
            }
            if (header_ptr.is_allocated != 1) return GraphemePoolError.InvalidId;
            if (header_ptr.refcount != 0) return GraphemePoolError.InvalidId; // Not unreferenced

            header_ptr.is_allocated = 0;
            const free_slots_before = self.free_list.items.len;
            assert(self.free_list.capacity > self.free_list.items.len);
            self.free_list.appendAssumeCapacity(slot_index);
            assert(self.free_list.items.len == free_slots_before + 1);
            self.assertInvariants();
        }

        pub fn get(
            self: *ClassPool,
            slot_index: u32,
            expected_generation: u32,
        ) GraphemePoolError![]const u8 {
            if (slot_index >= self.num_slots) return GraphemePoolError.InvalidId;

            const p = self.slotPtr(slot_index);
            const header_ptr = slotHeaderPtr(p);
            // Validate generation to prevent accessing stale data
            if (header_ptr.generation != expected_generation) {
                return GraphemePoolError.WrongGeneration;
            }
            if (header_ptr.is_allocated != 1) return GraphemePoolError.InvalidId;
            assert(header_ptr.is_owned == 0 or header_ptr.is_owned == 1);
            if (header_ptr.is_owned == 1) assert(header_ptr.len <= self.slot_capacity);

            const data_ptr = @as([*]u8, @ptrCast(p)) + @sizeOf(SlotHeader);

            if (header_ptr.is_owned == 1) {
                // Owned memory: return slice from our storage
                return data_ptr[0..header_ptr.len];
            } else {
                // Unowned memory: decode the possibly unaligned stored pointer.
                const pointer_address = std.mem.readInt(
                    usize,
                    data_ptr[0..@sizeOf(usize)],
                    .little,
                );
                const external_ptr: [*]const u8 = @ptrFromInt(pointer_address);
                return external_ptr[0..header_ptr.len];
            }
        }

        pub fn getRefcount(
            self: *ClassPool,
            slot_index: u32,
            expected_generation: u32,
        ) GraphemePoolError!u32 {
            if (slot_index >= self.num_slots) return GraphemePoolError.InvalidId;
            const p = self.slotPtr(slot_index);
            const header_ptr = slotHeaderPtr(p);
            if (header_ptr.generation != expected_generation) {
                return GraphemePoolError.WrongGeneration;
            }
            if (header_ptr.is_allocated != 1) return GraphemePoolError.InvalidId;
            assert(header_ptr.generation <= GENERATION_MASK);
            return header_ptr.refcount;
        }

        pub fn isOwned(
            self: *ClassPool,
            slot_index: u32,
            expected_generation: u32,
        ) GraphemePoolError!bool {
            if (slot_index >= self.num_slots) return GraphemePoolError.InvalidId;
            const p = self.slotPtr(slot_index);
            const header_ptr = slotHeaderPtr(p);
            if (header_ptr.generation != expected_generation) {
                return GraphemePoolError.WrongGeneration;
            }
            if (header_ptr.is_allocated != 1) return GraphemePoolError.InvalidId;
            assert(header_ptr.is_owned == 0 or header_ptr.is_owned == 1);
            return header_ptr.is_owned == 1;
        }
    };
};

// Bit manipulation functions for encoded char values

pub fn isGraphemeChar(c: u32) bool {
    return (c & 0xC000_0000) == CHAR_FLAG_GRAPHEME;
}

pub fn isContinuationChar(c: u32) bool {
    return (c & 0xC000_0000) == CHAR_FLAG_CONTINUATION;
}

pub fn isClusterChar(c: u32) bool {
    return (c & 0x8000_0000) == 0x8000_0000;
}

pub fn graphemeIdFromChar(c: u32) u32 {
    assert(isClusterChar(c));
    return c & GRAPHEME_ID_MASK;
}

pub fn charRightExtent(c: u32) u32 {
    assert(isClusterChar(c));
    return (c >> CHAR_EXT_RIGHT_SHIFT) & CHAR_EXT_MASK;
}

pub fn charLeftExtent(c: u32) u32 {
    assert(isClusterChar(c));
    return (c >> CHAR_EXT_LEFT_SHIFT) & CHAR_EXT_MASK;
}

pub fn packGraphemeStart(gid: u32, total_width: u32) u32 {
    assert(gid <= GRAPHEME_ID_MASK);
    assert(total_width > 0);
    // The packed extent is capped; wcwidth clusters such as ZWJ families can
    // have a wider logical display width than the four-cell encoded span.
    const width_minus_one: u32 = @min(total_width - 1, CHAR_EXT_MASK);
    const right: u32 = width_minus_one;
    const left: u32 = 0;
    const char = CHAR_FLAG_GRAPHEME |
        ((right & CHAR_EXT_MASK) << CHAR_EXT_RIGHT_SHIFT) |
        ((left & CHAR_EXT_MASK) << CHAR_EXT_LEFT_SHIFT) |
        (gid & GRAPHEME_ID_MASK);
    assert(isGraphemeChar(char));
    assert(graphemeIdFromChar(char) == gid);
    assert(charLeftExtent(char) == 0);
    return char;
}

pub fn packContinuation(left: u32, right: u32, gid: u32) u32 {
    assert(gid <= GRAPHEME_ID_MASK);
    assert(left <= CHAR_EXT_MASK);
    assert(right <= CHAR_EXT_MASK);
    const char = CHAR_FLAG_CONTINUATION |
        ((left & CHAR_EXT_MASK) << CHAR_EXT_LEFT_SHIFT) |
        ((right & CHAR_EXT_MASK) << CHAR_EXT_RIGHT_SHIFT) |
        (gid & GRAPHEME_ID_MASK);
    assert(isContinuationChar(char));
    assert(graphemeIdFromChar(char) == gid);
    assert(charLeftExtent(char) == left);
    assert(charRightExtent(char) == right);
    return char;
}

pub fn encodedCharWidth(c: u32) u32 {
    if (isContinuationChar(c)) {
        const left = charLeftExtent(c);
        const right = charRightExtent(c);
        return left + 1 + right;
    } else if (isGraphemeChar(c)) {
        return charRightExtent(c) + 1;
    } else {
        return 1;
    }
}

var GLOBAL_POOL_STORAGE: ?GraphemePool = null;

pub fn initGlobalPool(allocator: std.mem.Allocator) *GraphemePool {
    return initGlobalPoolWithOptions(allocator, .{});
}

pub fn initGlobalPoolWithOptions(
    allocator: std.mem.Allocator,
    options: GraphemePool.InitOptions,
) *GraphemePool {
    if (GLOBAL_POOL_STORAGE == null) {
        GLOBAL_POOL_STORAGE = GraphemePool.initWithOptions(allocator, options);
    }
    return &GLOBAL_POOL_STORAGE.?;
}

pub fn deinitGlobalPool() void {
    if (GLOBAL_POOL_STORAGE) |*p| {
        p.deinit();
        GLOBAL_POOL_STORAGE = null;
    }
}

pub const GraphemeTracker = struct {
    pool: *GraphemePool,
    used_ids: std.AutoHashMap(u32, u32), // id -> number of cells in this buffer

    pub fn init(allocator: std.mem.Allocator, pool: *GraphemePool) GraphemeTracker {
        return .{
            .pool = pool,
            .used_ids = std.AutoHashMap(u32, u32).init(allocator),
        };
    }

    fn decRefAll(self: *GraphemeTracker) void {
        var it = self.used_ids.keyIterator();
        while (it.next()) |idp| {
            // Pool refs are tracked per ID (first/last cell transition), so clear
            // decrefs once per tracked ID, not once per per-buffer cell count.
            self.pool.decref(idp.*) catch |err| {
                std.debug.panic("GraphemeTracker.decRefAll decref failed: {}\n", .{err});
            };
        }
    }

    pub fn deinit(self: *GraphemeTracker) void {
        self.decRefAll();
        self.used_ids.deinit();
        self.* = undefined;
    }

    pub fn clear(self: *GraphemeTracker) void {
        self.decRefAll();
        self.used_ids.clearRetainingCapacity();
    }

    pub fn add(self: *GraphemeTracker, id: u32) void {
        const res = self.used_ids.getOrPut(id) catch |err| {
            std.debug.panic("GraphemeTracker.add failed: {}\n", .{err});
        };
        if (!res.found_existing) {
            res.value_ptr.* = 1;
            self.pool.incref(id) catch |err| {
                std.debug.panic("GraphemeTracker.add incref failed: {}\n", .{err});
            };
        } else {
            assert(res.value_ptr.* > 0);
            assert(res.value_ptr.* < std.math.maxInt(u32));
            res.value_ptr.* += 1;
        }
        assert(res.value_ptr.* > 0);
    }

    pub fn remove(self: *GraphemeTracker, id: u32) void {
        const count_ptr = self.used_ids.getPtr(id) orelse return;
        assert(count_ptr.* > 0);
        if (count_ptr.* > 1) {
            count_ptr.* -= 1;
            assert(count_ptr.* > 0);
            return;
        }

        const removed = self.used_ids.remove(id);
        assert(removed);
        if (removed) {
            self.pool.decref(id) catch |err| {
                std.debug.panic("GraphemeTracker.remove decref failed: {}\n", .{err});
            };
        }
    }

    pub fn replace(self: *GraphemeTracker, old_id: ?u32, new_id: ?u32) void {
        if (old_id != null and new_id != null and old_id.? == new_id.?) return;

        if (new_id) |id| self.add(id);
        if (old_id) |id| self.remove(id);
    }

    pub fn contains(self: *const GraphemeTracker, id: u32) bool {
        return self.used_ids.contains(id);
    }

    pub fn hasAny(self: *const GraphemeTracker) bool {
        return self.used_ids.count() > 0;
    }

    pub fn getGraphemeCount(self: *const GraphemeTracker) u32 {
        assert(self.used_ids.count() <= std.math.maxInt(u32));
        return @intCast(self.used_ids.count());
    }

    pub fn getGraphemeCellCount(self: *const GraphemeTracker) u32 {
        var total: u32 = 0;
        var it = self.used_ids.valueIterator();
        while (it.next()) |count_ptr| {
            assert(count_ptr.* > 0);
            assert(total <= std.math.maxInt(u32) - count_ptr.*);
            total += count_ptr.*;
        }
        return total;
    }

    pub fn getTotalGraphemeBytes(self: *const GraphemeTracker) u32 {
        var total_bytes: u32 = 0;
        var it = self.used_ids.iterator();
        while (it.next()) |entry| {
            const id = entry.key_ptr.*;
            const count = entry.value_ptr.*;
            if (self.pool.get(id)) |bytes| {
                assert(count > 0);
                const bytes_count: u32 = @intCast(bytes.len);
                assert(bytes_count == 0 or count <= std.math.maxInt(u32) / bytes_count);
                const bytes_total = bytes_count * count;
                assert(total_bytes <= std.math.maxInt(u32) - bytes_total);
                total_bytes += bytes_total;
            } else |err| {
                std.debug.panic("GraphemeTracker.getTotalGraphemeBytes get failed: {}\n", .{err});
            }
        }
        return total_bytes;
    }
};
