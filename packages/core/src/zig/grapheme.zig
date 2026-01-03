const std = @import("std");

pub const GraphemePoolError = error{
    OutOfMemory,
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

/// Global slab-allocated pool for grapheme clusters (byte slices)
/// This is total overkill probably, but fun
/// ID layout (26-bit payload):
/// [ class (3 bits) | generation (7 bits) | slot_index (16 bits) ]
pub const GraphemePool = struct {
    const MAX_CLASSES: u5 = 5; // 0..4 => 8,16,32,64,128
    const CLASS_SIZES = [_]u32{ 8, 16, 32, 64, 128 };
    const DEFAULT_SLOTS_PER_PAGE = [_]u32{ 256, 128, 64, 16, 8 };

    pub const IdPayload = u32;

    pub const InitOptions = struct {
        /// Slots per page for each size class. If null, uses DEFAULT_SLOTS_PER_PAGE.
        /// Used to limit pool size for testing.
        slots_per_page: ?[MAX_CLASSES]u32 = null,
    };

    allocator: std.mem.Allocator,
    classes: [MAX_CLASSES]ClassPool,

    const SlotHeader = extern struct {
        len: u16,
        refcount: u32,
        generation: u32,
        is_owned: u32, // 0 = unowned (external memory), 1 = owned (copied into pool)
    };

    pub fn init(allocator: std.mem.Allocator) GraphemePool {
        return initWithOptions(allocator, .{});
    }

    pub fn initWithOptions(allocator: std.mem.Allocator, options: InitOptions) GraphemePool {
        const slots_per_page = options.slots_per_page orelse DEFAULT_SLOTS_PER_PAGE;
        var classes: [MAX_CLASSES]ClassPool = undefined;
        var i: usize = 0;
        while (i < MAX_CLASSES) : (i += 1) {
            classes[i] = ClassPool.init(allocator, CLASS_SIZES[i], slots_per_page[i]);
        }
        return .{ .allocator = allocator, .classes = classes };
    }

    pub fn deinit(self: *GraphemePool) void {
        var i: usize = 0;
        while (i < MAX_CLASSES) : (i += 1) {
            self.classes[i].deinit();
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
        if (slot_index > SLOT_MASK) return GraphemePoolError.OutOfMemory;
        return (class_id << (GENERATION_BITS + SLOT_BITS)) |
            ((generation & GENERATION_MASK) << SLOT_BITS) |
            (slot_index & SLOT_MASK);
    }

    pub fn alloc(self: *GraphemePool, bytes: []const u8) GraphemePoolError!IdPayload {
        const class_id: u32 = classForSize(bytes.len);
        const slot_index = try self.classes[class_id].allocInternal(bytes, true);
        const generation = self.classes[class_id].getGeneration(slot_index);
        return try packId(class_id, slot_index, generation);
    }

    /// Allocate an ID for externally managed memory (no copy, just reference)
    /// The caller is responsible for keeping the memory valid while the ID is in use
    pub fn allocUnowned(self: *GraphemePool, bytes: []const u8) GraphemePoolError!IdPayload {
        // For unowned allocations, we need space for a pointer
        const ptr_size = @sizeOf(usize);
        const class_id: u32 = classForSize(ptr_size);
        const slot_index = try self.classes[class_id].allocInternal(bytes, false);
        const generation = self.classes[class_id].getGeneration(slot_index);
        return try packId(class_id, slot_index, generation);
    }

    pub fn incref(self: *GraphemePool, id: IdPayload) GraphemePoolError!void {
        const class_id: u32 = (id >> (GENERATION_BITS + SLOT_BITS)) & CLASS_MASK;
        if (class_id >= MAX_CLASSES) return GraphemePoolError.InvalidId;
        const slot_index: u32 = id & SLOT_MASK;
        const generation: u32 = (id >> SLOT_BITS) & GENERATION_MASK;
        try self.classes[class_id].incref(slot_index, generation);
    }

    pub fn decref(self: *GraphemePool, id: IdPayload) GraphemePoolError!void {
        const class_id: u32 = (id >> (GENERATION_BITS + SLOT_BITS)) & CLASS_MASK;
        if (class_id >= MAX_CLASSES) return GraphemePoolError.InvalidId;
        const slot_index: u32 = id & SLOT_MASK;
        const generation: u32 = (id >> SLOT_BITS) & GENERATION_MASK;
        try self.classes[class_id].decref(slot_index, generation);
    }

    /// Free a freshly allocated slot that was never incref'd (refcount=0).
    /// Use this for cleanup when allocation succeeded but the slot was never used.
    /// This prevents slot leaks when an error occurs between alloc and incref.
    pub fn freeUnreferenced(self: *GraphemePool, id: IdPayload) GraphemePoolError!void {
        const class_id: u32 = (id >> (GENERATION_BITS + SLOT_BITS)) & CLASS_MASK;
        if (class_id >= MAX_CLASSES) return GraphemePoolError.InvalidId;
        const slot_index: u32 = id & SLOT_MASK;
        const generation: u32 = (id >> SLOT_BITS) & GENERATION_MASK;
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

    pub fn getTotalSlots(self: *const GraphemePool) u32 {
        var total: u32 = 0;
        var i: usize = 0;
        while (i < MAX_CLASSES) : (i += 1) {
            total += self.classes[i].num_slots;
        }
        return total;
    }

    pub fn getUsedSlots(self: *const GraphemePool) u32 {
        var total: u32 = 0;
        var i: usize = 0;
        while (i < MAX_CLASSES) : (i += 1) {
            const class_pool = self.classes[i];
            const free_len: u32 = @intCast(class_pool.free_list.items.len);
            if (class_pool.num_slots > free_len) {
                total += class_pool.num_slots - free_len;
            }
        }
        return total;
    }

    pub fn getTotalBytes(self: *const GraphemePool) usize {
        var total: usize = 0;
        var i: usize = 0;
        while (i < MAX_CLASSES) : (i += 1) {
            total += self.classes[i].slots.items.len;
        }
        return total;
    }

    pub fn getClassSlots(self: *const GraphemePool, class_id: u8) u32 {
        if (class_id >= MAX_CLASSES) return 0;
        return self.classes[class_id].num_slots;
    }

    pub fn getClassUsedSlots(self: *const GraphemePool, class_id: u8) u32 {
        if (class_id >= MAX_CLASSES) return 0;
        const class_pool = self.classes[class_id];
        const free_len: u32 = @intCast(class_pool.free_list.items.len);
        if (class_pool.num_slots <= free_len) return 0;
        return class_pool.num_slots - free_len;
    }

    pub fn getClassBytes(self: *const GraphemePool, class_id: u8) usize {
        if (class_id >= MAX_CLASSES) return 0;
        return self.classes[class_id].slots.items.len;
    }

    const ClassPool = struct {
        allocator: std.mem.Allocator,
        slot_capacity: u32,
        slots_per_page: u32,
        slot_size_bytes: usize,
        slots: std.ArrayListUnmanaged(u8),
        free_list: std.ArrayListUnmanaged(u32),
        num_slots: u32,

        pub fn init(allocator: std.mem.Allocator, slot_capacity: u32, slots_per_page: u32) ClassPool {
            // Align slot size to SlotHeader alignment to prevent UB from misaligned access
            const raw_slot_size = @sizeOf(SlotHeader) + slot_capacity;
            const slot_size_bytes = std.mem.alignForward(usize, raw_slot_size, @alignOf(SlotHeader));
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

        pub fn deinit(self: *ClassPool) void {
            self.slots.deinit(self.allocator);
            self.free_list.deinit(self.allocator);
        }

        fn grow(self: *ClassPool) GraphemePoolError!void {
            const add_bytes = self.slot_size_bytes * self.slots_per_page;

            try self.slots.ensureTotalCapacity(self.allocator, self.slots.items.len + add_bytes);
            try self.slots.appendNTimes(self.allocator, 0, add_bytes);

            var i: u32 = 0;
            while (i < self.slots_per_page) : (i += 1) {
                try self.free_list.append(self.allocator, self.num_slots + i);
            }
            self.num_slots += self.slots_per_page;
        }

        fn slotPtr(self: *ClassPool, slot_index: u32) *u8 {
            const offset: usize = @as(usize, slot_index) * self.slot_size_bytes;
            return &self.slots.items[offset];
        }

        pub fn allocInternal(self: *ClassPool, bytes: []const u8, is_owned: bool) GraphemePoolError!u32 {
            // Validate size for owned allocations
            if (is_owned and bytes.len > self.slot_capacity) {
                @panic("ClassPool.allocInternal: bytes.len > slot_capacity");
            }

            if (self.free_list.items.len == 0) try self.grow();

            const slot_index = self.free_list.pop().?;
            const p = self.slotPtr(slot_index);
            const header_ptr = @as(*SlotHeader, @ptrCast(@alignCast(p)));

            // Increment generation when reusing a slot, wrapping at 7 bits (128 values)
            const new_generation = (header_ptr.generation + 1) & GENERATION_MASK;

            // Calculate length based on ownership
            const len: u16 = if (is_owned) @intCast(@min(bytes.len, self.slot_capacity)) else @intCast(bytes.len);

            header_ptr.* = .{
                .len = len,
                .refcount = 0,
                .generation = new_generation,
                .is_owned = if (is_owned) 1 else 0,
            };

            const data_ptr = @as([*]u8, @ptrCast(p)) + @sizeOf(SlotHeader);

            if (is_owned) {
                // Owned: copy bytes into our storage
                @memcpy(data_ptr[0..header_ptr.len], bytes[0..header_ptr.len]);
            } else {
                // Unowned: store pointer to external memory
                const ptr_storage = @as(*[*]const u8, @ptrCast(@alignCast(data_ptr)));
                ptr_storage.* = bytes.ptr;
            }

            return slot_index;
        }

        pub fn getGeneration(self: *ClassPool, slot_index: u32) u32 {
            if (slot_index >= self.num_slots) return 0;
            const p = self.slotPtr(slot_index);
            const header_ptr = @as(*SlotHeader, @ptrCast(@alignCast(p)));
            return header_ptr.generation;
        }

        pub fn incref(self: *ClassPool, slot_index: u32, expected_generation: u32) GraphemePoolError!void {
            const p = self.slotPtr(slot_index);
            const header_ptr = @as(*SlotHeader, @ptrCast(@alignCast(p)));
            if (header_ptr.generation != expected_generation) {
                // Generation mismatch - this is a stale reference
                return GraphemePoolError.WrongGeneration;
            }
            header_ptr.refcount +%= 1;
        }

        pub fn decref(self: *ClassPool, slot_index: u32, expected_generation: u32) GraphemePoolError!void {
            const p = self.slotPtr(slot_index);
            const header_ptr = @as(*SlotHeader, @ptrCast(@alignCast(p)));

            if (header_ptr.refcount == 0) return GraphemePoolError.InvalidId;
            if (header_ptr.generation != expected_generation) return GraphemePoolError.WrongGeneration;

            header_ptr.refcount -%= 1;

            if (header_ptr.refcount == 0) {
                try self.free_list.append(self.allocator, slot_index);
            }
        }

        /// Free a slot that has refcount=0 (freshly allocated, never incref'd).
        /// This is used for cleanup when allocation succeeded but the caller
        /// needs to abort before taking ownership via incref.
        pub fn freeUnreferenced(self: *ClassPool, slot_index: u32, expected_generation: u32) GraphemePoolError!void {
            if (slot_index >= self.num_slots) return GraphemePoolError.InvalidId;
            const p = self.slotPtr(slot_index);
            const header_ptr = @as(*SlotHeader, @ptrCast(@alignCast(p)));

            if (header_ptr.generation != expected_generation) return GraphemePoolError.WrongGeneration;
            if (header_ptr.refcount != 0) return GraphemePoolError.InvalidId; // Not unreferenced

            try self.free_list.append(self.allocator, slot_index);
        }

        pub fn get(self: *ClassPool, slot_index: u32, expected_generation: u32) GraphemePoolError![]const u8 {
            if (slot_index >= self.num_slots) return GraphemePoolError.InvalidId;

            const p = self.slotPtr(slot_index);
            const header_ptr = @as(*SlotHeader, @ptrCast(@alignCast(p)));
            // Validate generation to prevent accessing stale data
            if (header_ptr.generation != expected_generation) return GraphemePoolError.WrongGeneration;

            const data_ptr = @as([*]u8, @ptrCast(p)) + @sizeOf(SlotHeader);

            if (header_ptr.is_owned == 1) {
                // Owned memory: return slice from our storage
                return data_ptr[0..header_ptr.len];
            } else {
                // Unowned memory: dereference stored pointer
                const ptr_storage = @as(*[*]const u8, @ptrCast(@alignCast(data_ptr)));
                const external_ptr = ptr_storage.*;
                return external_ptr[0..header_ptr.len];
            }
        }

        pub fn getRefcount(self: *ClassPool, slot_index: u32, expected_generation: u32) GraphemePoolError!u32 {
            if (slot_index >= self.num_slots) return GraphemePoolError.InvalidId;
            const p = self.slotPtr(slot_index);
            const header_ptr = @as(*SlotHeader, @ptrCast(@alignCast(p)));
            if (header_ptr.generation != expected_generation) return GraphemePoolError.WrongGeneration;
            return header_ptr.refcount;
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
    return c & GRAPHEME_ID_MASK;
}

pub fn charRightExtent(c: u32) u32 {
    return (c >> CHAR_EXT_RIGHT_SHIFT) & CHAR_EXT_MASK;
}

pub fn charLeftExtent(c: u32) u32 {
    return (c >> CHAR_EXT_LEFT_SHIFT) & CHAR_EXT_MASK;
}

pub fn packGraphemeStart(gid: u32, total_width: u32) u32 {
    const width_minus_one: u32 = if (total_width == 0) 0 else @intCast(@min(total_width - 1, 3));
    const right: u32 = width_minus_one;
    const left: u32 = 0;
    return CHAR_FLAG_GRAPHEME |
        ((right & CHAR_EXT_MASK) << CHAR_EXT_RIGHT_SHIFT) |
        ((left & CHAR_EXT_MASK) << CHAR_EXT_LEFT_SHIFT) |
        (gid & GRAPHEME_ID_MASK);
}

pub fn packContinuation(left: u32, right: u32, gid: u32) u32 {
    return CHAR_FLAG_CONTINUATION |
        ((@min(left, 3) & CHAR_EXT_MASK) << CHAR_EXT_LEFT_SHIFT) |
        ((@min(right, 3) & CHAR_EXT_MASK) << CHAR_EXT_RIGHT_SHIFT) |
        (gid & GRAPHEME_ID_MASK);
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

pub fn initGlobalPoolWithOptions(allocator: std.mem.Allocator, options: GraphemePool.InitOptions) *GraphemePool {
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

pub fn getGlobalPool() ?*GraphemePool {
    if (GLOBAL_POOL_STORAGE) |*p| return p;
    return null;
}

pub const GraphemeTracker = struct {
    pool: *GraphemePool,
    used_ids: std.AutoHashMap(u32, void),

    pub fn init(allocator: std.mem.Allocator, pool: *GraphemePool) GraphemeTracker {
        return .{
            .pool = pool,
            .used_ids = std.AutoHashMap(u32, void).init(allocator),
        };
    }

    fn decRefAll(self: *GraphemeTracker) void {
        var it = self.used_ids.keyIterator();
        while (it.next()) |idp| {
            self.pool.decref(idp.*) catch {};
        }
    }

    pub fn deinit(self: *GraphemeTracker) void {
        self.decRefAll();
        self.used_ids.deinit();
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
            self.pool.incref(id) catch |err| {
                std.debug.panic("GraphemeTracker.add incref failed: {}\n", .{err});
            };
        }
    }

    pub fn remove(self: *GraphemeTracker, id: u32) void {
        if (self.used_ids.remove(id)) {
            self.pool.decref(id) catch {};
        }
    }

    pub fn contains(self: *const GraphemeTracker, id: u32) bool {
        return self.used_ids.contains(id);
    }

    pub fn hasAny(self: *const GraphemeTracker) bool {
        return self.used_ids.count() > 0;
    }

    pub fn getGraphemeCount(self: *const GraphemeTracker) u32 {
        return @intCast(self.used_ids.count());
    }

    pub fn getTotalGraphemeBytes(self: *const GraphemeTracker) u32 {
        var total_bytes: u32 = 0;
        var it = self.used_ids.keyIterator();
        while (it.next()) |idp| {
            const id = idp.*;
            if (self.pool.get(id)) |bytes| {
                total_bytes += @intCast(bytes.len);
            } else |_| {
                // If we can't get the bytes, this shouldn't happen but handle gracefully
                continue;
            }
        }
        return total_bytes;
    }
};
