const std = @import("std");
const handles = @import("../handles.zig");
const CompatibilityOwner = @import("../compatibility-context.zig").CompatibilityOwner;

test "handles insert and acquire" {
    const registry = try std.testing.allocator.create(handles.Registry);
    defer std.testing.allocator.destroy(registry);
    registry.init();
    var value: u32 = 42;
    const handle = try registry.insert(.renderer, &value);
    try std.testing.expectEqual(@as(u32, 0x0001_0001), handle);

    const acquired = registry.acquire(handle, .renderer, u32) orelse return error.TestUnexpectedResult;
    try std.testing.expectEqual(@as(*u32, &value), acquired);

    const token = registry.beginDestroy(handle, .renderer, u32) orelse return error.TestUnexpectedResult;
    registry.finishDestroy(token.handle);
}

test "handles reject wrong kind and zero" {
    const registry = try std.testing.allocator.create(handles.Registry);
    defer std.testing.allocator.destroy(registry);
    registry.init();
    var value: u32 = 42;
    const handle = try registry.insert(.renderer, &value);

    try std.testing.expect(registry.acquire(handle, .optimized_buffer, u32) == null);
    try std.testing.expect(registry.acquire(0, .renderer, u32) == null);

    const token = registry.beginDestroy(handle, .renderer, u32) orelse return error.TestUnexpectedResult;
    registry.finishDestroy(token.handle);
}

test "handles double destroy is rejected" {
    const registry = try std.testing.allocator.create(handles.Registry);
    defer std.testing.allocator.destroy(registry);
    registry.init();
    var value: u32 = 42;
    const handle = try registry.insert(.renderer, &value);

    const token = registry.beginDestroy(handle, .renderer, u32) orelse return error.TestUnexpectedResult;
    registry.finishDestroy(token.handle);

    try std.testing.expect(registry.beginDestroy(handle, .renderer, u32) == null);
}

test "handles reject stale generation after reuse" {
    const registry = try std.testing.allocator.create(handles.Registry);
    defer std.testing.allocator.destroy(registry);
    registry.init();
    var first: u32 = 1;
    var second: u32 = 2;

    const stale = try registry.insert(.renderer, &first);
    const token = registry.beginDestroy(stale, .renderer, u32) orelse return error.TestUnexpectedResult;
    registry.finishDestroy(token.handle);

    const fresh = try registry.insert(.renderer, &second);
    try std.testing.expect(stale != fresh);
    try std.testing.expect(registry.acquire(stale, .renderer, u32) == null);
    try std.testing.expectEqual(@as(*u32, &second), registry.acquire(fresh, .renderer, u32).?);

    const fresh_token = registry.beginDestroy(fresh, .renderer, u32) orelse return error.TestUnexpectedResult;
    registry.finishDestroy(fresh_token.handle);
}

test "handles reject stale generation after wrap" {
    const registry = try std.testing.allocator.create(handles.Registry);
    defer std.testing.allocator.destroy(registry);
    registry.init();
    var value: u32 = 42;
    const stale = try registry.insert(.renderer, &value);
    var current = stale;

    var i: usize = 0;
    while (i < 4095) : (i += 1) {
        const token = registry.beginDestroy(current, .renderer, u32) orelse return error.TestUnexpectedResult;
        registry.finishDestroy(token.handle);
        current = try registry.insert(.renderer, &value);
    }

    try std.testing.expect(registry.acquire(stale, .renderer, u32) == null);
    try std.testing.expectEqual(@as(u32, 0x0001_0002), current);

    const token = registry.beginDestroy(current, .renderer, u32) orelse return error.TestUnexpectedResult;
    registry.finishDestroy(token.handle);
}

test "handles mark destroying before destructor body" {
    const registry = try std.testing.allocator.create(handles.Registry);
    defer std.testing.allocator.destroy(registry);
    registry.init();
    var value: u32 = 42;
    const handle = try registry.insert(.renderer, &value);

    const token = registry.beginDestroy(handle, .renderer, u32) orelse return error.TestUnexpectedResult;
    try std.testing.expect(registry.acquire(handle, .renderer, u32) == null);
    try std.testing.expect(registry.beginDestroy(handle, .renderer, u32) == null);
    registry.finishDestroy(token.handle);
    try std.testing.expect(registry.isEmpty());
}

test "handles children can be invalidated after owner destroy begins" {
    const registry = try std.testing.allocator.create(handles.Registry);
    defer std.testing.allocator.destroy(registry);
    registry.init();
    var owner_value: u32 = 1;
    var child_value: u32 = 2;
    const owner = try registry.insert(.renderer, &owner_value);
    const child = try registry.insertOwnedChild(.optimized_buffer, &child_value, owner);

    const token = registry.beginDestroy(owner, .renderer, u32) orelse return error.TestUnexpectedResult;
    registry.invalidateChildren(token.handle);

    try std.testing.expect(!registry.isValid(child, .optimized_buffer));

    registry.finishDestroy(token.handle);
}

test "handles registries have independent slots and generations" {
    const first = try std.testing.allocator.create(handles.Registry);
    defer std.testing.allocator.destroy(first);
    first.init();
    const second = try std.testing.allocator.create(handles.Registry);
    defer std.testing.allocator.destroy(second);
    second.init();
    var first_value: u32 = 1;
    var second_value: u32 = 2;
    const first_handle = try first.insert(.embedded_terminal, &first_value);
    const second_handle = try second.insert(.embedded_terminal, &second_value);
    try std.testing.expectEqual(@as(u32, 0xd001_0001), first_handle);
    try std.testing.expectEqual(first_handle, second_handle);
    try std.testing.expectEqual(&first_value, first.acquire(first_handle, .embedded_terminal, u32).?);
    try std.testing.expectEqual(&second_value, second.acquire(second_handle, .embedded_terminal, u32).?);

    first.invalidate(first_handle, .embedded_terminal);
    try std.testing.expect(first.isEmpty());
    try std.testing.expect(second.isValid(second_handle, .embedded_terminal));
    const replacement = try first.insert(.embedded_terminal, &first_value);
    try std.testing.expectEqual(@as(u32, 0xd002_0001), replacement);
    first.invalidate(replacement, .embedded_terminal);
    second.invalidate(second_handle, .embedded_terminal);
}

test "handles validate parents before linking and clean up destroying descendants" {
    const registry = try std.testing.allocator.create(handles.Registry);
    defer std.testing.allocator.destroy(registry);
    registry.init();
    var value: u32 = 1;
    const owner = try registry.insert(.renderer, &value);
    for ([_]handles.Handle{ 1, owner ^ 0x1000_0000, owner ^ 0x0001_0000, 0xffff_ffff }) |invalid| {
        try std.testing.expectError(error.InvalidOwner, registry.insertOwnedChild(.optimized_buffer, &value, invalid));
    }
    const child = try registry.insertOwnedChild(.optimized_buffer, &value, owner);
    try std.testing.expectEqual(@as(u32, 0x1001_0002), child);
    const grandchild = try registry.insertOwnedChild(.text_buffer, &value, child);
    const token = registry.beginDestroy(owner, .renderer, u32).?;
    try std.testing.expect(!registry.isEmpty());
    try std.testing.expectEqual(&value, registry.acquire(child, .optimized_buffer, u32).?);
    try std.testing.expectError(error.InvalidOwner, registry.insertOwnedChild(.optimized_buffer, &value, owner));
    const child_token = registry.beginDestroy(child, .optimized_buffer, u32).?;

    registry.finishDestroy(token.handle);
    try std.testing.expect(registry.isEmpty());
    try std.testing.expect(!registry.isValid(child, .optimized_buffer));
    try std.testing.expect(!registry.isValid(grandchild, .text_buffer));
    const replacement = try registry.insert(.renderer, &value);
    const replacement_child = try registry.insertOwnedChild(.optimized_buffer, &value, replacement);
    const replacement_grandchild = try registry.insertOwnedChild(.text_buffer, &value, replacement_child);
    try std.testing.expectEqual(grandchild & 0xffff, replacement_grandchild & 0xffff);
    _ = registry.beginDestroy(replacement_child, .optimized_buffer, u32).?;
    try std.testing.expectError(error.InvalidOwner, registry.insertOwnedChild(.optimized_buffer, &value, owner));
    registry.finishDestroy(token.handle);
    registry.finishDestroy(child_token.handle);
    registry.invalidateChildren(owner);
    try std.testing.expect(registry.isValid(replacement, .renderer));
    try std.testing.expectEqual(&value, registry.acquire(replacement_grandchild, .text_buffer, u32).?);
    registry.invalidateChildren(replacement_child);
    try std.testing.expect(!registry.isValid(replacement_grandchild, .text_buffer));
    registry.invalidate(replacement, .renderer);
    try std.testing.expect(registry.isEmpty());
}

test "handles unlink children before reusing their slots" {
    const registry = try std.testing.allocator.create(handles.Registry);
    defer std.testing.allocator.destroy(registry);
    registry.init();
    var value: u32 = 1;
    const owner = try registry.insert(.renderer, &value);
    const other = try registry.insert(.renderer, &value);
    const first = try registry.insertOwnedChild(.optimized_buffer, &value, owner);
    const middle = try registry.insertOwnedChild(.optimized_buffer, &value, owner);
    const last = try registry.insertOwnedChild(.optimized_buffer, &value, owner);
    registry.finishDestroy(registry.beginDestroy(middle, .optimized_buffer, u32).?.handle);
    const replacement = try registry.insertOwnedChild(.optimized_buffer, &value, other);
    try std.testing.expectEqual(middle & 0xffff, replacement & 0xffff);
    registry.invalidateChildren(owner);
    try std.testing.expect(!registry.isValid(first, .optimized_buffer));
    try std.testing.expect(!registry.isValid(last, .optimized_buffer));
    try std.testing.expect(!registry.isValid(middle, .optimized_buffer));
    try std.testing.expectEqual(&value, registry.acquire(replacement, .optimized_buffer, u32).?);
    registry.invalidate(owner, .renderer);
    registry.invalidate(other, .renderer);
    try std.testing.expect(!registry.isValid(replacement, .optimized_buffer));
    try std.testing.expect(registry.isEmpty());
}

test "handles invalidate 10000 resource identities iteratively and safely reuse slots" {
    const registry = try std.testing.allocator.create(handles.Registry);
    defer std.testing.allocator.destroy(registry);
    registry.init();
    var value: u32 = 1;
    const unrelated = try registry.insert(.renderer, &value);
    const unrelated_child = try registry.insertOwnedChild(.optimized_buffer, &value, unrelated);
    var chain: [10_000]handles.Handle = undefined;
    chain[0] = try registry.insert(.renderer, &value);
    for (chain[1..], 1..) |*child, index| {
        child.* = try registry.insertOwnedChild(.renderer, &value, chain[index - 1]);
    }
    registry.invalidateChildren(chain[0]);
    try std.testing.expect(registry.isValid(chain[0], .renderer));
    try std.testing.expect(registry.isValid(unrelated, .renderer));
    try std.testing.expect(registry.isValid(unrelated_child, .optimized_buffer));
    for (chain[1..]) |stale| try std.testing.expect(!registry.isValid(stale, .renderer));

    // Reuse every vacated slot in a wide tree, then invalidate the parent itself.
    for (chain[1..]) |*child| {
        const stale = child.*;
        child.* = try registry.insertOwnedChild(.renderer, &value, chain[0]);
        registry.finishDestroy(stale);
        registry.invalidateChildren(stale);
        try std.testing.expect(registry.isValid(child.*, .renderer));
    }
    registry.finishDestroy(registry.beginDestroy(chain[0], .renderer, u32).?.handle);
    for (chain) |stale| try std.testing.expect(!registry.isValid(stale, .renderer));
    try std.testing.expect(registry.isValid(unrelated, .renderer));
    try std.testing.expect(registry.isValid(unrelated_child, .optimized_buffer));
    registry.invalidate(unrelated, .renderer);
    try std.testing.expect(registry.isEmpty());
}

test "handles preserve capacity and recover after exhaustion" {
    const registry = try std.testing.allocator.create(handles.Registry);
    defer std.testing.allocator.destroy(registry);
    registry.init();
    var value: u32 = 1;
    var last: handles.Handle = 0;
    for (0..65_535) |_| last = try registry.insert(.renderer, &value);
    try std.testing.expectEqual(@as(u32, 0x0001_ffff), last);
    try std.testing.expectError(error.OutOfHandles, registry.insert(.renderer, &value));
    registry.invalidate(last, .renderer);
    const replacement = try registry.insert(.renderer, &value);
    try std.testing.expectEqual(@as(u32, 0x0002_ffff), replacement);
    registry.invalidateChildren(0);
    try std.testing.expect(registry.isEmpty());
}

test "handles compatibility owners release pools arena and allocator after resources" {
    const first = try std.testing.allocator.create(CompatibilityOwner);
    defer std.testing.allocator.destroy(first);
    first.init();
    const second = try std.testing.allocator.create(CompatibilityOwner);
    defer std.testing.allocator.destroy(second);
    second.init();

    const value = try first.gpa.allocator().create(u32);
    value.* = 42;
    const handle = try first.registry.insert(.renderer, value);
    try std.testing.expectError(error.LiveHandles, first.deinit());
    const token = first.registry.beginDestroy(handle, .renderer, u32).?;
    try std.testing.expectError(error.LiveHandles, first.deinit());
    const first_pool = first.initLinkPool(first.arena.allocator());
    const second_pool = second.initLinkPool(second.arena.allocator());
    const first_id = try first_pool.alloc("first");
    const second_id = try second_pool.alloc("other");
    try first_pool.incref(first_id);
    try second_pool.incref(second_id);
    try std.testing.expectEqual(first_id, second_id);
    try std.testing.expectEqualStrings("first", try first_pool.get(first_id));
    try std.testing.expectEqualStrings("other", try second_pool.get(second_id));
    const graphemes = first.initGraphemePool(first.arena.allocator(), .{});
    const grapheme_id = try graphemes.alloc("grapheme");
    try graphemes.incref(grapheme_id);
    try std.testing.expect(first.arena.queryCapacity() > 0);
    first.gpa.allocator().destroy(token.ptr);
    first.registry.finishDestroy(token.handle);
    try std.testing.expectEqual(std.heap.Check.ok, try first.deinit());
    try std.testing.expectEqualStrings("other", try second_pool.get(second_id));
    try std.testing.expectEqual(std.heap.Check.ok, try second.deinit());
}
