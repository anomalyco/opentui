const std = @import("std");
const rope_mod = @import("../rope.zig");

const SimpleItem = struct {
    value: u32,

    pub fn empty() SimpleItem {
        return .{ .value = 0 };
    }

    pub fn is_empty(self: *const SimpleItem) bool {
        return self.value == 0;
    }
};

const ItemWithMetrics = struct {
    value: u32,
    size: u32,

    pub const Metrics = struct {
        total_size: u32 = 0,

        pub fn add(self: *Metrics, other: Metrics) void {
            self.total_size += other.total_size;
        }
    };

    pub fn measure(self: *const ItemWithMetrics) Metrics {
        return .{ .total_size = self.size };
    }

    pub fn empty() ItemWithMetrics {
        return .{ .value = 0, .size = 0 };
    }

    pub fn is_empty(self: *const ItemWithMetrics) bool {
        return self.value == 0 and self.size == 0;
    }
};

//===== Basic Rope Tests =====

test "Rope - can initialize with arena allocator" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope = try RopeType.init(arena.allocator());
    try std.testing.expectEqual(@as(u32, 0), rope.count()); // Sentinel filtered
}

test "Rope - from_item creates single item rope" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope = try RopeType.from_item(arena.allocator(), .{ .value = 42 });

    try std.testing.expectEqual(@as(u32, 1), rope.count());
    const item = rope.get(0);
    try std.testing.expect(item != null);
    try std.testing.expectEqual(@as(u32, 42), item.?.value);
}

test "Rope - from_slice creates rope from multiple items" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    const items = [_]SimpleItem{
        .{ .value = 1 },
        .{ .value = 2 },
        .{ .value = 3 },
    };

    var rope = try RopeType.from_slice(arena.allocator(), &items);
    try std.testing.expectEqual(@as(u32, 3), rope.count());

    try std.testing.expectEqual(@as(u32, 1), rope.get(0).?.value);
    try std.testing.expectEqual(@as(u32, 2), rope.get(1).?.value);
    try std.testing.expectEqual(@as(u32, 3), rope.get(2).?.value);
}

test "Rope - get with out of bounds returns null" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope = try RopeType.from_item(arena.allocator(), .{ .value = 1 });

    try std.testing.expect(rope.get(100) == null);
}

//===== Insert Tests =====

test "Rope - insert at beginning" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope = try RopeType.from_item(arena.allocator(), .{ .value = 1 });

    try rope.insert(0, .{ .value = 0 });

    try std.testing.expectEqual(@as(u32, 2), rope.count());
    try std.testing.expectEqual(@as(u32, 0), rope.get(0).?.value);
    try std.testing.expectEqual(@as(u32, 1), rope.get(1).?.value);
}

test "Rope - insert at end" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope = try RopeType.from_item(arena.allocator(), .{ .value = 1 });

    try rope.insert(1, .{ .value = 2 });

    try std.testing.expectEqual(@as(u32, 2), rope.count());
    try std.testing.expectEqual(@as(u32, 1), rope.get(0).?.value);
    try std.testing.expectEqual(@as(u32, 2), rope.get(1).?.value);
}

test "Rope - multiple inserts" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope = try RopeType.init(arena.allocator());

    try rope.insert(0, .{ .value = 1 });
    try rope.insert(1, .{ .value = 2 });
    try rope.insert(2, .{ .value = 3 });

    try std.testing.expectEqual(@as(u32, 3), rope.count()); // Sentinel filtered
}

//===== Delete Tests =====

test "Rope - delete at beginning" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    const items = [_]SimpleItem{
        .{ .value = 1 },
        .{ .value = 2 },
        .{ .value = 3 },
    };
    var rope = try RopeType.from_slice(arena.allocator(), &items);

    try rope.delete(0);

    try std.testing.expectEqual(@as(u32, 2), rope.count());
    try std.testing.expectEqual(@as(u32, 2), rope.get(0).?.value);
}

test "Rope - delete in middle" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    const items = [_]SimpleItem{
        .{ .value = 1 },
        .{ .value = 2 },
        .{ .value = 3 },
    };
    var rope = try RopeType.from_slice(arena.allocator(), &items);

    try rope.delete(1);

    try std.testing.expectEqual(@as(u32, 2), rope.count());
    try std.testing.expectEqual(@as(u32, 1), rope.get(0).?.value);
    try std.testing.expectEqual(@as(u32, 3), rope.get(1).?.value);
}

//===== Walk Tests =====

test "Rope - walk all items" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    const items = [_]SimpleItem{
        .{ .value = 10 },
        .{ .value = 20 },
        .{ .value = 30 },
    };
    var rope = try RopeType.from_slice(arena.allocator(), &items);

    const Context = struct {
        sum: u32 = 0,

        fn walker(ctx: *anyopaque, data: *const SimpleItem, index: u32) RopeType.Node.WalkerResult {
            _ = index;
            const self = @as(*@This(), @ptrCast(@alignCast(ctx)));
            self.sum += data.value;
            return .{};
        }
    };

    var ctx: Context = .{};
    try rope.walk(&ctx, Context.walker);

    try std.testing.expectEqual(@as(u32, 60), ctx.sum);
}

test "Rope - walk with early exit" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    const items = [_]SimpleItem{
        .{ .value = 1 },
        .{ .value = 2 },
        .{ .value = 3 },
    };
    var rope = try RopeType.from_slice(arena.allocator(), &items);

    const Context = struct {
        count: u32 = 0,

        fn walker(ctx: *anyopaque, data: *const SimpleItem, index: u32) RopeType.Node.WalkerResult {
            _ = index;
            const self = @as(*@This(), @ptrCast(@alignCast(ctx)));
            self.count += 1;
            if (data.value == 2) {
                return .{ .keep_walking = false };
            }
            return .{};
        }
    };

    var ctx: Context = .{};
    try rope.walk(&ctx, Context.walker);

    try std.testing.expectEqual(@as(u32, 2), ctx.count);
}

//===== Metrics Tests =====

test "Rope - custom metrics are tracked" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(ItemWithMetrics);
    const items = [_]ItemWithMetrics{
        .{ .value = 1, .size = 10 },
        .{ .value = 2, .size = 20 },
        .{ .value = 3, .size = 30 },
    };
    var rope = try RopeType.from_slice(arena.allocator(), &items);

    const metrics = rope.root.metrics();
    try std.testing.expectEqual(@as(u32, 3), metrics.count);
    try std.testing.expectEqual(@as(u32, 60), metrics.custom.total_size);
}

test "Rope - rebalance maintains data" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var items: [20]SimpleItem = undefined;
    for (&items, 0..) |*item, i| {
        item.* = .{ .value = @intCast(i) };
    }
    var rope = try RopeType.from_slice(arena.allocator(), &items);

    try rope.rebalance(arena.allocator());

    // Data should be preserved
    try std.testing.expectEqual(@as(u32, 20), rope.count());
    try std.testing.expectEqual(@as(u32, 0), rope.get(0).?.value);
    try std.testing.expectEqual(@as(u32, 10), rope.get(10).?.value);
    try std.testing.expectEqual(@as(u32, 19), rope.get(19).?.value);
}

//===== Stress Tests =====

test "Rope - large number of items" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var items: [100]SimpleItem = undefined;
    for (&items, 0..) |*item, i| {
        item.* = .{ .value = @intCast(i) };
    }

    var rope = try RopeType.from_slice(arena.allocator(), &items);

    try std.testing.expectEqual(@as(u32, 100), rope.count());
    try std.testing.expectEqual(@as(u32, 0), rope.get(0).?.value);
    try std.testing.expectEqual(@as(u32, 50), rope.get(50).?.value);
    try std.testing.expectEqual(@as(u32, 99), rope.get(99).?.value);
}

test "Rope - many insert operations" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope = try RopeType.init(arena.allocator());

    for (0..50) |i| {
        try rope.insert(@intCast(i), .{ .value = @intCast(i) });
    }

    try std.testing.expectEqual(@as(u32, 50), rope.count()); // Sentinel filtered
}

//===== Nested Rope Tests (Lines→Chunks Pattern) =====

// Chunk type similar to what would be used in text buffer
const Chunk = struct {
    data: []const u8,
    width: u32,

    pub const Metrics = struct {
        total_width: u32 = 0,
        total_bytes: u32 = 0,

        pub fn add(self: *Metrics, other: Metrics) void {
            self.total_width += other.total_width;
            self.total_bytes += other.total_bytes;
        }
    };

    pub fn measure(self: *const Chunk) Metrics {
        return .{
            .total_width = self.width,
            .total_bytes = @intCast(self.data.len),
        };
    }

    pub fn empty() Chunk {
        return .{ .data = "", .width = 0 };
    }

    pub fn is_empty(self: *const Chunk) bool {
        return self.data.len == 0;
    }
};

// Static empty chunk rope node for Line.empty()
const empty_chunk_leaf_node: rope_mod.Rope(Chunk).Node = .{
    .leaf = .{
        .data = Chunk.empty(),
    },
};

// Line type containing a rope of chunks
const Line = struct {
    chunks: rope_mod.Rope(Chunk),
    line_id: u32,

    pub const Metrics = struct {
        total_width: u32 = 0,
        total_lines: u32 = 1,

        pub fn add(self: *Metrics, other: Metrics) void {
            self.total_width += other.total_width;
            self.total_lines += other.total_lines;
        }
    };

    pub fn measure(self: *const Line) Metrics {
        const chunk_metrics = self.chunks.root.metrics();
        return .{
            .total_width = chunk_metrics.custom.total_width,
            .total_lines = 1,
        };
    }

    pub fn empty() Line {
        // Use static empty chunk rope - safe because it's immutable
        const ChunkRope = rope_mod.Rope(Chunk);
        return .{
            .chunks = .{
                .root = &empty_chunk_leaf_node,
                .allocator = undefined, // Never used for empty
                .empty_leaf = &empty_chunk_leaf_node,
                .marker_cache = ChunkRope.MarkerCache.init(undefined),
            },
            .line_id = 0,
        };
    }

    pub fn is_empty(self: *const Line) bool {
        return self.line_id == 0 and self.chunks.count() == 1;
    }
};

test "Rope - replace item at index" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    const items = [_]SimpleItem{
        .{ .value = 1 },
        .{ .value = 2 },
        .{ .value = 3 },
    };
    var rope = try RopeType.from_slice(arena.allocator(), &items);

    try rope.replace(1, .{ .value = 20 });

    try std.testing.expectEqual(@as(u32, 3), rope.count());
    try std.testing.expectEqual(@as(u32, 1), rope.get(0).?.value);
    try std.testing.expectEqual(@as(u32, 20), rope.get(1).?.value);
    try std.testing.expectEqual(@as(u32, 3), rope.get(2).?.value);
}

test "Rope - append item" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope = try RopeType.from_item(arena.allocator(), .{ .value = 1 });

    try rope.append(.{ .value = 2 });
    try rope.append(.{ .value = 3 });

    try std.testing.expectEqual(@as(u32, 3), rope.count());
    try std.testing.expectEqual(@as(u32, 1), rope.get(0).?.value);
    try std.testing.expectEqual(@as(u32, 2), rope.get(1).?.value);
    try std.testing.expectEqual(@as(u32, 3), rope.get(2).?.value);
}

test "Rope - prepend item" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope = try RopeType.from_item(arena.allocator(), .{ .value = 3 });

    try rope.prepend(.{ .value = 2 });
    try rope.prepend(.{ .value = 1 });

    try std.testing.expectEqual(@as(u32, 3), rope.count());
    try std.testing.expectEqual(@as(u32, 1), rope.get(0).?.value);
    try std.testing.expectEqual(@as(u32, 2), rope.get(1).?.value);
    try std.testing.expectEqual(@as(u32, 3), rope.get(2).?.value);
}

test "Rope - concatenate two ropes" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);

    const items1 = [_]SimpleItem{
        .{ .value = 1 },
        .{ .value = 2 },
    };
    var rope1 = try RopeType.from_slice(arena.allocator(), &items1);

    const items2 = [_]SimpleItem{
        .{ .value = 3 },
        .{ .value = 4 },
    };
    const rope2 = try RopeType.from_slice(arena.allocator(), &items2);

    try rope1.concat(&rope2);

    try std.testing.expectEqual(@as(u32, 4), rope1.count());
    try std.testing.expectEqual(@as(u32, 1), rope1.get(0).?.value);
    try std.testing.expectEqual(@as(u32, 2), rope1.get(1).?.value);
    try std.testing.expectEqual(@as(u32, 3), rope1.get(2).?.value);
    try std.testing.expectEqual(@as(u32, 4), rope1.get(3).?.value);
}

//===== Undo/Redo Tests =====

test "Rope - basic undo operation" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope = try RopeType.from_item(arena.allocator(), .{ .value = 1 });

    try rope.store_undo("initial");

    try rope.insert(1, .{ .value = 2 });
    try std.testing.expectEqual(@as(u32, 2), rope.count());

    const meta = try rope.undo("before undo");
    try std.testing.expectEqualStrings("initial", meta);
    try std.testing.expectEqual(@as(u32, 1), rope.count());
}

test "Rope - basic redo operation" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope = try RopeType.from_item(arena.allocator(), .{ .value = 1 });

    try rope.store_undo("initial");
    try rope.insert(1, .{ .value = 2 });

    _ = try rope.undo("before undo");
    try std.testing.expectEqual(@as(u32, 1), rope.count());

    const meta = try rope.redo();
    try std.testing.expectEqualStrings("before undo", meta);
    try std.testing.expectEqual(@as(u32, 2), rope.count());
}

test "Rope - multiple undo/redo operations" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope = try RopeType.from_item(arena.allocator(), .{ .value = 1 });

    try rope.store_undo("state1");
    try rope.append(.{ .value = 2 });

    try rope.store_undo("state2");
    try rope.append(.{ .value = 3 });

    try rope.store_undo("state3");
    try rope.append(.{ .value = 4 });

    try std.testing.expectEqual(@as(u32, 4), rope.count());

    _ = try rope.undo("current");
    try std.testing.expectEqual(@as(u32, 3), rope.count());

    _ = try rope.undo("current");
    try std.testing.expectEqual(@as(u32, 2), rope.count());

    _ = try rope.redo();
    try std.testing.expectEqual(@as(u32, 3), rope.count());
}

test "Rope - undo/redo with delete operations" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    const items = [_]SimpleItem{
        .{ .value = 1 },
        .{ .value = 2 },
        .{ .value = 3 },
    };
    var rope = try RopeType.from_slice(arena.allocator(), &items);

    try rope.store_undo("before delete");
    try rope.delete(1);

    try std.testing.expectEqual(@as(u32, 2), rope.count());
    try std.testing.expectEqual(@as(u32, 1), rope.get(0).?.value);
    try std.testing.expectEqual(@as(u32, 3), rope.get(1).?.value);

    _ = try rope.undo("after delete");
    try std.testing.expectEqual(@as(u32, 3), rope.count());
    try std.testing.expectEqual(@as(u32, 2), rope.get(1).?.value);
}

test "Rope - undo/redo with replace operations" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope = try RopeType.from_item(arena.allocator(), .{ .value = 10 });

    try rope.store_undo("original");
    try rope.replace(0, .{ .value = 20 });
    try std.testing.expectEqual(@as(u32, 20), rope.get(0).?.value);

    _ = try rope.undo("after replace");
    try std.testing.expectEqual(@as(u32, 10), rope.get(0).?.value);

    _ = try rope.redo();
    try std.testing.expectEqual(@as(u32, 20), rope.get(0).?.value);
}

test "Rope - can_undo and can_redo" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope = try RopeType.from_item(arena.allocator(), .{ .value = 1 });

    try std.testing.expect(!rope.can_undo());
    try std.testing.expect(!rope.can_redo());

    try rope.store_undo("state1");
    try std.testing.expect(rope.can_undo());
    try std.testing.expect(!rope.can_redo());

    _ = try rope.undo("current");
    try std.testing.expect(!rope.can_undo()); // No more undo (only one state)
    try std.testing.expect(rope.can_redo());
}

test "Rope - clear history" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope = try RopeType.from_item(arena.allocator(), .{ .value = 1 });

    try rope.store_undo("state1");
    try rope.append(.{ .value = 2 });
    try rope.store_undo("state2");

    try std.testing.expect(rope.can_undo());

    rope.clear_history();
    try std.testing.expect(!rope.can_undo());
    try std.testing.expect(!rope.can_redo());
}

test "Rope - undo fails when no history" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope = try RopeType.from_item(arena.allocator(), .{ .value = 1 });

    // No history stored, undo should fail
    const result = rope.undo("current");
    try std.testing.expectError(error.Stop, result);
}

test "Rope - redo fails when no redo history" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope = try RopeType.from_item(arena.allocator(), .{ .value = 1 });

    // No redo history, redo should fail
    const result = rope.redo();
    try std.testing.expectError(error.Stop, result);
}

test "Rope - complex undo/redo workflow" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope = try RopeType.init(arena.allocator());

    // Build up a sequence of operations
    try rope.store_undo("empty");
    try rope.insert(0, .{ .value = 1 });

    try rope.store_undo("one item");
    try rope.append(.{ .value = 2 });

    try rope.store_undo("two items");
    try rope.append(.{ .value = 3 });

    try rope.store_undo("three items");
    try rope.delete(1); // Remove middle

    // State: [1, 3]
    try std.testing.expectEqual(@as(u32, 2), rope.count()); // Sentinel filtered

    // Undo delete
    _ = try rope.undo("current");
    try std.testing.expectEqual(@as(u32, 3), rope.count());

    // Undo append
    _ = try rope.undo("current");
    try std.testing.expectEqual(@as(u32, 2), rope.count());

    // Redo append
    _ = try rope.redo();
    try std.testing.expectEqual(@as(u32, 3), rope.count());
}

test "Rope - undo/redo with metadata tracking" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope = try RopeType.from_item(arena.allocator(), .{ .value = 1 });

    try rope.store_undo("insert operation");
    try rope.append(.{ .value = 2 });

    try rope.store_undo("delete operation");
    try rope.delete(0);

    // Undo and check metadata
    const meta1 = try rope.undo("current state");
    try std.testing.expectEqualStrings("delete operation", meta1);

    const meta2 = try rope.undo("current state");
    try std.testing.expectEqualStrings("insert operation", meta2);
}

test "Rope - undo invalidates redo after new operation" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope = try RopeType.from_item(arena.allocator(), .{ .value = 1 });

    try rope.store_undo("state1");
    try rope.append(.{ .value = 2 });

    try rope.store_undo("state2");
    try rope.append(.{ .value = 3 });

    // Undo once
    _ = try rope.undo("current");
    try std.testing.expect(rope.can_redo());

    // Make a new change - this stores the old redo as a branch and clears redo
    try rope.store_undo("new branch");
    try rope.append(.{ .value = 99 });

    // Redo should NOT work anymore (it was saved as a branch)
    try std.testing.expect(!rope.can_redo());

    // But we can still undo
    try std.testing.expect(rope.can_undo());
}

test "Rope - undo/redo with nested ropes" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    const chunks1 = [_]Chunk{.{ .data = "Line 1", .width = 6 }};
    const line1: Line = .{
        .chunks = try rope_mod.Rope(Chunk).from_slice(allocator, &chunks1),
        .line_id = 1,
    };

    const RopeType = rope_mod.Rope(Line);
    var rope = try RopeType.from_item(allocator, line1);

    try rope.store_undo("before append");

    const chunks2 = [_]Chunk{.{ .data = "Line 2", .width = 6 }};
    const line2: Line = .{
        .chunks = try rope_mod.Rope(Chunk).from_slice(allocator, &chunks2),
        .line_id = 2,
    };
    try rope.append(line2);

    try std.testing.expectEqual(@as(u32, 2), rope.count());

    // Undo
    _ = try rope.undo("after append");
    try std.testing.expectEqual(@as(u32, 1), rope.count());

    // Redo
    _ = try rope.redo();
    try std.testing.expectEqual(@as(u32, 2), rope.count());
}

test "Rope - stress test undo/redo with many operations" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope = try RopeType.init(arena.allocator());

    // Perform 20 operations
    for (0..20) |i| {
        try rope.store_undo("operation");
        try rope.append(.{ .value = @intCast(i) });
    }

    try std.testing.expectEqual(@as(u32, 20), rope.count()); // Sentinel filtered

    // Undo 10 operations
    for (0..10) |_| {
        _ = try rope.undo("current");
    }
    try std.testing.expectEqual(@as(u32, 10), rope.count());

    // Redo 5 operations
    for (0..5) |_| {
        _ = try rope.redo();
    }
    try std.testing.expectEqual(@as(u32, 15), rope.count());
}

//===== Bulk/Range Operations Tests =====

test "Rope - split at beginning" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    const items = [_]SimpleItem{
        .{ .value = 1 },
        .{ .value = 2 },
        .{ .value = 3 },
    };
    var rope = try RopeType.from_slice(arena.allocator(), &items);

    const right = try rope.split(0);

    try std.testing.expectEqual(@as(u32, 0), rope.count()); // Sentinel filtered
    try std.testing.expectEqual(@as(u32, 3), right.count());
    try std.testing.expectEqual(@as(u32, 1), right.get(0).?.value);
}

test "Rope - split at middle" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    const items = [_]SimpleItem{
        .{ .value = 1 },
        .{ .value = 2 },
        .{ .value = 3 },
        .{ .value = 4 },
        .{ .value = 5 },
    };
    var rope = try RopeType.from_slice(arena.allocator(), &items);

    const right = try rope.split(2);

    try std.testing.expectEqual(@as(u32, 2), rope.count());
    try std.testing.expectEqual(@as(u32, 1), rope.get(0).?.value);
    try std.testing.expectEqual(@as(u32, 2), rope.get(1).?.value);

    try std.testing.expectEqual(@as(u32, 3), right.count());
    try std.testing.expectEqual(@as(u32, 3), right.get(0).?.value);
    try std.testing.expectEqual(@as(u32, 4), right.get(1).?.value);
    try std.testing.expectEqual(@as(u32, 5), right.get(2).?.value);
}

test "Rope - split at end" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    const items = [_]SimpleItem{
        .{ .value = 1 },
        .{ .value = 2 },
        .{ .value = 3 },
    };
    var rope = try RopeType.from_slice(arena.allocator(), &items);

    const right = try rope.split(3);

    try std.testing.expectEqual(@as(u32, 3), rope.count());
    try std.testing.expectEqual(@as(u32, 0), right.count()); // Sentinel filtered
}

test "Rope - slice full range" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    const items = [_]SimpleItem{
        .{ .value = 1 },
        .{ .value = 2 },
        .{ .value = 3 },
    };
    var rope = try RopeType.from_slice(arena.allocator(), &items);

    const sliced = try rope.slice(0, 3, arena.allocator());
    defer arena.allocator().free(sliced);

    try std.testing.expectEqual(@as(usize, 3), sliced.len);
    try std.testing.expectEqual(@as(u32, 1), sliced[0].value);
    try std.testing.expectEqual(@as(u32, 2), sliced[1].value);
    try std.testing.expectEqual(@as(u32, 3), sliced[2].value);
}

test "Rope - slice partial range" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    const items = [_]SimpleItem{
        .{ .value = 10 },
        .{ .value = 20 },
        .{ .value = 30 },
        .{ .value = 40 },
        .{ .value = 50 },
    };
    var rope = try RopeType.from_slice(arena.allocator(), &items);

    const sliced = try rope.slice(1, 4, arena.allocator());
    defer arena.allocator().free(sliced);

    try std.testing.expectEqual(@as(usize, 3), sliced.len);
    try std.testing.expectEqual(@as(u32, 20), sliced[0].value);
    try std.testing.expectEqual(@as(u32, 30), sliced[1].value);
    try std.testing.expectEqual(@as(u32, 40), sliced[2].value);
}

test "Rope - slice empty range" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    const items = [_]SimpleItem{
        .{ .value = 1 },
        .{ .value = 2 },
    };
    var rope = try RopeType.from_slice(arena.allocator(), &items);

    const sliced = try rope.slice(1, 1, arena.allocator());
    defer arena.allocator().free(sliced);

    try std.testing.expectEqual(@as(usize, 0), sliced.len);
}

test "Rope - delete_range at beginning" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    const items = [_]SimpleItem{
        .{ .value = 1 },
        .{ .value = 2 },
        .{ .value = 3 },
        .{ .value = 4 },
        .{ .value = 5 },
    };
    var rope = try RopeType.from_slice(arena.allocator(), &items);

    try rope.delete_range(0, 2);

    try std.testing.expectEqual(@as(u32, 3), rope.count());
    try std.testing.expectEqual(@as(u32, 3), rope.get(0).?.value);
    try std.testing.expectEqual(@as(u32, 4), rope.get(1).?.value);
    try std.testing.expectEqual(@as(u32, 5), rope.get(2).?.value);
}

test "Rope - delete_range in middle" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    const items = [_]SimpleItem{
        .{ .value = 1 },
        .{ .value = 2 },
        .{ .value = 3 },
        .{ .value = 4 },
        .{ .value = 5 },
    };
    var rope = try RopeType.from_slice(arena.allocator(), &items);

    try rope.delete_range(1, 4);

    try std.testing.expectEqual(@as(u32, 2), rope.count());
    try std.testing.expectEqual(@as(u32, 1), rope.get(0).?.value);
    try std.testing.expectEqual(@as(u32, 5), rope.get(1).?.value);
}

test "Rope - delete_range at end" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    const items = [_]SimpleItem{
        .{ .value = 1 },
        .{ .value = 2 },
        .{ .value = 3 },
    };
    var rope = try RopeType.from_slice(arena.allocator(), &items);

    try rope.delete_range(1, 3);

    try std.testing.expectEqual(@as(u32, 1), rope.count());
    try std.testing.expectEqual(@as(u32, 1), rope.get(0).?.value);
}

test "Rope - delete_range empty (same indices)" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    const items = [_]SimpleItem{
        .{ .value = 1 },
        .{ .value = 2 },
    };
    var rope = try RopeType.from_slice(arena.allocator(), &items);

    try rope.delete_range(1, 1);

    try std.testing.expectEqual(@as(u32, 2), rope.count());
}

test "Rope - insert_slice at beginning" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope = try RopeType.from_item(arena.allocator(), .{ .value = 3 });

    const to_insert = [_]SimpleItem{
        .{ .value = 1 },
        .{ .value = 2 },
    };
    try rope.insert_slice(0, &to_insert);

    try std.testing.expectEqual(@as(u32, 3), rope.count());
    try std.testing.expectEqual(@as(u32, 1), rope.get(0).?.value);
    try std.testing.expectEqual(@as(u32, 2), rope.get(1).?.value);
    try std.testing.expectEqual(@as(u32, 3), rope.get(2).?.value);
}

test "Rope - insert_slice in middle" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    const items = [_]SimpleItem{
        .{ .value = 1 },
        .{ .value = 4 },
    };
    var rope = try RopeType.from_slice(arena.allocator(), &items);

    const to_insert = [_]SimpleItem{
        .{ .value = 2 },
        .{ .value = 3 },
    };
    try rope.insert_slice(1, &to_insert);

    try std.testing.expectEqual(@as(u32, 4), rope.count());
    try std.testing.expectEqual(@as(u32, 1), rope.get(0).?.value);
    try std.testing.expectEqual(@as(u32, 2), rope.get(1).?.value);
    try std.testing.expectEqual(@as(u32, 3), rope.get(2).?.value);
    try std.testing.expectEqual(@as(u32, 4), rope.get(3).?.value);
}

test "Rope - insert_slice at end" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    const items = [_]SimpleItem{
        .{ .value = 1 },
        .{ .value = 2 },
    };
    var rope = try RopeType.from_slice(arena.allocator(), &items);

    const to_insert = [_]SimpleItem{
        .{ .value = 3 },
        .{ .value = 4 },
    };
    try rope.insert_slice(2, &to_insert);

    try std.testing.expectEqual(@as(u32, 4), rope.count());
    try std.testing.expectEqual(@as(u32, 3), rope.get(2).?.value);
    try std.testing.expectEqual(@as(u32, 4), rope.get(3).?.value);
}

test "Rope - insert_slice empty array" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope = try RopeType.from_item(arena.allocator(), .{ .value = 1 });

    const to_insert: []const SimpleItem = &[_]SimpleItem{};
    try rope.insert_slice(0, to_insert);

    try std.testing.expectEqual(@as(u32, 1), rope.count());
}

test "Rope - to_array with simple items" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    const items = [_]SimpleItem{
        .{ .value = 10 },
        .{ .value = 20 },
        .{ .value = 30 },
    };
    var rope = try RopeType.from_slice(arena.allocator(), &items);

    const array = try rope.to_array(arena.allocator());
    defer arena.allocator().free(array);

    try std.testing.expectEqual(@as(usize, 3), array.len);
    try std.testing.expectEqual(@as(u32, 10), array[0].value);
    try std.testing.expectEqual(@as(u32, 20), array[1].value);
    try std.testing.expectEqual(@as(u32, 30), array[2].value);
}

test "Rope - to_array empty rope" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope = try RopeType.init(arena.allocator());

    const array = try rope.to_array(arena.allocator());
    defer arena.allocator().free(array);

    try std.testing.expectEqual(@as(usize, 0), array.len); // Sentinel filtered
}

test "Rope - combined bulk operations" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    const items = [_]SimpleItem{
        .{ .value = 1 },
        .{ .value = 2 },
        .{ .value = 3 },
        .{ .value = 4 },
        .{ .value = 5 },
    };
    var rope = try RopeType.from_slice(arena.allocator(), &items);

    try rope.delete_range(2, 4);
    try std.testing.expectEqual(@as(u32, 3), rope.count());

    const to_insert = [_]SimpleItem{
        .{ .value = 30 },
        .{ .value = 40 },
    };
    try rope.insert_slice(1, &to_insert);
    try std.testing.expectEqual(@as(u32, 5), rope.count());

    const array = try rope.to_array(arena.allocator());
    defer arena.allocator().free(array);

    try std.testing.expectEqual(@as(u32, 1), array[0].value);
    try std.testing.expectEqual(@as(u32, 30), array[1].value);
    try std.testing.expectEqual(@as(u32, 40), array[2].value);
    try std.testing.expectEqual(@as(u32, 2), array[3].value);
    try std.testing.expectEqual(@as(u32, 5), array[4].value);
}

test "Rope - undo/redo with bulk operations" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    const items = [_]SimpleItem{
        .{ .value = 1 },
        .{ .value = 2 },
        .{ .value = 3 },
    };
    var rope = try RopeType.from_slice(arena.allocator(), &items);

    // Store state
    try rope.store_undo("before bulk");

    // Bulk insert
    const to_insert = [_]SimpleItem{
        .{ .value = 10 },
        .{ .value = 20 },
    };
    try rope.insert_slice(1, &to_insert);
    try std.testing.expectEqual(@as(u32, 5), rope.count());

    // Undo
    _ = try rope.undo("after bulk");
    try std.testing.expectEqual(@as(u32, 3), rope.count());

    // Redo
    _ = try rope.redo();
    try std.testing.expectEqual(@as(u32, 5), rope.count());
}

//===== Edge Case Tests =====

test "Rope - slice with start > end returns empty" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    const items = [_]SimpleItem{
        .{ .value = 1 },
        .{ .value = 2 },
        .{ .value = 3 },
    };
    var rope = try RopeType.from_slice(arena.allocator(), &items);

    const sliced = try rope.slice(2, 1, arena.allocator());
    defer arena.allocator().free(sliced);

    try std.testing.expectEqual(@as(usize, 0), sliced.len);
}

test "Rope - slice beyond bounds" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    const items = [_]SimpleItem{
        .{ .value = 1 },
        .{ .value = 2 },
    };
    var rope = try RopeType.from_slice(arena.allocator(), &items);

    // Should only get items that exist
    const sliced = try rope.slice(0, 100, arena.allocator());
    defer arena.allocator().free(sliced);

    try std.testing.expectEqual(@as(usize, 2), sliced.len);
}

test "Rope - delete_range with start > end does nothing" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    const items = [_]SimpleItem{
        .{ .value = 1 },
        .{ .value = 2 },
    };
    var rope = try RopeType.from_slice(arena.allocator(), &items);

    try rope.delete_range(2, 1);

    try std.testing.expectEqual(@as(u32, 2), rope.count());
}

test "Rope - insert_slice beyond count appends" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope = try RopeType.from_item(arena.allocator(), .{ .value = 1 });

    const to_insert = [_]SimpleItem{
        .{ .value = 2 },
        .{ .value = 3 },
    };
    try rope.insert_slice(100, &to_insert);

    try std.testing.expectEqual(@as(u32, 3), rope.count());
    try std.testing.expectEqual(@as(u32, 2), rope.get(1).?.value);
    try std.testing.expectEqual(@as(u32, 3), rope.get(2).?.value);
}

test "Rope - replace at out of bounds does nothing" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope = try RopeType.from_item(arena.allocator(), .{ .value = 1 });

    try rope.replace(100, .{ .value = 999 });

    try std.testing.expectEqual(@as(u32, 1), rope.count());
    try std.testing.expectEqual(@as(u32, 1), rope.get(0).?.value);
}

test "Rope - delete at out of bounds" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope = try RopeType.from_item(arena.allocator(), .{ .value = 1 });

    // This should handle gracefully (delete beyond bounds)
    try rope.delete(100);

    // Count unchanged
    try std.testing.expectEqual(@as(u32, 1), rope.count());
}

test "Rope - split at zero creates empty left" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    const items = [_]SimpleItem{
        .{ .value = 1 },
        .{ .value = 2 },
    };
    var rope = try RopeType.from_slice(arena.allocator(), &items);

    const right = try rope.split(0);

    try std.testing.expectEqual(@as(u32, 0), rope.count()); // Sentinel filtered
    try std.testing.expectEqual(@as(u32, 2), right.count());
}

test "Rope - split beyond count" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    const items = [_]SimpleItem{
        .{ .value = 1 },
        .{ .value = 2 },
    };
    var rope = try RopeType.from_slice(arena.allocator(), &items);

    const right = try rope.split(100);

    try std.testing.expectEqual(@as(u32, 2), rope.count());
    try std.testing.expectEqual(@as(u32, 0), right.count()); // Sentinel filtered
}

test "Rope - multiple undo without operations" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope = try RopeType.from_item(arena.allocator(), .{ .value = 1 });

    try rope.store_undo("state1");
    try rope.store_undo("state2");

    // Two undos back to back
    _ = try rope.undo("current");
    _ = try rope.undo("current");

    // Should fail on third
    const result = rope.undo("current");
    try std.testing.expectError(error.Stop, result);
}

test "Rope - stress test with 1000 items" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var items: [1000]SimpleItem = undefined;
    for (&items, 0..) |*item, i| {
        item.* = .{ .value = @intCast(i) };
    }

    var rope = try RopeType.from_slice(arena.allocator(), &items);

    try std.testing.expectEqual(@as(u32, 1000), rope.count());
    try std.testing.expectEqual(@as(u32, 0), rope.get(0).?.value);
    try std.testing.expectEqual(@as(u32, 500), rope.get(500).?.value);
    try std.testing.expectEqual(@as(u32, 999), rope.get(999).?.value);

    const depth = rope.root.depth();
    try std.testing.expect(depth < 20); // log2(1000) ≈ 10, allow some slack
}

test "Rope - delete_range entire rope" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    const items = [_]SimpleItem{
        .{ .value = 1 },
        .{ .value = 2 },
        .{ .value = 3 },
    };
    var rope = try RopeType.from_slice(arena.allocator(), &items);

    try rope.delete_range(0, 3);

    // Should be empty (sentinel filtered)
    try std.testing.expectEqual(@as(u32, 0), rope.count());
}

test "Rope - to_array single item" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope = try RopeType.from_item(arena.allocator(), .{ .value = 42 });

    const array = try rope.to_array(arena.allocator());
    defer arena.allocator().free(array);

    try std.testing.expectEqual(@as(usize, 1), array.len);
    try std.testing.expectEqual(@as(u32, 42), array[0].value);
}

test "Rope - concat with empty rope" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope1 = try RopeType.from_item(arena.allocator(), .{ .value = 1 });
    const rope2 = try RopeType.init(arena.allocator());

    try rope1.concat(&rope2);

    try std.testing.expectEqual(@as(u32, 1), rope1.count()); // original only (empty filtered)
}

test "Rope - redo after modifying tree fails" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope = try RopeType.from_item(arena.allocator(), .{ .value = 1 });

    try rope.store_undo("state1");
    try rope.append(.{ .value = 2 });

    _ = try rope.undo("current");

    // Manually modify the rope (breaking the redo contract)
    try rope.append(.{ .value = 3 });

    // Redo should fail because tree was modified
    const result = rope.redo();
    try std.testing.expectError(error.Stop, result);
}

test "Rope - rebalance extremely unbalanced tree" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope = try RopeType.init(arena.allocator());

    for (0..50) |i| {
        try rope.append(.{ .value = @intCast(i) });
    }

    const depth_before = rope.root.depth();

    // Rebalance
    try rope.rebalance(arena.allocator());

    const depth_after = rope.root.depth();

    // Should be more balanced now
    try std.testing.expect(depth_after <= depth_before);
    try std.testing.expect(depth_after < 15); // log2(50) ≈ 6

    // Data should be preserved
    try std.testing.expectEqual(@as(u32, 50), rope.count());
    try std.testing.expectEqual(@as(u32, 0), rope.get(0).?.value); // Fixed index
}

//===== Weight-aware Tests =====

// Type with custom weight for testing weight-based operations
const WeightedItem = struct {
    value: u32,
    weight: u32,

    pub const Metrics = struct {
        total_weight: u32 = 0,

        pub fn add(self: *Metrics, other: Metrics) void {
            self.total_weight += other.total_weight;
        }

        pub fn weight(self: *const Metrics) u32 {
            return self.total_weight;
        }
    };

    pub fn measure(self: *const WeightedItem) Metrics {
        return .{ .total_weight = self.weight };
    }

    pub fn empty() WeightedItem {
        return .{ .value = 0, .weight = 0 };
    }

    pub fn is_empty(self: *const WeightedItem) bool {
        return self.value == 0 and self.weight == 0;
    }
};

// Leaf split function for testing (callback format)
const WeightedRope = rope_mod.Rope(WeightedItem);

fn splitWeightedItemCallback(
    allocator: std.mem.Allocator,
    ctx: ?*anyopaque,
    leaf: *const WeightedItem,
    weight_in_leaf: u32,
) error{ OutOfBounds, OutOfMemory }!WeightedRope.Node.LeafSplitResult {
    _ = ctx;
    _ = allocator;
    if (weight_in_leaf == 0) {
        return .{
            .left = WeightedItem.empty(),
            .right = leaf.*,
        };
    } else if (weight_in_leaf >= leaf.weight) {
        return .{
            .left = leaf.*,
            .right = WeightedItem.empty(),
        };
    }

    // Split proportionally
    return .{
        .left = .{ .value = leaf.value, .weight = weight_in_leaf },
        .right = .{ .value = leaf.value + 1000, .weight = leaf.weight - weight_in_leaf },
    };
}

// Helper to create the callback struct
fn makeWeightedSplitter() WeightedRope.Node.LeafSplitFn {
    return .{
        .ctx = null,
        .splitFn = splitWeightedItemCallback,
    };
}

test "Rope - totalWeight returns correct weight" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const items = [_]WeightedItem{
        .{ .value = 1, .weight = 10 },
        .{ .value = 2, .weight = 20 },
        .{ .value = 3, .weight = 30 },
    };

    var rope = try WeightedRope.from_slice(arena.allocator(), &items);
    try std.testing.expectEqual(@as(u32, 60), rope.totalWeight());
}

test "Rope - split_at_weight at boundary" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const items = [_]WeightedItem{
        .{ .value = 1, .weight = 10 },
        .{ .value = 2, .weight = 20 },
        .{ .value = 3, .weight = 30 },
    };

    const rope = try WeightedRope.from_slice(arena.allocator(), &items);

    // Split at weight 30 (boundary between second and third item)
    const splitter = makeWeightedSplitter();
    const result = try WeightedRope.Node.split_at_weight(rope.root, 30, arena.allocator(), rope.empty_leaf, &splitter);

    // Left should have weight 30 (first two items)
    try std.testing.expectEqual(@as(u32, 30), result.left.metrics().weight());

    // Right should have weight 30 (third item)
    try std.testing.expectEqual(@as(u32, 30), result.right.metrics().weight());
}

test "Rope - split_at_weight inside leaf" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const rope = try WeightedRope.from_item(arena.allocator(), .{ .value = 1, .weight = 100 });

    // Split at weight 40 (inside the single leaf)
    const splitter = makeWeightedSplitter();
    const result = try WeightedRope.Node.split_at_weight(rope.root, 40, arena.allocator(), rope.empty_leaf, &splitter);

    // Left should have weight 40
    try std.testing.expectEqual(@as(u32, 40), result.left.metrics().weight());

    // Right should have weight 60
    try std.testing.expectEqual(@as(u32, 60), result.right.metrics().weight());
}

test "Rope - splitByWeight" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const items = [_]WeightedItem{
        .{ .value = 1, .weight = 10 },
        .{ .value = 2, .weight = 20 },
        .{ .value = 3, .weight = 30 },
    };

    var rope = try WeightedRope.from_slice(arena.allocator(), &items);
    try std.testing.expectEqual(@as(u32, 60), rope.totalWeight());

    // Split at weight 30
    const splitter = makeWeightedSplitter();
    const right_half = try rope.splitByWeight(30, &splitter);

    // Left half should have weight 30
    try std.testing.expectEqual(@as(u32, 30), rope.totalWeight());

    // Right half should have weight 30
    try std.testing.expectEqual(@as(u32, 30), right_half.totalWeight());
}

test "Rope - deleteRangeByWeight" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const items = [_]WeightedItem{
        .{ .value = 1, .weight = 10 },
        .{ .value = 2, .weight = 20 },
        .{ .value = 3, .weight = 30 },
        .{ .value = 4, .weight = 40 },
    };

    var rope = try WeightedRope.from_slice(arena.allocator(), &items);
    try std.testing.expectEqual(@as(u32, 100), rope.totalWeight());

    // Delete weight range [10, 30) - removes the second item (weight 20)
    const splitter = makeWeightedSplitter();
    try rope.deleteRangeByWeight(10, 30, &splitter);

    // Should have removed weight 20
    try std.testing.expectEqual(@as(u32, 80), rope.totalWeight());
}

test "Rope - insertSliceByWeight" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const items = [_]WeightedItem{
        .{ .value = 1, .weight = 10 },
        .{ .value = 3, .weight = 30 },
    };

    var rope = try WeightedRope.from_slice(arena.allocator(), &items);
    try std.testing.expectEqual(@as(u32, 40), rope.totalWeight());

    // Insert at weight 10 (after first item)
    const insert_items = [_]WeightedItem{
        .{ .value = 2, .weight = 20 },
    };
    const splitter = makeWeightedSplitter();
    try rope.insertSliceByWeight(10, &insert_items, &splitter);

    // Should have added weight 20
    try std.testing.expectEqual(@as(u32, 60), rope.totalWeight());
}

test "Rope - findByWeight" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const items = [_]WeightedItem{
        .{ .value = 1, .weight = 10 },
        .{ .value = 2, .weight = 20 },
        .{ .value = 3, .weight = 30 },
    };

    var rope = try WeightedRope.from_slice(arena.allocator(), &items);

    // Find leaf containing weight 0 (first item)
    const result0 = rope.findByWeight(0);
    try std.testing.expect(result0 != null);
    try std.testing.expectEqual(@as(u32, 1), result0.?.leaf.value);
    try std.testing.expectEqual(@as(u32, 0), result0.?.start_weight);

    // Find leaf containing weight 15 (second item)
    const result15 = rope.findByWeight(15);
    try std.testing.expect(result15 != null);
    try std.testing.expectEqual(@as(u32, 2), result15.?.leaf.value);
    try std.testing.expectEqual(@as(u32, 10), result15.?.start_weight);

    // Find leaf containing weight 35 (third item)
    const result35 = rope.findByWeight(35);
    try std.testing.expect(result35 != null);
    try std.testing.expectEqual(@as(u32, 3), result35.?.leaf.value);
    try std.testing.expectEqual(@as(u32, 30), result35.?.start_weight);

    // Out of bounds
    const result100 = rope.findByWeight(100);
    try std.testing.expect(result100 == null);
}

//===== Integrated Marker Tracking Tests (Union Types) =====

// Simple union type for testing automatic marker tracking
const TokenType = union(enum) {
    word: u32,
    space: u32,
    newline: void, // Marker type

    // Define which tags are markers (only track these!)
    pub const MarkerTypes = &[_]std.meta.Tag(TokenType){.newline};

    pub const Metrics = struct {
        width: u32 = 0,

        pub fn add(self: *Metrics, other: Metrics) void {
            self.width += other.width;
        }

        pub fn weight(self: *const Metrics) u32 {
            return self.width;
        }
    };

    pub fn measure(self: *const TokenType) Metrics {
        return switch (self.*) {
            .word => |w| .{ .width = w },
            .space => |s| .{ .width = s },
            .newline => .{ .width = 0 },
        };
    }

    pub fn empty() TokenType {
        return .{ .space = 0 };
    }

    pub fn is_empty(self: *const TokenType) bool {
        return switch (self.*) {
            .space => |s| s == 0,
            else => false,
        };
    }
};

test "Rope - automatic marker tracking with union type" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(TokenType);

    // Create rope with marker tracking enabled
    const tokens = [_]TokenType{
        .{ .word = 5 }, // "Hello"
        .{ .space = 1 }, // " "
        .{ .word = 5 }, // "World"
        .{ .newline = {} }, // Line break marker
        .{ .word = 6 }, // "Second"
        .{ .space = 1 }, // " "
        .{ .word = 4 }, // "Line"
        .{ .newline = {} }, // Line break marker
        .{ .word = 5 }, // "Third"
    };

    var rope = try RopeType.from_slice(arena.allocator(), &tokens);

    // O(1) lookup: find newline markers (only .newline is tracked, not .word or .space)
    try std.testing.expectEqual(@as(u32, 2), rope.markerCount(.newline));

    // Get first newline (end of line 0)
    const nl0 = rope.getMarker(.newline, 0);
    try std.testing.expect(nl0 != null);
    try std.testing.expectEqual(@as(u32, 3), nl0.?.leaf_index); // After word, space, word
    try std.testing.expectEqual(@as(u32, 11), nl0.?.global_weight); // 5 + 1 + 5

    // Get second newline (end of line 1)
    const nl1 = rope.getMarker(.newline, 1);
    try std.testing.expect(nl1 != null);
    try std.testing.expectEqual(@as(u32, 7), nl1.?.leaf_index);
    try std.testing.expectEqual(@as(u32, 22), nl1.?.global_weight); // 11 + 6 + 1 + 4

    // Word and space are NOT markers - should return 0
    try std.testing.expectEqual(@as(u32, 0), rope.markerCount(.word));
    try std.testing.expectEqual(@as(u32, 0), rope.markerCount(.space));
}

test "Rope - marker tracking with empty rope" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(TokenType);
    var rope = try RopeType.init(arena.allocator());

    try std.testing.expectEqual(@as(u32, 0), rope.markerCount(.newline));
    try std.testing.expectEqual(@as(u32, 0), rope.markerCount(.word)); // Not a marker type
    try std.testing.expect(rope.getMarker(.newline, 0) == null);
}

test "Rope - marker tracking requires rebuild" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(TokenType);
    const tokens = [_]TokenType{
        .{ .word = 5 },
        .{ .newline = {} },
    };

    var rope = try RopeType.from_slice(arena.allocator(), &tokens);

    // Markers are automatically tracked in the tree
    try std.testing.expectEqual(@as(u32, 1), rope.markerCount(.newline));
    try std.testing.expect(rope.getMarker(.newline, 0) != null);
}

test "Rope - marker tracking with many markers" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(TokenType);

    // Create 100 lines
    var tokens_array: [199]TokenType = undefined; // 100 words + 99 newlines
    for (0..100) |i| {
        if (i > 0) {
            tokens_array[i * 2 - 1] = .{ .newline = {} };
        }
        tokens_array[i * 2] = .{ .word = 5 };
    }

    var rope = try RopeType.from_slice(arena.allocator(), &tokens_array);

    // Should have 99 newlines (only newlines are tracked as markers)
    try std.testing.expectEqual(@as(u32, 99), rope.markerCount(.newline));

    // Test O(1) random access to specific lines
    const nl50 = rope.getMarker(.newline, 50).?;
    try std.testing.expectEqual(@as(u32, 101), nl50.leaf_index); // word, nl, word, nl, ... (50th newline is at index 101)
    try std.testing.expectEqual(@as(u32, 255), nl50.global_weight); // 51 words * 5 width

    const nl98 = rope.getMarker(.newline, 98).?;
    try std.testing.expectEqual(@as(u32, 197), nl98.leaf_index);
}
//===== Debug toText Tests =====

test "Rope - toText shows basic structure" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    const items = [_]SimpleItem{
        .{ .value = 1 },
        .{ .value = 2 },
        .{ .value = 3 },
    };
    var rope = try RopeType.from_slice(arena.allocator(), &items);

    const debug_text = try rope.toText(arena.allocator());

    try std.testing.expect(std.mem.find(u8, debug_text, "[root") != null);
    try std.testing.expect(std.mem.find(u8, debug_text, "branch") != null or std.mem.find(u8, debug_text, "leaf") != null);
}

test "Rope - toText shows empty rope" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope = try RopeType.init(arena.allocator());

    const debug_text = try rope.toText(arena.allocator());

    try std.testing.expect(std.mem.find(u8, debug_text, "[root") != null);
    try std.testing.expect(std.mem.find(u8, debug_text, "[empty]") != null);
}

test "Rope - toText with union type shows tags" {
    const TestSegment = union(enum) {
        text: struct { width: u32 },
        brk: void,
        linestart: void,

        pub const MarkerTypes = &[_]std.meta.Tag(@This()){ .brk, .linestart };

        pub const Metrics = struct {
            width: u32 = 0,

            pub fn add(self: *Metrics, other: Metrics) void {
                self.width += other.width;
            }

            pub fn weight(self: *const Metrics) u32 {
                return self.width;
            }
        };

        pub fn measure(self: *const @This()) Metrics {
            return switch (self.*) {
                .text => |t| Metrics{ .width = t.width },
                .brk => Metrics{ .width = 1 },
                .linestart => Metrics{ .width = 0 },
            };
        }

        pub fn empty() @This() {
            return .{ .text = .{ .width = 0 } };
        }

        pub fn is_empty(self: *const @This()) bool {
            return switch (self.*) {
                .text => |t| t.width == 0,
                else => false,
            };
        }
    };

    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const TestRope = rope_mod.Rope(TestSegment);
    var rope = try TestRope.from_slice(arena.allocator(), &[_]TestSegment{
        .linestart,
        .{ .text = .{ .width = 5 } },
        .brk,
        .linestart,
        .{ .text = .{ .width = 10 } },
    });

    const debug_text = try rope.toText(arena.allocator());

    try std.testing.expect(std.mem.find(u8, debug_text, "text") != null);
    try std.testing.expect(std.mem.find(u8, debug_text, "brk") != null);
    try std.testing.expect(std.mem.find(u8, debug_text, "linestart") != null);
    try std.testing.expect(std.mem.find(u8, debug_text, "w5") != null);
    try std.testing.expect(std.mem.find(u8, debug_text, "w10") != null);
}

test "Rope - toText with nested structure" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);

    // Create a larger rope that will have branches
    var items: [10]SimpleItem = undefined;
    for (&items, 0..) |*item, i| {
        item.* = .{ .value = @intCast(i) };
    }
    var rope = try RopeType.from_slice(arena.allocator(), &items);

    const debug_text = try rope.toText(arena.allocator());

    try std.testing.expect(std.mem.find(u8, debug_text, "[root") != null);
    try std.testing.expect(std.mem.find(u8, debug_text, "[branch") != null);
}

test "Rope - toText after insertions shows updated structure" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope = try RopeType.from_item(arena.allocator(), .{ .value = 1 });

    const before = try rope.toText(arena.allocator());
    try std.testing.expect(std.mem.find(u8, before, "[root") != null);

    try rope.append(.{ .value = 2 });
    try rope.append(.{ .value = 3 });

    const after = try rope.toText(arena.allocator());
    try std.testing.expect(std.mem.find(u8, after, "[root") != null);
    try std.testing.expect(after.len >= before.len);
}

test "Rope - toText with custom metrics shows width info" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(ItemWithMetrics);
    const items = [_]ItemWithMetrics{
        .{ .value = 1, .size = 100 },
        .{ .value = 2, .size = 200 },
    };
    var rope = try RopeType.from_slice(arena.allocator(), &items);

    const debug_text = try rope.toText(arena.allocator());

    try std.testing.expect(std.mem.find(u8, debug_text, "[root") != null);
    try std.testing.expect(std.mem.find(u8, debug_text, "w") != null);
}

test "Rope - toText shows single leaf" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope = try RopeType.from_item(arena.allocator(), .{ .value = 42 });

    const debug_text = try rope.toText(arena.allocator());

    try std.testing.expect(std.mem.find(u8, debug_text, "[root") != null);
    try std.testing.expect(std.mem.find(u8, debug_text, "[leaf") != null);
    try std.testing.expect(std.mem.find(u8, debug_text, "]") != null);
}

test "Rope - marker cache MUST update after delete operations" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(TokenType);

    // Create: word(5) newline word(5) newline word(5)
    // 3 lines total, 2 newlines
    const tokens = [_]TokenType{
        .{ .word = 5 },
        .{ .newline = {} },
        .{ .word = 5 },
        .{ .newline = {} },
        .{ .word = 5 },
    };

    var rope = try RopeType.from_slice(arena.allocator(), &tokens);

    try std.testing.expectEqual(@as(u32, 2), rope.markerCount(.newline));

    try rope.delete(4);

    try std.testing.expectEqual(@as(u32, 2), rope.markerCount(.newline));

    // The critical test: marker positions MUST be correct after delete!
    const nl1_after = rope.getMarker(.newline, 1);
    try std.testing.expect(nl1_after != null);

    // After deleting the last word at index 4, the second newline should be at index 3
    // (was at index 3 before, stays at 3 after deleting index 4)
    try std.testing.expectEqual(@as(u32, 3), nl1_after.?.leaf_index);
}

test "Rope - marker cache MUST update after undo" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(TokenType);

    // Create: word(10) newline word(5)
    const tokens = [_]TokenType{
        .{ .word = 10 },
        .{ .newline = {} },
        .{ .word = 5 },
    };

    var rope = try RopeType.from_slice(arena.allocator(), &tokens);

    // Initial state: 1 newline at weight 10
    const nl_before = rope.getMarker(.newline, 0);
    try std.testing.expect(nl_before != null);
    try std.testing.expectEqual(@as(u32, 10), nl_before.?.global_weight);

    // Store undo point
    try rope.store_undo("before delete");

    // Delete part of first word: delete range [0, 1) removes first word
    try rope.delete_range(0, 1);

    // After delete: newline should be at weight 0 (no word before it)
    const nl_after_delete = rope.getMarker(.newline, 0);
    try std.testing.expect(nl_after_delete != null);
    try std.testing.expectEqual(@as(u32, 0), nl_after_delete.?.global_weight);

    // Undo the delete
    _ = try rope.undo("after delete");

    // CRITICAL: After undo, marker cache MUST be recalculated!
    // Newline should be back at weight 10
    const nl_after_undo = rope.getMarker(.newline, 0);
    try std.testing.expect(nl_after_undo != null);
    try std.testing.expectEqual(@as(u32, 10), nl_after_undo.?.global_weight);
}

test "Rope - marker cache MUST update after redo" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(TokenType);

    const tokens = [_]TokenType{
        .{ .word = 10 },
        .{ .newline = {} },
        .{ .word = 5 },
    };

    var rope = try RopeType.from_slice(arena.allocator(), &tokens);

    try rope.store_undo("initial");
    try rope.delete_range(0, 1);

    const nl_after_delete = rope.getMarker(.newline, 0);
    try std.testing.expectEqual(@as(u32, 0), nl_after_delete.?.global_weight);

    // Undo
    _ = try rope.undo("after delete");
    const nl_after_undo = rope.getMarker(.newline, 0);
    try std.testing.expectEqual(@as(u32, 10), nl_after_undo.?.global_weight);

    // Redo
    _ = try rope.redo();

    // CRITICAL: After redo, marker cache MUST be recalculated!
    const nl_after_redo = rope.getMarker(.newline, 0);
    try std.testing.expect(nl_after_redo != null);
    try std.testing.expectEqual(@as(u32, 0), nl_after_redo.?.global_weight);
}

test "Rope - marker cache survives multiple undo/redo cycles" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(TokenType);

    var rope = try RopeType.from_slice(arena.allocator(), &[_]TokenType{
        .{ .word = 5 },
        .{ .newline = {} },
        .{ .word = 5 },
    });

    try rope.store_undo("state1");
    try rope.append(.{ .newline = {} });
    try rope.append(.{ .word = 5 });

    // Should have 2 newlines now
    try std.testing.expectEqual(@as(u32, 2), rope.markerCount(.newline));
    const nl1_orig = rope.getMarker(.newline, 1);
    try std.testing.expectEqual(@as(u32, 10), nl1_orig.?.global_weight);

    try rope.store_undo("state2");
    try rope.delete(0); // Delete first word

    // Markers should update: first newline now at weight 0
    const nl0_after_delete = rope.getMarker(.newline, 0);
    try std.testing.expectEqual(@as(u32, 0), nl0_after_delete.?.global_weight);

    // Undo twice
    _ = try rope.undo("current");
    _ = try rope.undo("current");

    // Back to original: 1 newline at weight 5
    try std.testing.expectEqual(@as(u32, 1), rope.markerCount(.newline));
    const nl_final = rope.getMarker(.newline, 0);
    try std.testing.expectEqual(@as(u32, 5), nl_final.?.global_weight);

    // Redo twice
    _ = try rope.redo();
    _ = try rope.redo();

    // Should match the post-delete state
    const nl0_redo = rope.getMarker(.newline, 0);
    try std.testing.expectEqual(@as(u32, 0), nl0_redo.?.global_weight);
}

//===== Configurable Undo Depth Tests =====

test "Rope - weight-based balancing with custom weight function" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    // Create items with different sizes
    const items = [_]WeightedItem{
        .{ .value = 1, .weight = 100 }, // Large item
        .{ .value = 2, .weight = 10 }, // Small item
        .{ .value = 3, .weight = 200 }, // Very large item
        .{ .value = 4, .weight = 50 }, // Medium item
    };

    var rope = try WeightedRope.from_slice(arena.allocator(), &items);

    // Check that metrics are tracked
    const metrics = rope.root.metrics();
    try std.testing.expectEqual(@as(u32, 4), metrics.count);
    try std.testing.expectEqual(@as(u32, 360), metrics.custom.total_weight);
    try std.testing.expectEqual(@as(u32, 360), metrics.weight()); // Should use weight()
}

test "Rope - unlimited undo depth by default" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope = try RopeType.init(arena.allocator());

    // Store many undo states
    for (0..100) |i| {
        try rope.store_undo("state");
        try rope.append(.{ .value = @intCast(i) });
    }

    // Should have all 100 states
    try std.testing.expectEqual(@as(usize, 100), rope.undo_depth);
    try std.testing.expect(rope.can_undo());
}

test "Rope - max_undo_depth limits history" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope = try RopeType.initWithConfig(arena.allocator(), .{ .max_undo_depth = 10 });

    // Store 20 undo states
    for (0..20) |i| {
        try rope.store_undo("state");
        try rope.append(.{ .value = @intCast(i) });
    }

    // Should only keep 10 states
    try std.testing.expectEqual(@as(usize, 10), rope.undo_depth);
    try std.testing.expect(rope.can_undo());

    // Can undo at most 10 times (may be less due to how history works)
    var undo_count: usize = 0;
    while (rope.can_undo()) : (undo_count += 1) {
        _ = rope.undo("current") catch break;
    }
    // Should have undone at least some operations, but not more than 10
    try std.testing.expect(undo_count > 0);
    try std.testing.expect(undo_count <= 10);
}

test "Rope - trimUndoHistory works correctly" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope = try RopeType.initWithConfig(arena.allocator(), .{ .max_undo_depth = 5 });

    for (0..10) |i| {
        try rope.store_undo("state");
        try rope.append(.{ .value = @intCast(i) });

        try std.testing.expect(rope.undo_depth <= 5);
    }

    try std.testing.expectEqual(@as(usize, 5), rope.undo_depth);
}

test "Rope - weight-based join_balanced respects weight ratio" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const left_items = [_]WeightedItem{
        .{ .value = 1, .weight = 1000 },
        .{ .value = 2, .weight = 1000 },
        .{ .value = 3, .weight = 1000 },
    };
    var rope_left = try WeightedRope.from_slice(arena.allocator(), &left_items);

    const right_items = [_]WeightedItem{
        .{ .value = 4, .weight = 100 },
    };
    const rope_right = try WeightedRope.from_slice(arena.allocator(), &right_items);

    try rope_left.concat(&rope_right);

    try std.testing.expectEqual(@as(u32, 4), rope_left.count());

    try std.testing.expect(rope_left.root.is_balanced());
}

test "Rope - integration weight-based balancing with history limits" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    var rope = try WeightedRope.initWithConfig(arena.allocator(), .{ .max_undo_depth = 5 });

    var expected_count: u32 = 0;
    for (0..10) |i| {
        try rope.store_undo("insert");
        try rope.append(.{
            .value = @intCast(i),
            .weight = @intCast((i + 1) * 10),
        });
        expected_count += 1;
    }

    try std.testing.expectEqual(expected_count, rope.count());

    try rope.insert(5, .{ .value = 999, .weight = 50 });
    expected_count += 1;

    try std.testing.expectEqual(expected_count, rope.count());

    try std.testing.expect(rope.undo_depth <= 5);

    try std.testing.expect(rope.root.is_balanced());
}

test "Rope - clear removes all items" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    const items = [_]SimpleItem{
        .{ .value = 1 },
        .{ .value = 2 },
        .{ .value = 3 },
    };
    var rope = try RopeType.from_slice(arena.allocator(), &items);

    try std.testing.expectEqual(@as(u32, 3), rope.count());

    rope.clear();

    try std.testing.expectEqual(@as(u32, 0), rope.count());
}

test "Rope - clear on empty rope" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope = try RopeType.init(arena.allocator());

    try std.testing.expectEqual(@as(u32, 0), rope.count());

    rope.clear();

    try std.testing.expectEqual(@as(u32, 0), rope.count());
}

test "Rope - clear then insert works" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope = try RopeType.from_item(arena.allocator(), .{ .value = 1 });

    rope.clear();
    try std.testing.expectEqual(@as(u32, 0), rope.count());

    try rope.append(.{ .value = 42 });
    try std.testing.expectEqual(@as(u32, 1), rope.count());
    try std.testing.expectEqual(@as(u32, 42), rope.get(0).?.value);
}

test "Rope - clear with markers resets marker cache" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(TokenType);
    const tokens = [_]TokenType{
        .{ .word = 5 },
        .{ .newline = {} },
        .{ .word = 5 },
        .{ .newline = {} },
    };

    var rope = try RopeType.from_slice(arena.allocator(), &tokens);
    try std.testing.expectEqual(@as(u32, 2), rope.markerCount(.newline));

    rope.clear();

    try std.testing.expectEqual(@as(u32, 0), rope.count());
    try std.testing.expectEqual(@as(u32, 0), rope.markerCount(.newline));
}

test "Rope - integration all features working together" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(SimpleItem);
    var rope = try RopeType.initWithConfig(arena.allocator(), .{ .max_undo_depth = 3 });

    try std.testing.expectEqual(@as(u32, 0), rope.count());

    try rope.store_undo("empty");
    try rope.append(.{ .value = 1 });

    try rope.store_undo("one");
    try rope.append(.{ .value = 2 });

    try rope.store_undo("two");
    try rope.append(.{ .value = 3 });

    try rope.store_undo("three");
    try rope.append(.{ .value = 4 });

    try std.testing.expectEqual(@as(u32, 4), rope.count());

    try std.testing.expectEqual(@as(usize, 3), rope.undo_depth);

    const val = rope.get(2);
    try std.testing.expectEqual(@as(u32, 3), val.?.value);

    _ = try rope.undo("current");
    try std.testing.expectEqual(@as(u32, 3), rope.count());

    const Context = struct {
        count: u32 = 0,
        fn walker(ctx: *anyopaque, data: *const SimpleItem, index: u32) RopeType.Node.WalkerResult {
            _ = data;
            _ = index;
            const self = @as(*@This(), @ptrCast(@alignCast(ctx)));
            self.count += 1;
            return .{};
        }
    };
    var ctx: Context = .{};
    try rope.walk(&ctx, Context.walker);
    try std.testing.expectEqual(@as(u32, 3), ctx.count);
}
