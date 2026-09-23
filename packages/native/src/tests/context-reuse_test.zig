const std = @import("std");
const testing = std.testing;
const context = @import("../context.zig");
const yoga = @import("../yoga.zig");
const scene = @import("../scene.zig");
const native = @import("../native-renderable.zig");

fn session(owner: *context.Context) !context.Handle {
    const result = try owner.createSession(.{ .chunk_size = 4096, .chunk_count = 2, .span_capacity = 2 });
    try owner.attachSessionRenderer(result, 16, 4, .{ .remote_mode = .remote });
    _ = try owner.sceneCreateNode(result, 0, 1);
    return result;
}

test "Context reuse failed idle entry growth preserves storage and allocation-free retirement" {
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    const owner = try context.Context.init(failing.allocator(), testing.io, .{});
    defer owner.deinit() catch unreachable;
    const id = try session(owner);
    var last = try owner.sceneCreateNode(id, 1, 2);
    while (owner.objects.live_count < owner.node_pool.len) {
        last = try owner.sceneCreateNode(id, 1, owner.objects.live_count + 1);
    }
    const shell = try owner.raw().getRenderable(last);
    const entries = owner.node_pool;
    const count = owner.objects.live_count;
    failing.fail_index = failing.alloc_index;
    failing.resize_fail_index = failing.resize_index;
    try testing.expectError(error.OutOfMemory, owner.sceneCreateNode(id, 1, count + 1));
    try testing.expect(failing.has_induced_failure);
    try testing.expectEqual(entries.ptr, owner.node_pool.ptr);
    try testing.expectEqual(entries.len, owner.node_pool.len);
    try testing.expectEqual(count, owner.objects.live_count);
    try testing.expectEqual(@as(u32, 0), owner.node_pool_count);
    failing.has_induced_failure = false;
    try owner.sceneDestroyNode(last);
    const fresh = try owner.sceneCreateNode(id, 1, count + 1);
    try testing.expectEqual(shell, try owner.raw().getRenderable(fresh));
    try testing.expectError(error.StaleHandle, owner.raw().getRenderable(last));
    try testing.expect(!failing.has_induced_failure);
}

test "Context reuse bounds idle shell counts and discards oversized storage" {
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    const owner = try context.Context.init(failing.allocator(), testing.io, .{});
    defer owner.deinit() catch unreachable;
    const id = try session(owner);
    var nodes: [context.Context.node_pool_count_max + 1]context.Handle = undefined;
    for (&nodes, 0..) |*handle, index| handle.* = try owner.sceneCreateNode(id, 1, @intCast(index + 2));
    try testing.expectEqual(@as(usize, context.Context.node_pool_count_max), owner.node_pool.len);
    failing.fail_index = failing.alloc_index;
    failing.resize_fail_index = failing.resize_index;
    for (nodes) |handle| try owner.sceneDestroyNode(handle);
    try testing.expect(!failing.has_induced_failure);
    failing.fail_index = std.math.maxInt(usize);
    failing.resize_fail_index = std.math.maxInt(usize);
    try testing.expectEqual(@as(u32, context.Context.node_pool_count_max), owner.node_pool_count);
    var bytes: usize = 0;
    for (owner.node_pool[0..owner.node_pool_count]) |storage| {
        const retained = @sizeOf(native.NativeRenderable) + @sizeOf(scene.Node) +
            yoga.nodeStorageBytes(storage.node.yoga_node);
        try testing.expectEqual(retained, storage.retainedBytes());
        bytes += retained;
    }
    try testing.expectEqual(bytes, owner.node_pool_bytes);
    try testing.expect(bytes + owner.node_pool.len * @sizeOf(@TypeOf(owner.node_pool[0])) <= context.Context.node_pool_bytes_max);
    const large = try owner.sceneCreateNode(id, 1, 1000);
    const node = try owner.raw().getRenderable(large);
    try node.scene_node.?.children.ensureTotalCapacity(testing.allocator, context.Context.node_pool_bytes_max / @sizeOf(@TypeOf(node)));
    const before = owner.node_pool_count;
    try owner.sceneDestroyNode(large);
    try testing.expectEqual(before, owner.node_pool_count);

    var texts: [context.Context.text_pool_count_max + 1]context.Handle = undefined;
    for (&texts, 0..) |*handle, index| handle.* = try owner.sceneCreateNode(id, 2, @intCast(index + 2));
    for (texts) |handle| try owner.destroy(handle);
    try testing.expectEqual(@as(u32, context.Context.text_pool_count_max), owner.text_pool_count);
    try testing.expect(owner.text_pool_bytes <= context.Context.text_pool_bytes_max);
    const large_text = try owner.sceneCreateNode(id, 2, 2);
    _ = try (try owner.raw().getRenderable(large_text)).scene_node.?.text.?.view.measure_arena.allocator().alloc(u8, context.Context.text_storage_bytes_max);
    const before_texts = owner.text_pool_count;
    try owner.destroy(large_text);
    try testing.expectEqual(before_texts, owner.text_pool_count);
}

test "Context reuse releases borrowed measurements styles and links before pooling" {
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    const owner = try context.Context.init(failing.allocator(), testing.io, .{});
    defer owner.deinit() catch unreachable;
    const id = try session(owner);
    const text_handle = try owner.sceneCreateNode(id, 2, 2);
    const text = (try owner.raw().getRenderable(text_handle)).scene_node.?.text.?;
    try owner.sceneSetStyledText(text_handle, "link", &.{.{
        .byte_count = 4,
        .foreground = .{ 255, 255, 255, 255 },
        .background = .{ 0, 0, 0, 0 },
        .link_url = "https://example.test/retired",
    }});
    try testing.expectEqual(@as(u64, 1), owner.links.getLiveSlotCount());
    try owner.sceneDestroyNode(text_handle);
    try testing.expectEqual(@as(u64, 0), owner.links.getLiveSlotCount());
    const handle = try owner.sceneCreateNode(id, 2, 3);
    try testing.expectEqual(text, (try owner.raw().getRenderable(handle)).scene_node.?.text.?);
    const style_handle = try owner.createSyntaxStyle();
    const style = try owner.raw().getSyntaxStyle(style_handle);
    text.buffer.setSyntaxStyle(style);
    try testing.expectEqual(@as(usize, 1), style.emitter.listeners.get(.Destroy).?.items.len);
    const borrower = try owner.sceneCreateNode(id, 1, 4);
    try (try owner.raw().getRenderable(borrower)).setMeasureTarget(.{ .text_buffer_view = text.view });
    failing.fail_index = failing.alloc_index;
    failing.resize_fail_index = failing.resize_index;
    try owner.destroy(handle);
    try testing.expect(!failing.has_induced_failure);
    try testing.expect((try owner.raw().getRenderable(borrower)).measure_target == .none);
    try testing.expectEqual(@as(usize, 0), style.emitter.listeners.get(.Destroy).?.items.len);
    // Leave the borrower, borrowed style, and idle storage for Context teardown.
}

test "Context reuse poisoned Yoga nodes never enter the pool" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const id = try session(owner);
    const root = (try owner.raw().getSession(id)).scene.?.root.?.scene_node.?.handle;
    const child = try owner.sceneCreateNode(id, 1, 2);
    try owner.sceneMoveNode(child, root, 0);
    yoga.testFailAfter(0);
    defer yoga.testFailAfter(-1);
    try testing.expectError(error.OutOfMemory, owner.scenePaint(id, .{ 0, 0, 0, 255 }, false, 0));
    yoga.testFailAfter(-1);
    try owner.sceneDestroyNode(child);
    try owner.sceneDestroyNode(root);
    try testing.expectEqual(@as(u32, 0), owner.node_pool_count);
    try testing.expectEqual(@as(usize, 0), owner.node_pool_bytes);
}

test "Context reuse cold shell construction failures release partial ownership" {
    var failures: usize = 0;
    for (0..8) |offset| {
        var failing = testing.FailingAllocator.init(testing.allocator, .{});
        const owner = try context.Context.init(failing.allocator(), testing.io, .{});
        defer owner.deinit() catch unreachable;
        const id = try session(owner);
        const count = owner.objects.live_count;
        failing.fail_index = failing.alloc_index + offset;
        failing.resize_fail_index = failing.resize_index;
        const result = owner.sceneCreateNode(id, 1, 2);
        failing.fail_index = std.math.maxInt(usize);
        failing.resize_fail_index = std.math.maxInt(usize);
        if (result) |handle| {
            try owner.sceneDestroyNode(handle);
            break;
        } else |err| {
            try testing.expectEqual(error.OutOfMemory, err);
            failures += 1;
            try testing.expectEqual(count, owner.objects.live_count);
            try testing.expectEqual(@as(u32, 1), (try owner.raw().getSession(id)).scene.?.count);
            const recovered = try owner.sceneCreateNode(id, 1, 2);
            try owner.sceneDestroyNode(recovered);
        }
    }
    try testing.expect(failures > 0 and failures < 8);
}
