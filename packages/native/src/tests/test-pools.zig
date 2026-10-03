const std = @import("std");
const gp = @import("../grapheme.zig");
const link = @import("../link.zig");

pub const TestPools = struct {
    graphemes: gp.GraphemePool,
    links: link.LinkPool,

    pub fn init(allocator: std.mem.Allocator) TestPools {
        return .{
            .graphemes = gp.GraphemePool.init(allocator),
            .links = link.LinkPool.init(allocator),
        };
    }

    pub fn deinit(self: *TestPools) void {
        self.links.deinit();
        self.graphemes.deinit();
    }
};

/// Pool-specific parts of the shared model check.
pub const GraphemeSpec = struct {
    pub const Pool = gp.GraphemePool;
    pub const Tracker = gp.GraphemeTracker;
    pub const bytes_max = 128;
    pub const too_long = error.GraphemeTooLong;
    pub const lengths = [_]usize{ 0, 1, 7, 8, 9, 16, 17, 33, 64, 65, 128 };
    // Class 5 does not exist; slot 0xffff is never allocated by the model.
    pub const invalid_ids = [_]u32{ gp.SLOT_MASK, 5 << (gp.GENERATION_BITS + gp.SLOT_BITS) };
    pub const get_rejects_released = true;

    /// One slot per page makes nearly every first use grow the pool.
    pub fn init(allocator: std.mem.Allocator) Pool {
        return Pool.initWithOptions(allocator, .{ .slots_per_page = @splat(1) });
    }

    pub fn liveSlots(pool: *const Pool) u64 {
        var count: u64 = 0;
        for (pool.classes) |class| count += class.num_slots - class.free_list.items.len;
        return count;
    }

    pub fn track(tracker: *Tracker, id: u32) void {
        tracker.add(id);
    }

    pub fn untrack(tracker: *Tracker, id: u32) void {
        tracker.remove(id);
    }

    pub fn trackedCount(tracker: *const Tracker) u32 {
        return tracker.getGraphemeCount();
    }
};

pub const LinkSpec = struct {
    pub const Pool = link.LinkPool;
    pub const Tracker = link.LinkTracker;
    pub const bytes_max = link.MAX_URL_LENGTH;
    pub const too_long = error.UrlTooLong;
    pub const lengths = [_]usize{ 1, 20, 100, 511, 512 };
    pub const invalid_ids = [_]u32{link.SLOT_MASK};
    // LinkPool.get still resolves a released ID; Context.getLinkUrl rejects it.
    pub const get_rejects_released = false;

    pub fn init(allocator: std.mem.Allocator) Pool {
        return Pool.init(allocator);
    }

    pub fn liveSlots(pool: *const Pool) u64 {
        return pool.getLiveSlotCount();
    }

    pub fn track(tracker: *Tracker, id: u32) void {
        tracker.addCellRef(id);
    }

    pub fn untrack(tracker: *Tracker, id: u32) void {
        tracker.removeCellRef(id);
    }

    pub fn trackedCount(tracker: *const Tracker) u32 {
        return tracker.getLinkCount();
    }
};

/// Seeded random model check of a reference-counted interning pool and one
/// tracker on it. The model keeps one entry per corpus string: its live ID, the
/// owner references the test holds, and the tracked cell count (the tracker
/// holds one pool reference while that count is above zero). Random steps
/// acquire (sometimes with an injected allocation failure), retain, release,
/// track, untrack, clear, and probe released or invalid IDs. After each step
/// the pool must agree with the model on refcounts, bytes, interned and live
/// counts, and tracker membership.
pub fn checkPoolModel(comptime Spec: type, seed: u64, step_count: u32) !void {
    const corpus_count = Spec.lengths.len;
    const Entry = struct {
        id: ?u32 = null,
        owned: u32 = 0,
        cells: u32 = 0,
    };
    const Model = struct {
        pool: *Spec.Pool,
        tracker: *Spec.Tracker,
        failing: *std.testing.FailingAllocator,
        entries: [corpus_count]Entry = @splat(.{}),
        released: [8]u32 = undefined,
        released_count: usize = 0,

        fn bytes(index: usize, out: *[Spec.bytes_max + 1]u8) []u8 {
            const value = out[0..Spec.lengths[index]];
            @memset(value, @intCast('A' + index));
            return value;
        }

        fn refcount(entry: Entry) u32 {
            return entry.owned + @intFromBool(entry.cells > 0);
        }

        fn release(self: *@This(), entry: *Entry) void {
            if (refcount(entry.*) > 0) return;
            self.released[self.released_count % self.released.len] = entry.id.?;
            self.released_count += 1;
            entry.id = null;
        }

        fn acquire(self: *@This(), random: std.Random, index: usize) !void {
            var scratch: [Spec.bytes_max + 1]u8 = undefined;
            const value = bytes(index, &scratch);
            const inject = random.boolean();
            if (inject) {
                self.failing.fail_index = self.failing.alloc_index + random.uintLessThan(usize, 4);
                self.failing.resize_fail_index = self.failing.resize_index + random.uintLessThan(usize, 2);
            }
            const result = self.pool.acquire(value);
            self.failing.fail_index = std.math.maxInt(usize);
            self.failing.resize_fail_index = std.math.maxInt(usize);
            // The pool must copy the borrowed input.
            @memset(value, '!');
            const entry = &self.entries[index];
            const id = result catch |err| {
                try std.testing.expectEqual(error.OutOfMemory, err);
                try std.testing.expect(inject and entry.id == null);
                return;
            };
            if (entry.id) |live| try std.testing.expectEqual(live, id);
            // Each slot reuse needs a release, and the ring holds the last 8, so a
            // 7-bit grapheme generation cannot wrap back to a ringed ID.
            if (entry.id == null) {
                for (self.released[0..@min(self.released_count, self.released.len)]) |old| try std.testing.expect(old != id);
            }
            for (self.entries, 0..) |other, other_index| {
                if (other_index != index and other.id != null) try std.testing.expect(other.id.? != id);
            }
            entry.id = id;
            entry.owned += 1;
        }

        fn step(self: *@This(), random: std.Random) !void {
            const index = random.uintLessThan(usize, corpus_count);
            const entry = &self.entries[index];
            // Releases outweigh retains so entries keep returning to the free path.
            switch (random.uintLessThan(u8, 8)) {
                0, 1 => try self.acquire(random, index),
                2 => if (entry.owned > 0) {
                    try self.pool.incref(entry.id.?);
                    entry.owned += 1;
                },
                3, 4 => while (entry.owned > 0) {
                    try self.pool.decref(entry.id.?);
                    entry.owned -= 1;
                    if (random.boolean()) break;
                },
                5 => if (entry.id) |id| {
                    Spec.track(self.tracker, id);
                    entry.cells += 1;
                },
                6 => if (entry.cells > 0) {
                    Spec.untrack(self.tracker, entry.id.?);
                    entry.cells -= 1;
                } else if (entry.id) |id| {
                    // Untracking an untracked ID changes nothing.
                    Spec.untrack(self.tracker, id);
                },
                else => if (random.uintLessThan(u8, 4) == 0) {
                    self.tracker.clear();
                    for (&self.entries) |*each| {
                        each.cells = 0;
                        if (each.id != null) self.release(each);
                    }
                } else try self.probe(random),
            }
            if (entry.id != null) self.release(entry);
        }

        fn probe(self: *@This(), random: std.Random) !void {
            var scratch: [Spec.bytes_max + 1]u8 = undefined;
            @memset(&scratch, 'x');
            try std.testing.expectError(Spec.too_long, self.pool.acquire(&scratch));
            for (Spec.invalid_ids) |id| {
                try std.testing.expectError(error.InvalidId, self.pool.incref(id));
                try std.testing.expectError(error.InvalidId, self.pool.decref(id));
                try std.testing.expectError(error.InvalidId, self.pool.getRefcount(id));
                try std.testing.expectError(error.InvalidId, self.pool.get(id));
            }
            if (self.released_count == 0) return;
            const id = self.released[random.uintLessThan(usize, @min(self.released_count, self.released.len))];
            if (Spec.get_rejects_released) {
                const result = self.pool.get(id);
                try std.testing.expect(result == error.InvalidId or result == error.WrongGeneration);
            }
            for ([_]anyerror!void{ self.pool.incref(id), self.pool.decref(id) }) |result| {
                if (result) |_| return error.TestUnexpectedResult else |err| {
                    try std.testing.expect(err == error.InvalidId or err == error.WrongGeneration);
                }
            }
            try std.testing.expectEqual(@as(u32, 0), self.pool.getRefcount(id) catch 0);
        }

        fn check(self: *@This()) !void {
            var live: u32 = 0;
            var tracked: u32 = 0;
            for (self.entries, 0..) |entry, index| {
                const id = entry.id orelse continue;
                var scratch: [Spec.bytes_max + 1]u8 = undefined;
                live += 1;
                tracked += @intFromBool(entry.cells > 0);
                try std.testing.expectEqual(refcount(entry), try self.pool.getRefcount(id));
                try std.testing.expectEqualSlices(u8, bytes(index, &scratch), try self.pool.get(id));
                try std.testing.expectEqual(entry.cells, self.tracker.used_ids.get(id) orelse 0);
            }
            try std.testing.expectEqual(live, self.pool.interned_live_ids.count());
            try std.testing.expectEqual(@as(u64, live), Spec.liveSlots(self.pool));
            try std.testing.expectEqual(tracked, Spec.trackedCount(self.tracker));
        }
    };

    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
    var pool = Spec.init(failing.allocator());
    defer pool.deinit();
    var tracker = Spec.Tracker.init(std.testing.allocator, &pool);
    defer tracker.deinit();
    var model: Model = .{ .pool = &pool, .tracker = &tracker, .failing = &failing };
    var prng = std.Random.DefaultPrng.init(seed);
    for (0..step_count) |_| {
        try model.step(prng.random());
        try model.check();
    }
    tracker.clear();
    for (model.entries) |entry| {
        for (0..entry.owned) |_| try pool.decref(entry.id.?);
    }
    try std.testing.expectEqual(@as(u32, 0), pool.interned_live_ids.count());
    try std.testing.expectEqual(@as(u64, 0), Spec.liveSlots(&pool));
}
