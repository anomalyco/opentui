const std = @import("std");
const opentui = @import("opentui");

var io_threaded: std.Io.Threaded = .init_single_threaded;
pub const io = io_threaded.io();

pub fn main(init: std.process.Init) !void {
    const context = try opentui.Context.init(init.gpa, io, .{
        .object_capacity = 8,
        .render_cells_max = 36,
    });
    defer context.deinit() catch unreachable;

    const session = try context.createSession(.{
        .chunk_size = 4096,
        .chunk_count = 2,
        .span_capacity = 2,
    });
    errdefer context.cancelSession(session) catch unreachable;
    try context.attachSessionRenderer(session, 12, 3, .{
        .remote_mode = .remote,
        .forwarded_env = &.{},
    });

    const root = try context.sceneCreateNode(session, 0, 1);
    const box = try context.sceneCreateNode(session, 1, 2);
    const label = try context.sceneCreateNode(session, 2, 3);
    try context.sceneSetPaint(box, .{ .borderSides = 15 });
    try context.sceneSetText(label, "Hello");
    try context.sceneMoveNode(box, root, 0);
    try context.sceneMoveNode(label, box, 0);

    try write_frame(context, session, "hello.ansi");
    try context.sceneSetText(label, "Ready");
    try write_frame(context, session, "ready.ansi");
    try context.beginSessionClose(session);
}

fn write_frame(context: *opentui.Context, session: opentui.context.Handle, path: []const u8) !void {
    const file = try std.Io.Dir.cwd().createFile(io, path, .{});
    defer file.close(io);

    try context.scenePaint(session, .{ 0, 0, 0, 255 }, false, 0);
    switch (try context.renderSession(session, false)) {
        .pending, .presented => {},
        .skipped, .failed => return error.FrameNotAccepted,
    }
    var bytes: [512]u8 = undefined;
    while (try context.readOutput(session, &bytes)) |ticket| {
        file.writeStreamingAll(io, bytes[0..ticket.len]) catch |err| {
            try context.completeOutput(session, ticket, .failed);
            return err;
        };
        try context.completeOutput(session, ticket, .written);
    }
}
