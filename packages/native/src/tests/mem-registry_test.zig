const std = @import("std");
const mem_registry = @import("../mem-registry.zig");
const utils = @import("../utils.zig");

const MemRegistry = mem_registry.MemRegistry;
const MemRegistryError = mem_registry.MemRegistryError;

test "MemRegistry - cancel latest registration without allocation" {
    for ([_]?u8{ null, 1, 3 }) |reuse_id| {
        for ([_]bool{ false, true }) |owned| {
            var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
            var registry = MemRegistry.init(failing.allocator());
            defer registry.deinit();
            const kept = try failing.allocator().dupe(u8, "kept");
            _ = try registry.register(kept, true);
            for (0..3) |_| _ = try registry.register("unused", false);
            if (reuse_id) |id| {
                try registry.unregister(2);
                try registry.unregister(id);
            }
            const old_count = registry.buffers.items.len;
            const old_free_count = registry.free_slots.items.len;
            var old_free: [2]u8 = undefined;
            @memcpy(old_free[0..old_free_count], registry.free_slots.items);
            const text = if (owned) try failing.allocator().dupe(u8, "provisional") else "provisional";
            const id = try registry.register(text, owned);
            const old_freed_bytes = failing.freed_bytes;
            failing.fail_index = failing.alloc_index;
            failing.resize_fail_index = failing.resize_index;

            registry.cancelLastRegistration(id, old_count);

            try std.testing.expect(!failing.has_induced_failure);
            try std.testing.expectEqual(failing.fail_index, failing.alloc_index);
            try std.testing.expectEqual(failing.resize_fail_index, failing.resize_index);
            try std.testing.expectEqual(old_freed_bytes + @as(usize, if (owned) text.len else 0), failing.freed_bytes);
            try std.testing.expectEqual(old_count, registry.buffers.items.len);
            try std.testing.expectEqualSlices(u8, old_free[0..old_free_count], registry.free_slots.items);
            try std.testing.expect(registry.get(id) == null);
            try std.testing.expectEqualStrings("kept", registry.get(0).?);
            try std.testing.expectEqual(id, try registry.register("retry", false));
            try std.testing.expect(!failing.has_induced_failure);
        }
    }
}

test "MemRegistry - max capacity 255 with slot reuse" {
    var registry = MemRegistry.init(std.testing.allocator);
    defer registry.deinit();

    // Fill all 255 slots
    // NOTE: This test ensures the registry respects the u8 ID limit (max 255 slots).
    // If the ID type is changed from u8 to u16, this test would fail because:
    // 1. The test fills exactly 255 slots
    // 2. It expects OutOfMemory error on the 256th registration
    // 3. With u16, the limit would be 65535, so no error would occur
    var i: usize = 0;
    var ids: [255]u8 = undefined;
    while (i < 255) : (i += 1) {
        const text = "test";
        ids[i] = try registry.register(text, false);
    }

    try std.testing.expectEqual(@as(usize, 255), registry.getUsedSlots());
    try std.testing.expectEqual(@as(usize, 0), registry.getFreeSlots());

    // Should fail to register one more
    const text = "overflow";
    const result = registry.register(text, false);
    try std.testing.expectError(MemRegistryError.OutOfMemory, result);

    // Unregister one slot
    try registry.unregister(ids[100]);
    try std.testing.expectEqual(@as(usize, 254), registry.getUsedSlots());
    try std.testing.expectEqual(@as(usize, 1), registry.getFreeSlots());

    // Now we should be able to register again
    const new_text = "reused";
    const new_id = try registry.register(new_text, false);
    try std.testing.expectEqual(@as(u8, 100), new_id); // Should reuse slot 100
    try std.testing.expectEqualStrings("reused", registry.get(new_id).?);
}

test "MemRegistry matches a reference model under seeded random operations" {
    const capacity = 255;
    const Slot = struct { data: []const u8 = &.{}, active: bool = false };
    const Model = struct {
        slots: [capacity]Slot = @splat(.{}),
        len: usize = 0,
        free: [capacity]u8 = undefined,
        free_count: usize = 0,

        fn data(random: std.Random, owned: bool) ![]const u8 {
            const text: []const u8 = ([_][]const u8{ "", "a", "owned bytes", utils.repeat(u8, "x", 64) })[random.uintLessThan(usize, 4)];
            return if (owned) try std.testing.allocator.dupe(u8, text) else text;
        }

        fn active(self: *const @This(), id: u8) bool {
            return id < self.len and self.slots[id].active;
        }
    };
    for (0..8) |seed| {
        var registry = MemRegistry.init(std.testing.allocator);
        defer registry.deinit();
        var model: Model = .{};
        var prng = std.Random.DefaultPrng.init(seed);
        const random = prng.random();
        for (0..2000) |step| {
            errdefer std.debug.print("MemRegistry model failed: seed {d}, step {d}\n", .{ seed, step });
            const id = random.uintLessThan(u8, 8) +% if (model.len == 0) 0 else random.uintLessThan(u8, @intCast(model.len));
            const owned = random.boolean();
            switch (random.uintLessThan(u8, 16)) {
                // Registrations outnumber removals so the walk reaches the 255-slot limit.
                0...7 => {
                    const text = try Model.data(random, owned);
                    const result = registry.register(text, owned);
                    if (model.free_count == 0 and model.len == capacity) {
                        try std.testing.expectError(MemRegistryError.OutOfMemory, result);
                        if (owned) std.testing.allocator.free(text);
                        continue;
                    }
                    const expected: u8 = if (model.free_count > 0) model.free[model.free_count - 1] else @intCast(model.len);
                    try std.testing.expectEqual(expected, try result);
                    if (model.free_count > 0) model.free_count -= 1 else model.len += 1;
                    model.slots[expected] = .{ .data = text, .active = true };
                },
                8...10 => {
                    const text = try Model.data(random, owned);
                    if (model.active(id)) {
                        try registry.replace(id, text, owned);
                        model.slots[id].data = text;
                    } else {
                        try std.testing.expectError(MemRegistryError.InvalidMemId, registry.replace(id, text, owned));
                        if (owned) std.testing.allocator.free(text);
                    }
                },
                11...13 => if (model.active(id)) {
                    try registry.unregister(id);
                    model.slots[id] = .{};
                    model.free[model.free_count] = id;
                    model.free_count += 1;
                } else {
                    try std.testing.expectError(MemRegistryError.InvalidMemId, registry.unregister(id));
                },
                else => if (random.uintLessThan(u8, 64) == 0) {
                    registry.clear();
                    model = .{};
                },
            }
            var used: usize = 0;
            for (0..capacity) |index| {
                const slot_id: u8 = @intCast(index);
                if (model.active(slot_id)) {
                    used += 1;
                    try std.testing.expectEqual(model.slots[index].data.ptr, registry.get(slot_id).?.ptr);
                } else {
                    try std.testing.expect(registry.get(slot_id) == null);
                }
            }
            try std.testing.expectEqual(used, registry.getUsedSlots());
            try std.testing.expectEqual(capacity - model.len + model.free_count, registry.getFreeSlots());
        }
    }
}
