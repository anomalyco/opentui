const std = @import("std");
const mem_registry = @import("../mem-registry.zig");

const MemRegistry = mem_registry.MemRegistry;
const MemRegistryError = mem_registry.MemRegistryError;

test "MemRegistry - init and deinit" {
    var registry = MemRegistry.init(std.testing.allocator);
    defer registry.deinit();

    try std.testing.expectEqual(@as(usize, 0), registry.getUsedSlots());
    try std.testing.expectEqual(@as(usize, 255), registry.getFreeSlots());
}

test "MemRegistry - register owned memory" {
    var registry = MemRegistry.init(std.testing.allocator);
    defer registry.deinit();

    const text = try std.testing.allocator.dupe(u8, "Hello, World!");
    const id = try registry.register(text, true);

    try std.testing.expectEqual(@as(u8, 0), id);
    try std.testing.expectEqual(@as(usize, 1), registry.getUsedSlots());
    try std.testing.expectEqual(@as(usize, 254), registry.getFreeSlots());

    const retrieved = registry.get(id);
    try std.testing.expect(retrieved != null);
    try std.testing.expectEqualStrings("Hello, World!", retrieved.?);
}

test "MemRegistry - register non-owned memory" {
    var registry = MemRegistry.init(std.testing.allocator);
    defer registry.deinit();

    const text = "Hello, World!";
    const id = try registry.register(text, false);

    try std.testing.expectEqual(@as(u8, 0), id);
    try std.testing.expectEqual(@as(usize, 1), registry.getUsedSlots());

    const retrieved = registry.get(id);
    try std.testing.expect(retrieved != null);
    try std.testing.expectEqualStrings("Hello, World!", retrieved.?);
}

test "MemRegistry - register multiple buffers" {
    var registry = MemRegistry.init(std.testing.allocator);
    defer registry.deinit();

    const text1 = "First";
    const text2 = "Second";
    const text3 = "Third";

    const id1 = try registry.register(text1, false);
    const id2 = try registry.register(text2, false);
    const id3 = try registry.register(text3, false);

    try std.testing.expectEqual(@as(u8, 0), id1);
    try std.testing.expectEqual(@as(u8, 1), id2);
    try std.testing.expectEqual(@as(u8, 2), id3);
    try std.testing.expectEqual(@as(usize, 3), registry.getUsedSlots());
    try std.testing.expectEqual(@as(usize, 252), registry.getFreeSlots());

    try std.testing.expectEqualStrings("First", registry.get(id1).?);
    try std.testing.expectEqualStrings("Second", registry.get(id2).?);
    try std.testing.expectEqualStrings("Third", registry.get(id3).?);
}

test "MemRegistry - get invalid ID returns null" {
    var registry = MemRegistry.init(std.testing.allocator);
    defer registry.deinit();

    const text = "Test";
    _ = try registry.register(text, false);

    try std.testing.expect(registry.get(1) == null);
    try std.testing.expect(registry.get(5) == null);
    try std.testing.expect(registry.get(255) == null);
}

test "MemRegistry - replace owned buffer" {
    var registry = MemRegistry.init(std.testing.allocator);
    defer registry.deinit();

    const text1 = try std.testing.allocator.dupe(u8, "Original");
    const id = try registry.register(text1, true);

    const text2 = try std.testing.allocator.dupe(u8, "Replaced");
    try registry.replace(id, text2, true);

    const retrieved = registry.get(id);
    try std.testing.expect(retrieved != null);
    try std.testing.expectEqualStrings("Replaced", retrieved.?);
    try std.testing.expectEqual(@as(usize, 1), registry.getUsedSlots());
}

test "MemRegistry - replace non-owned buffer with owned" {
    var registry = MemRegistry.init(std.testing.allocator);
    defer registry.deinit();

    const text1 = "Original";
    const id = try registry.register(text1, false);

    const text2 = try std.testing.allocator.dupe(u8, "Replaced");
    try registry.replace(id, text2, true);

    const retrieved = registry.get(id);
    try std.testing.expect(retrieved != null);
    try std.testing.expectEqualStrings("Replaced", retrieved.?);
}

test "MemRegistry - replace with invalid ID" {
    var registry = MemRegistry.init(std.testing.allocator);
    defer registry.deinit();

    const text = "Test";
    const result = registry.replace(5, text, false);
    try std.testing.expectError(MemRegistryError.InvalidMemId, result);
}

test "MemRegistry - clear owned buffers" {
    var registry = MemRegistry.init(std.testing.allocator);
    defer registry.deinit();

    const text1 = try std.testing.allocator.dupe(u8, "First");
    const text2 = try std.testing.allocator.dupe(u8, "Second");
    _ = try registry.register(text1, true);
    _ = try registry.register(text2, true);

    try std.testing.expectEqual(@as(usize, 2), registry.getUsedSlots());

    registry.clear();

    try std.testing.expectEqual(@as(usize, 0), registry.getUsedSlots());
    try std.testing.expectEqual(@as(usize, 255), registry.getFreeSlots());
}

test "MemRegistry - clear non-owned buffers" {
    var registry = MemRegistry.init(std.testing.allocator);
    defer registry.deinit();

    const text1 = "First";
    const text2 = "Second";
    _ = try registry.register(text1, false);
    _ = try registry.register(text2, false);

    try std.testing.expectEqual(@as(usize, 2), registry.getUsedSlots());

    registry.clear();

    try std.testing.expectEqual(@as(usize, 0), registry.getUsedSlots());
}

test "MemRegistry - max capacity" {
    var registry = MemRegistry.init(std.testing.allocator);
    defer registry.deinit();

    var i: usize = 0;
    while (i < 255) : (i += 1) {
        const text = "test";
        _ = try registry.register(text, false);
    }

    try std.testing.expectEqual(@as(usize, 255), registry.getUsedSlots());
    try std.testing.expectEqual(@as(usize, 0), registry.getFreeSlots());

    const text = "overflow";
    const result = registry.register(text, false);
    try std.testing.expectError(MemRegistryError.OutOfMemory, result);
}

test "MemRegistry - clear and reuse" {
    var registry = MemRegistry.init(std.testing.allocator);
    defer registry.deinit();

    const text1 = "First";
    const id1 = try registry.register(text1, false);
    try std.testing.expectEqual(@as(u8, 0), id1);

    registry.clear();

    const text2 = "Second";
    const id2 = try registry.register(text2, false);
    try std.testing.expectEqual(@as(u8, 0), id2);
    try std.testing.expectEqualStrings("Second", registry.get(id2).?);
}

test "MemRegistry - mixed owned and non-owned buffers" {
    var registry = MemRegistry.init(std.testing.allocator);
    defer registry.deinit();

    const owned = try std.testing.allocator.dupe(u8, "Owned");
    const non_owned = "Not Owned";

    const id1 = try registry.register(owned, true);
    const id2 = try registry.register(non_owned, false);

    try std.testing.expectEqual(@as(usize, 2), registry.getUsedSlots());

    try std.testing.expectEqualStrings("Owned", registry.get(id1).?);
    try std.testing.expectEqualStrings("Not Owned", registry.get(id2).?);

    registry.clear();
    try std.testing.expectEqual(@as(usize, 0), registry.getUsedSlots());
}

test "MemRegistry - large buffer registration" {
    var registry = MemRegistry.init(std.testing.allocator);
    defer registry.deinit();

    const large_text = [_]u8{'A'} ** 10000;
    const id = try registry.register(&large_text, false);

    const retrieved = registry.get(id);
    try std.testing.expect(retrieved != null);
    try std.testing.expectEqual(@as(usize, 10000), retrieved.?.len);
}

test "MemRegistry - empty buffer registration" {
    var registry = MemRegistry.init(std.testing.allocator);
    defer registry.deinit();

    const empty = "";
    const id = try registry.register(empty, false);

    const retrieved = registry.get(id);
    try std.testing.expect(retrieved != null);
    try std.testing.expectEqual(@as(usize, 0), retrieved.?.len);
}

test "MemRegistry - sequential replace operations" {
    var registry = MemRegistry.init(std.testing.allocator);
    defer registry.deinit();

    const text1 = "First";
    const id = try registry.register(text1, false);

    const text2 = "Second";
    try registry.replace(id, text2, false);
    try std.testing.expectEqualStrings("Second", registry.get(id).?);

    const text3 = "Third";
    try registry.replace(id, text3, false);
    try std.testing.expectEqualStrings("Third", registry.get(id).?);

    try std.testing.expectEqual(@as(usize, 1), registry.getUsedSlots());
}

test "MemRegistry - replace owned with non-owned" {
    var registry = MemRegistry.init(std.testing.allocator);
    defer registry.deinit();

    const text1 = try std.testing.allocator.dupe(u8, "Owned");
    const id = try registry.register(text1, true);

    const text2 = "Not Owned";
    try registry.replace(id, text2, false);

    const retrieved = registry.get(id);
    try std.testing.expect(retrieved != null);
    try std.testing.expectEqualStrings("Not Owned", retrieved.?);
    try std.testing.expectEqual(@as(usize, 1), registry.getUsedSlots());
}

test "MemRegistry - stress test with many registrations and clears" {
    var registry = MemRegistry.init(std.testing.allocator);
    defer registry.deinit();

    var round: usize = 0;
    while (round < 10) : (round += 1) {
        var i: usize = 0;
        while (i < 50) : (i += 1) {
            const text = "test";
            _ = try registry.register(text, false);
        }
        try std.testing.expectEqual(@as(usize, 50), registry.getUsedSlots());
        registry.clear();
        try std.testing.expectEqual(@as(usize, 0), registry.getUsedSlots());
    }
}

test "MemRegistry - unregister basic" {
    var registry = MemRegistry.init(std.testing.allocator);
    defer registry.deinit();

    const text = "Hello";
    const id = try registry.register(text, false);

    try std.testing.expectEqual(@as(usize, 1), registry.getUsedSlots());
    try std.testing.expectEqualStrings("Hello", registry.get(id).?);

    try registry.unregister(id);

    try std.testing.expectEqual(@as(usize, 0), registry.getUsedSlots());
    try std.testing.expect(registry.get(id) == null);
}

test "MemRegistry - unregister owned buffer frees memory" {
    var registry = MemRegistry.init(std.testing.allocator);
    defer registry.deinit();

    const text = try std.testing.allocator.dupe(u8, "Owned Buffer");
    const id = try registry.register(text, true);

    try std.testing.expectEqual(@as(usize, 1), registry.getUsedSlots());

    // Should free the memory when unregistered
    try registry.unregister(id);

    try std.testing.expectEqual(@as(usize, 0), registry.getUsedSlots());
    try std.testing.expect(registry.get(id) == null);
}

test "MemRegistry - unregister invalid ID" {
    var registry = MemRegistry.init(std.testing.allocator);
    defer registry.deinit();

    const result = registry.unregister(5);
    try std.testing.expectError(MemRegistryError.InvalidMemId, result);
}

test "MemRegistry - unregister twice fails" {
    var registry = MemRegistry.init(std.testing.allocator);
    defer registry.deinit();

    const text = "Test";
    const id = try registry.register(text, false);

    try registry.unregister(id);

    // Second unregister should fail
    const result = registry.unregister(id);
    try std.testing.expectError(MemRegistryError.InvalidMemId, result);
}

test "MemRegistry - slot reuse after unregister" {
    var registry = MemRegistry.init(std.testing.allocator);
    defer registry.deinit();

    const text1 = "First";
    const text2 = "Second";
    const text3 = "Third";

    const id1 = try registry.register(text1, false);
    const id2 = try registry.register(text2, false);
    const id3 = try registry.register(text3, false);

    try std.testing.expectEqual(@as(u8, 0), id1);
    try std.testing.expectEqual(@as(u8, 1), id2);
    try std.testing.expectEqual(@as(u8, 2), id3);
    try std.testing.expectEqual(@as(usize, 3), registry.getUsedSlots());

    // Unregister middle slot
    try registry.unregister(id2);
    try std.testing.expectEqual(@as(usize, 2), registry.getUsedSlots());

    // Register new buffer - should reuse slot 1
    const text4 = "Fourth";
    const id4 = try registry.register(text4, false);
    try std.testing.expectEqual(@as(u8, 1), id4);
    try std.testing.expectEqual(@as(usize, 3), registry.getUsedSlots());

    // Verify contents
    try std.testing.expectEqualStrings("First", registry.get(id1).?);
    try std.testing.expectEqualStrings("Fourth", registry.get(id4).?);
    try std.testing.expectEqualStrings("Third", registry.get(id3).?);
}

test "MemRegistry - thousands of register/unregister cycles" {
    var registry = MemRegistry.init(std.testing.allocator);
    defer registry.deinit();

    // Simulate thousands of register/unregister operations
    // This ensures slot reuse works over long periods
    var cycle: usize = 0;
    while (cycle < 1000) : (cycle += 1) {
        var ids: [10]u8 = undefined;

        // Register 10 buffers
        var i: usize = 0;
        while (i < 10) : (i += 1) {
            const text = "test";
            ids[i] = try registry.register(text, false);
        }

        try std.testing.expectEqual(@as(usize, 10), registry.getUsedSlots());

        // Unregister all
        i = 0;
        while (i < 10) : (i += 1) {
            try registry.unregister(ids[i]);
        }

        try std.testing.expectEqual(@as(usize, 0), registry.getUsedSlots());
    }

    // Verify we can still register after all those cycles
    const text = "final";
    const id = try registry.register(text, false);
    try std.testing.expectEqualStrings("final", registry.get(id).?);
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

test "MemRegistry - replace inactive slot fails" {
    var registry = MemRegistry.init(std.testing.allocator);
    defer registry.deinit();

    const text1 = "Original";
    const id = try registry.register(text1, false);

    try registry.unregister(id);

    // Try to replace inactive slot
    const text2 = "Replacement";
    const result = registry.replace(id, text2, false);
    try std.testing.expectError(MemRegistryError.InvalidMemId, result);
}

test "MemRegistry - getFreeSlots accounts for unregistered slots" {
    var registry = MemRegistry.init(std.testing.allocator);
    defer registry.deinit();

    try std.testing.expectEqual(@as(usize, 255), registry.getFreeSlots());

    const id1 = try registry.register("test1", false);
    const id2 = try registry.register("test2", false);
    const id3 = try registry.register("test3", false);

    try std.testing.expectEqual(@as(usize, 252), registry.getFreeSlots());

    try registry.unregister(id2);
    try std.testing.expectEqual(@as(usize, 253), registry.getFreeSlots());

    try registry.unregister(id1);
    try registry.unregister(id3);
    try std.testing.expectEqual(@as(usize, 255), registry.getFreeSlots());
}
