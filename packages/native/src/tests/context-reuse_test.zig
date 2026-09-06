const std = @import("std");
const testing = std.testing;
const context = @import("../context.zig");
const yoga = @import("../yoga.zig");
const yoga_c = @import("yoga");
const scene = @import("../scene.zig");

fn session(owner: *context.Context) !context.Handle {
    const result = try owner.createSession(.{ .chunk_size = 4096, .chunk_count = 2, .span_capacity = 2 });
    try owner.attachSessionRenderer(result, 16, 4, .{ .remote_mode = .remote });
    _ = try owner.sceneCreateNode(result, 0, 1);
    return result;
}

test "Context reuse warm scene construction allocates no native or Yoga shells" {
    const Probe = struct {
        fn dirtied(data: ?*anyopaque, _: yoga.YGNodeConstRef) void {
            const calls: *u32 = @ptrCast(@alignCast(data.?));
            calls.* += 1;
        }
    };
    var dirty_calls: u32 = 0;
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    const owner = try context.Context.init(failing.allocator(), testing.io, .{
        .yoga_callbacks = .{ .user_data = &dirty_calls, .dirtied = Probe.dirtied },
    });
    defer owner.deinit() catch unreachable;
    try testing.expectEqual(@as(usize, 0), owner.node_pool.len);
    const id = try session(owner);
    const old = try owner.sceneCreateNode(id, 1, 2);
    const node = try owner.getRenderable(old);
    const yoga_node = node.yoga_node;
    const token = node.scene_node.?.token;
    try owner.sceneSetHooks(old, 8, 23, 0, 0);
    try owner.sceneSetPaint(old, .{ .opacity = 0.5, .zIndex = 12 });
    try owner.sceneSetStyle(old, 4, 0, 0, 1, 7, 1);
    try yoga.check(yoga.yogaNodeSetDirtiedFuncChecked(node.yoga_node, 1));
    try owner.sceneDestroyNode(old);
    const entries = owner.node_pool;
    try testing.expect(entries.len > 0 and entries.len < context.Context.node_pool_count_max);
    failing.fail_index = failing.alloc_index;
    failing.resize_fail_index = failing.resize_index;
    yoga.testFailAfter(0);
    defer yoga.testFailAfter(-1);
    const fresh = try owner.sceneCreateNode(id, 1, 3);
    try testing.expectEqual(node, try owner.getRenderable(fresh));
    try testing.expectEqual(yoga_node, node.yoga_node);
    try testing.expectEqual(entries.ptr, owner.node_pool.ptr);
    try testing.expectEqual(entries.len, owner.node_pool.len);
    try testing.expectEqual(old.slot, fresh.slot);
    try testing.expect(old.generation != fresh.generation);
    try testing.expect(token != node.scene_node.?.token);
    try testing.expectError(error.StaleHandle, owner.getRenderable(old));
    try testing.expectEqual(@as(u32, 0), node.scene_node.?.hook_flags);
    try testing.expectEqual(@as(u64, 0), node.scene_node.?.hook_generation);
    try testing.expectEqualDeep(scene.Paint{}, node.scene_node.?.paint);
    try testing.expect(node.measure_target == .none);
    try testing.expect(!yoga.yogaNodeHasMeasureFunc(node.yoga_node));
    try testing.expectEqual(@intFromEnum(yoga.YogaUnit.auto), (try owner.sceneGetStyle(fresh, 2, 0, 0)).unit);
    try yoga.check(yoga.yogaNodeCalculateLayoutChecked(node.yoga_node, 16, 4, 1));
    try yoga.check(yoga.yogaNodeStyleSetFloatChecked(node.yoga_node, 1, 2));
    try testing.expectEqual(@as(u32, 0), dirty_calls);
    try owner.sceneDestroyNode(fresh);
    try testing.expect(!failing.has_induced_failure);
    try testing.expectEqual(@as(u64, 0), yoga.testAllocationCount());
}

test "Context reuse ordinary Text retains controls and frees rope backing without consolidation" {
    var failing = testing.FailingAllocator.init(testing.allocator, .{ .resize_fail_index = 0 });
    const owner = try context.Context.init(failing.allocator(), testing.io, .{});
    defer owner.deinit() catch unreachable;
    const id = try session(owner);
    const cold_before = failing.alloc_index;
    const old = try owner.sceneCreateNode(id, 2, 2);
    const cold_allocations = failing.alloc_index - cold_before;
    const text = (try owner.getRenderable(old)).scene_node.?.text.?;
    const buffer = text.buffer;
    const view = text.view;
    const empty_rope_capacity = buffer.arena.queryCapacity();
    const view_arena = view.virtual_lines_arena;
    try owner.sceneSetText(old, "stale contents");
    const arena = buffer.arena;
    _ = try buffer.allocator.alloc(u8, 24 * 1024);
    _ = try view.measure_arena.allocator().alloc(u8, 1024);
    const measure_capacity = view.measure_arena.queryCapacity();
    const registrations = buffer.mem_registry.buffers.items.ptr;
    const view_flags = buffer.view_dirty_flags.items.ptr;
    const free_view_ids = buffer.free_view_ids.items.ptr;
    view.setWrapMode(.word);
    view.setFirstLineOffset(9);
    view.setViewport(.{ .x = 3, .y = 2, .width = 8, .height = 2 });
    const retire_before = failing.alloc_index;
    failing.fail_index = retire_before;
    failing.resize_fail_index = failing.resize_index;
    try owner.destroy(old);
    try testing.expect(!failing.has_induced_failure);
    try testing.expectEqual(retire_before, failing.alloc_index);
    try testing.expectEqual(@as(usize, 0), arena.queryCapacity());
    try testing.expectEqual(measure_capacity, view.measure_arena.queryCapacity());
    const warm_before = failing.alloc_index;
    // Only a fresh empty rope needs backing; its controls and tables stay allocated.
    failing.fail_index = warm_before + 2;
    failing.resize_fail_index = failing.resize_index;
    const fresh = try owner.sceneCreateNode(id, 2, 3);
    const reused = (try owner.getRenderable(fresh)).scene_node.?.text.?;
    try testing.expectEqual(text, reused);
    try testing.expectEqual(buffer, reused.buffer);
    try testing.expectEqual(view, reused.view);
    try testing.expectEqual(arena, buffer.arena);
    try testing.expectEqual(view_arena, view.virtual_lines_arena);
    try testing.expectEqual(empty_rope_capacity, arena.queryCapacity());
    try testing.expectEqual(measure_capacity, view.measure_arena.queryCapacity());
    try testing.expectEqual(registrations, buffer.mem_registry.buffers.items.ptr);
    try testing.expectEqual(view_flags, buffer.view_dirty_flags.items.ptr);
    try testing.expectEqual(free_view_ids, buffer.free_view_ids.items.ptr);
    try testing.expectEqual(@as(u32, 0), buffer.getByteSize());
    try testing.expectEqual(@as(u64, 0), buffer.content_epoch);
    try testing.expectEqual(@as(u32, 0), view.first_line_offset);
    try testing.expectEqual(.word, view.wrap_mode);
    try testing.expectEqual(null, view.viewport);
    try testing.expectError(error.StaleHandle, owner.getRenderable(old));
    try testing.expect(!failing.has_induced_failure);
    try testing.expectEqual(@as(usize, 2), failing.alloc_index - warm_before);
    try testing.expect(cold_allocations > failing.alloc_index - warm_before);
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
    const shell = try owner.getRenderable(last);
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
    try testing.expectEqual(shell, try owner.getRenderable(fresh));
    try testing.expectError(error.StaleHandle, owner.getRenderable(last));
    try testing.expect(!failing.has_induced_failure);
}

test "Context reuse applies current Yoga configuration defaults at checkout" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const id = try session(owner);
    const old = try owner.sceneCreateNode(id, 1, 2);
    const node = try owner.getRenderable(old);
    try owner.sceneDestroyNode(old);
    try yoga.check(yoga.yogaConfigSetUseWebDefaultsChecked(owner.yoga_config.ref, 1));
    const fresh = try owner.sceneCreateNode(id, 1, 3);
    try testing.expectEqual(node, try owner.getRenderable(fresh));
    try testing.expectEqual(@intFromEnum(yoga.YogaFlexDirection.row), yoga.yogaNodeStyleGetEnum(node.yoga_node, 1));
    try testing.expectEqual(@as(u32, yoga_c.YGAlignStretch), yoga.yogaNodeStyleGetEnum(node.yoga_node, 3));
    try owner.sceneDestroyNode(fresh);
    try yoga.check(yoga.yogaConfigSetUseWebDefaultsChecked(owner.yoga_config.ref, 0));
    const restored = try owner.sceneCreateNode(id, 1, 4);
    try testing.expectEqual(node, try owner.getRenderable(restored));
    try testing.expectEqual(@intFromEnum(yoga.YogaFlexDirection.column), yoga.yogaNodeStyleGetEnum(node.yoga_node, 1));
    try testing.expectEqual(@as(u32, yoga_c.YGAlignFlexStart), yoga.yogaNodeStyleGetEnum(node.yoga_node, 3));
}

test "Context reuse failed arena reconstruction discards dormant Text storage" {
    for (0..2) |offset| {
        var failing = testing.FailingAllocator.init(testing.allocator, .{});
        const owner = try context.Context.init(failing.allocator(), testing.io, .{});
        defer owner.deinit() catch unreachable;
        const id = try session(owner);
        const old = try owner.sceneCreateNode(id, 2, 2);
        try owner.sceneSetText(old, "stale contents");
        try owner.destroy(old);
        try testing.expectEqual(@as(u32, 1), owner.text_pool_count);
        try testing.expectEqual(@as(usize, 0), owner.text_pool.?.buffer.arena.queryCapacity());
        failing.fail_index = failing.alloc_index + offset;
        failing.resize_fail_index = failing.resize_index;
        try testing.expectError(error.OutOfMemory, owner.sceneCreateNode(id, 2, 3));
        try testing.expectEqual(@as(u32, 0), owner.text_pool_count);
        try testing.expectEqual(@as(usize, 0), owner.text_pool_bytes);
        try testing.expectEqual(@as(u32, 2), owner.objects.live_count);
        failing.fail_index = std.math.maxInt(usize);
        failing.resize_fail_index = std.math.maxInt(usize);
        const fresh = try owner.sceneCreateNode(id, 2, 3);
        try testing.expectEqual(@as(u32, 0), (try owner.getRenderable(fresh)).scene_node.?.text.?.buffer.getByteSize());
    }
}

test "Context reuse preserves detached child capacity and clears measurement providers" {
    const Probe = struct {
        fn measure(_: u64, _: u32, _: u32, _: f32, _: u32, _: f32, _: u32, result: *yoga.ExternalYogaSize) callconv(.c) void {
            result.* = .{ .width = 11, .height = 1 };
        }
    };
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    const owner = try context.Context.init(failing.allocator(), testing.io, .{});
    defer owner.deinit() catch unreachable;
    const id = try session(owner);
    const parent = try owner.sceneCreateNode(id, 1, 2);
    const node = try owner.getRenderable(parent);
    var children: [8]context.Handle = undefined;
    for (&children, 0..) |*child, index| {
        child.* = try owner.sceneCreateNode(id, 1, @intCast(index + 3));
        try owner.sceneMoveNode(child.*, parent, @intCast(index));
    }
    const capacity = node.scene_node.?.children.capacity;
    const bytes = yoga.nodeStorageBytes(node.yoga_node);
    try owner.sceneDestroyNode(parent);
    for (children) |child| try testing.expectEqual(null, (try owner.getRenderable(child)).scene_node.?.parent);
    failing.fail_index = failing.alloc_index;
    failing.resize_fail_index = failing.resize_index;
    yoga.testFailAfter(0);
    defer yoga.testFailAfter(-1);
    const fresh = try owner.sceneCreateNode(id, 1, 100);
    try testing.expectEqual(capacity, node.scene_node.?.children.capacity);
    try testing.expectEqual(bytes, yoga.nodeStorageBytes(node.yoga_node));
    for (children, 0..) |child, index| try owner.sceneMoveNode(child, fresh, @intCast(index));
    try testing.expect(!failing.has_induced_failure);
    try testing.expectEqual(@as(u64, 0), yoga.testAllocationCount());
    yoga.testFailAfter(-1);
    failing.fail_index = std.math.maxInt(usize);
    failing.resize_fail_index = std.math.maxInt(usize);
    try owner.sceneDestroyNode(fresh);
    const measured = try owner.sceneCreateNode(id, 2, 101);
    const measured_node = try owner.getRenderable(measured);
    const view = measured_node.scene_node.?.text.?.view;
    try owner.sceneSetMeasure(measured, Probe.measure);
    try owner.sceneDestroyNode(measured);
    try testing.expectEqual(null, view.measure_dependents);
    try testing.expectEqual(@as(u32, 0), owner.scene_measures.count());
    const plain = try owner.sceneCreateNode(id, 1, 102);
    try testing.expectEqual(measured_node, try owner.getRenderable(plain));
    try testing.expect(!yoga.yogaNodeHasMeasureFunc(measured_node.yoga_node));
    try testing.expectEqual(null, measured_node.measure_dependents);
    try testing.expectEqual(null, measured_node.measure_next);
    try testing.expectEqual(null, measured_node.measure_previous);
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
    for (owner.node_pool[0..owner.node_pool_count]) |storage| bytes += storage.retainedBytes();
    try testing.expectEqual(bytes, owner.node_pool_bytes);
    try testing.expect(bytes + owner.node_pool.len * @sizeOf(@TypeOf(owner.node_pool[0])) <= context.Context.node_pool_bytes_max);
    const large = try owner.sceneCreateNode(id, 1, 1000);
    const node = try owner.getRenderable(large);
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
    _ = try (try owner.getRenderable(large_text)).scene_node.?.text.?.view.measure_arena.allocator().alloc(u8, context.Context.text_storage_bytes_max);
    const before_texts = owner.text_pool_count;
    try owner.destroy(large_text);
    try testing.expectEqual(before_texts, owner.text_pool_count);
}

test "Context reuse text byte budget is independent of count budget" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const id = try session(owner);
    var texts: [200]context.Handle = undefined;
    for (&texts, 0..) |*handle, index| {
        handle.* = try owner.sceneCreateNode(id, 2, @intCast(index + 2));
        _ = try (try owner.getRenderable(handle.*)).scene_node.?.text.?.view.measure_arena.allocator().alloc(u8, 24 * 1024);
    }
    for (texts) |handle| try owner.destroy(handle);
    try testing.expect(owner.text_pool_count > 0 and owner.text_pool_count < texts.len);
    try testing.expect(owner.text_pool_bytes <= context.Context.text_pool_bytes_max);
    var count: u32 = 0;
    var bytes: usize = 0;
    var cursor = owner.text_pool;
    while (cursor) |text| : (cursor = text.pool_next) {
        count += 1;
        bytes += @sizeOf(context.Text) + text.buffer.retainedStorageBytes() + text.view.retainedStorageBytes();
    }
    try testing.expectEqual(owner.text_pool_count, count);
    try testing.expectEqual(owner.text_pool_bytes, bytes);
}

test "Context reuse releases borrowed measurements styles and links before pooling" {
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    const owner = try context.Context.init(failing.allocator(), testing.io, .{});
    defer owner.deinit() catch unreachable;
    const id = try session(owner);
    const text_handle = try owner.sceneCreateNode(id, 2, 2);
    const text = (try owner.getRenderable(text_handle)).scene_node.?.text.?;
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
    try testing.expectEqual(text, (try owner.getRenderable(handle)).scene_node.?.text.?);
    const style_handle = try owner.createSyntaxStyle();
    const style = try owner.getSyntaxStyle(style_handle);
    text.buffer.setSyntaxStyle(style);
    try testing.expectEqual(@as(usize, 1), style.emitter.listeners.get(.Destroy).?.items.len);
    const borrower = try owner.sceneCreateNode(id, 1, 4);
    try (try owner.getRenderable(borrower)).setMeasureTarget(.{ .text_buffer_view = text.view });
    failing.fail_index = failing.alloc_index;
    failing.resize_fail_index = failing.resize_index;
    try owner.destroy(handle);
    try testing.expect(!failing.has_induced_failure);
    try testing.expect((try owner.getRenderable(borrower)).measure_target == .none);
    try testing.expectEqual(@as(usize, 0), style.emitter.listeners.get(.Destroy).?.items.len);
    // Leave the borrower, borrowed style, and idle storage for Context teardown.
}

test "Context reuse poisoned Yoga nodes never enter the pool" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const id = try session(owner);
    const root = (try owner.getSession(id)).scene.?.root.?.scene_node.?.handle;
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

test "Context reuse failed text construction releases the checked out shell" {
    for (0..10) |offset| {
        var failing = testing.FailingAllocator.init(testing.allocator, .{});
        const owner = try context.Context.init(failing.allocator(), testing.io, .{});
        defer owner.deinit() catch unreachable;
        const id = try session(owner);
        const old = try owner.sceneCreateNode(id, 1, 2);
        try owner.sceneDestroyNode(old);
        failing.fail_index = failing.alloc_index + offset;
        const result = owner.sceneCreateNode(id, 2, 3);
        failing.fail_index = std.math.maxInt(usize);
        if (result) |handle| {
            try owner.sceneDestroyNode(handle);
        } else |err| {
            try testing.expectEqual(error.OutOfMemory, err);
            try testing.expectEqual(@as(u32, 1), (try owner.getSession(id)).scene.?.count);
            try testing.expectEqual(@as(u32, 1), owner.node_pool_count);
            const recovered = try owner.sceneCreateNode(id, 2, 4);
            try owner.sceneDestroyNode(recovered);
        }
    }
}

test "Context reuse entered paint owns retired bytes until resume cancel or teardown" {
    for (0..3) |ending| {
        const owner = try context.Context.init(testing.allocator, testing.io, .{});
        defer owner.deinit() catch unreachable;
        const id = try session(owner);
        const root = (try owner.getSession(id)).scene.?.root.?.scene_node.?.handle;
        const arrow = try owner.sceneCreateNode(id, 4, 2);
        const shell = try owner.getRenderable(arrow);
        try owner.sceneSetArrow(arrow, .{ .text = "old arrow" });
        try owner.sceneSetStyle(arrow, 4, 0, 0, 1, 9, 1);
        try owner.sceneSetStyle(arrow, 4, 1, 0, 1, 1, 1);
        try owner.sceneMoveNode(arrow, root, 0);
        try owner.sceneSetHooks(arrow, 8, 1, 9, 1);
        const options: scene.FrameOptions = .{
            .background = .{ 0, 0, 0, 255 },
            .use_mouse = false,
            .excluded_hit_num = 0,
            .max_layout_rounds = 8,
            .max_host_requests = 128,
        };
        const request = try owner.sceneFrameStep(id, null, options);
        try testing.expectEqual(@as(u32, 4), request.kind);
        try owner.sceneDestroyNode(arrow);
        const fresh = try owner.sceneCreateNode(id, 4, 3);
        try testing.expectEqual(shell, try owner.getRenderable(fresh));
        try owner.sceneSetArrow(fresh, .{ .text = "new arrow" });
        if (ending == 0) {
            const done = try owner.sceneFrameStep(id, request, options);
            try testing.expectEqual(@as(u32, 0), done.kind);
            const target = (try owner.getSessionRenderer(id)).getNextBuffer();
            var output: [128]u8 = undefined;
            const length = try target.writeResolvedChars(&output, false);
            try testing.expect(std.mem.startsWith(u8, output[0..length], "old arrow"));
        } else if (ending == 1) {
            try owner.sceneFrameCancel(id, request.frame_id);
        }
    }
}
