const std = @import("std");
const rope_mod = @import("../rope.zig");

const TestItem = struct {
    value: u32,

    pub fn empty() TestItem {
        return .{ .value = 0 };
    }

    pub fn is_empty(self: *const TestItem) bool {
        return self.value == 0;
    }
};

fn verifyInvariants(rope: *const rope_mod.Rope(TestItem)) !void {
    const count = rope.count();

    var walked_count: u32 = 0;
    const Context = struct {
        count: *u32,
        last_seen: u32 = 0,

        fn walker(ctx: *anyopaque, data: *const TestItem, index: u32) rope_mod.Rope(TestItem).Node.WalkerResult {
            _ = index;
            _ = data;
            const self = @as(*@This(), @ptrCast(@alignCast(ctx)));
            self.count.* += 1;
            return .{};
        }
    };

    var ctx: Context = .{ .count = &walked_count };
    try rope.walk(&ctx, Context.walker);

    try std.testing.expectEqual(count, walked_count);

    // Verify depth is logarithmic (allow slack for imbalance and sequential inserts)
    const depth = rope.root.depth();
    const max_expected_depth: u32 = if (count <= 1) 1 else @as(u32, @intFromFloat(@ceil(@log2(@as(f64, @floatFromInt(count)))) * 4.5));
    try std.testing.expect(depth <= max_expected_depth);
}

test "Rope fuzz - random insert/delete sequence" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(TestItem);
    var rope = try RopeType.init(arena.allocator());

    var prng = std.Random.DefaultPrng.init(42);
    const random = prng.random();

    var i: usize = 0;
    while (i < 100) : (i += 1) {
        const op = random.intRangeAtMost(u8, 0, 2);
        const current_count = rope.count();

        switch (op) {
            0 => {
                const pos = if (current_count > 0) random.intRangeAtMost(u32, 0, current_count) else 0;
                const value = random.int(u32);
                try rope.insert(pos, .{ .value = value });
            },
            1 => {
                if (current_count > 1) {
                    const pos = random.intRangeAtMost(u32, 0, current_count - 1);
                    try rope.delete(pos);
                }
            },
            2 => {
                if (current_count > 0) {
                    const pos = random.intRangeAtMost(u32, 0, current_count - 1);
                    const value = random.int(u32);
                    try rope.replace(pos, .{ .value = value });
                }
            },
            else => unreachable,
        }

        if (i % 10 == 0) {
            try verifyInvariants(&rope);
        }
    }

    try verifyInvariants(&rope);
}

test "Rope fuzz - random bulk operations" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(TestItem);
    var rope = try RopeType.init(arena.allocator());

    var prng = std.Random.DefaultPrng.init(123);
    const random = prng.random();

    var i: usize = 0;
    while (i < 50) : (i += 1) {
        const op = random.intRangeAtMost(u8, 0, 3);
        const current_count = rope.count();

        switch (op) {
            0 => {
                const slice_len = random.intRangeAtMost(u8, 1, 10);
                var items: [10]TestItem = undefined;
                for (items[0..slice_len]) |*item| {
                    item.* = .{ .value = random.int(u32) };
                }
                const pos = if (current_count > 0) random.intRangeAtMost(u32, 0, current_count) else 0;
                try rope.insert_slice(pos, items[0..slice_len]);
            },
            1 => {
                if (current_count > 2) {
                    const start = random.intRangeAtMost(u32, 0, current_count - 2);
                    const end = random.intRangeAtMost(u32, start + 1, current_count);
                    try rope.delete_range(start, end);
                }
            },
            2 => {
                if (current_count > 1) {
                    const split_pos = random.intRangeAtMost(u32, 1, current_count - 1);
                    var right_half = try rope.split(split_pos);
                    try rope.concat(&right_half);
                }
            },
            3 => {
                const new_len = random.intRangeAtMost(u8, 1, 5);
                var items: [5]TestItem = undefined;
                for (items[0..new_len]) |*item| {
                    item.* = .{ .value = random.int(u32) };
                }
                const new_rope = try RopeType.from_slice(arena.allocator(), items[0..new_len]);
                try rope.concat(&new_rope);
            },
            else => unreachable,
        }

        if (i % 5 == 0) {
            try verifyInvariants(&rope);
        }
    }

    try verifyInvariants(&rope);
}

test "Rope fuzz - stress test with many items" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(TestItem);
    var rope = try RopeType.init(arena.allocator());

    var i: u32 = 0;
    while (i < 1000) : (i += 1) {
        try rope.append(.{ .value = i });
    }

    try verifyInvariants(&rope);

    var prng = std.Random.DefaultPrng.init(789);
    const random = prng.random();

    var j: usize = 0;
    while (j < 200) : (j += 1) {
        const op = random.intRangeAtMost(u8, 0, 1);
        const current_count = rope.count();

        switch (op) {
            0 => {
                if (current_count > 100) {
                    const pos = random.intRangeAtMost(u32, 0, current_count - 1);
                    try rope.delete(pos);
                }
            },
            1 => {
                const pos = random.intRangeAtMost(u32, 0, current_count);
                try rope.insert(pos, .{ .value = random.int(u32) });
            },
            else => unreachable,
        }
    }

    try verifyInvariants(&rope);

    const depth = rope.root.depth();
    const count = rope.count();
    const max_expected_depth: u32 = @intFromFloat(@ceil(@log2(@as(f64, @floatFromInt(count)))) * 4.0);
    try std.testing.expect(depth <= max_expected_depth);
}

test "Rope fuzz - positional operations" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();

    const RopeType = rope_mod.Rope(TestItem);
    var rope = try RopeType.init(arena.allocator());

    var i: u32 = 0;
    while (i < 50) : (i += 1) {
        try rope.append(.{ .value = i });
    }

    var prng = std.Random.DefaultPrng.init(456);
    const random = prng.random();

    var position: u32 = 25;

    var j: usize = 0;
    while (j < 30) : (j += 1) {
        const op = random.intRangeAtMost(u8, 0, 2);

        switch (op) {
            0 => {
                try rope.insert(position, .{ .value = random.int(u32) });
                position = position + 1;
            },
            1 => {
                if (position < rope.count()) {
                    try rope.delete(position);
                }
            },
            2 => {
                if (position < rope.count()) {
                    try rope.replace(position, .{ .value = random.int(u32) });
                }
            },
            else => unreachable,
        }

        if (random.boolean() and rope.count() > 0) {
            position = random.intRangeAtMost(u32, 0, rope.count() - 1);
        }
    }

    try verifyInvariants(&rope);
}
