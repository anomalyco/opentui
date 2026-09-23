const std = @import("std");
const context = @import("../context.zig");
const session = @import("../session.zig");
const scene = @import("../scene.zig");
const renderer = @import("../renderer.zig");

/// Starts a fresh draft for paint/layout assertions, cancelling any preceding capture.
pub fn repaint(owner: *context.Context, id: context.Handle, background: @import("../buffer.zig").RGBA, use_mouse: bool, excluded_hit_num: u32) !void {
    const value = try owner.raw().getSession(id);
    if (value.scene) |state| {
        if (state.painted) |painted| try owner.sceneFrameCancel(id, painted.ticket.frame_id);
    }
    _ = try owner.scenePaint(id, background, use_mouse, excluded_hit_num);
}

pub fn present(owner: *context.Context, id: context.Handle, force: bool) !session.RenderStatus {
    const value = try owner.raw().getSession(id);
    return owner.sceneFrameCommit(id, value.scene.?.painted.?.ticket, force);
}

pub const Fixture = struct {
    owner: *context.Context,
    id: context.Handle,
    root: context.Handle,
    state: *scene.Scene,
    cli: *renderer.CliRenderer,

    pub fn init(allocator: std.mem.Allocator, width: u32, height: u32, options: struct {
        limits: context.Options = .{},
        output: session.Options = .{ .chunk_size = 4096, .chunk_count = 2, .span_capacity = 2 },
    }) !Fixture {
        const owner = try context.Context.init(allocator, std.testing.io, options.limits);
        errdefer owner.deinit() catch unreachable;
        const id = try owner.createSession(options.output);
        try owner.attachSessionRenderer(id, width, height, .{ .remote_mode = .remote });
        const root = try owner.sceneCreateNode(id, 0, 1);
        return .{
            .owner = owner,
            .id = id,
            .root = root,
            .state = (try owner.raw().getSession(id)).scene.?,
            .cli = try owner.raw().getSessionRenderer(id),
        };
    }

    pub fn deinit(self: Fixture) void {
        self.owner.deinit() catch unreachable;
    }

    pub fn step(self: Fixture, previous: ?scene.FrameRequest, options: scene.FrameOptions, kind: u32, node: ?context.Handle) !scene.FrameRequest {
        const request = try self.owner.sceneFrameStep(self.id, previous, options);
        try std.testing.expectEqual(kind, request.kind);
        if (node) |expected| try std.testing.expectEqual(expected, request.node);
        return request;
    }

    /// Both Sessions' next frames hold the same cells and hits.
    pub fn expectSameCells(self: Fixture, actual: Fixture) !void {
        const expected = self.cli.getNextBuffer().buffer;
        const cells = actual.cli.getNextBuffer().buffer;
        try std.testing.expectEqualSlices(u32, expected.char, cells.char);
        try std.testing.expectEqualSlices([4]u16, expected.fg, cells.fg);
        try std.testing.expectEqualSlices([4]u16, expected.bg, cells.bg);
        try std.testing.expectEqualSlices(u32, expected.attributes, cells.attributes);
        try std.testing.expectEqualSlices(u32, self.cli.nextHitGrid, actual.cli.nextHitGrid);
    }

    /// Acknowledges every request unchanged until the attempt paints, and returns DONE.
    pub fn drive(self: Fixture, previous: ?scene.FrameRequest, options: scene.FrameOptions, budget: u32) !scene.FrameRequest {
        var request = previous;
        for (0..1024) |_| {
            const next = try self.owner.sceneFrameStepWorkBudgeted(self.id, request, options, budget);
            if (next.kind == 0) return next;
            request = next;
        }
        return error.TestUnexpectedResult;
    }
};
