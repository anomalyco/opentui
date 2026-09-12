const std = @import("std");
const opentui = @import("opentui");

var io_threaded: std.Io.Threaded = .init_single_threaded;
pub const io = io_threaded.io();

const MemorySink = struct {
    const capacity = 64 * 1024;

    bytes: [capacity]u8 = undefined,
    length: usize = 0,

    fn output(self: *MemorySink) opentui.BufferedOutput {
        return .{ .ctx = self, .write_fn = write };
    }

    fn write(context: *anyopaque, bytes: []const u8) void {
        const self: *MemorySink = @ptrCast(@alignCast(context));
        std.debug.assert(bytes.len <= capacity - self.length);
        @memcpy(self.bytes[self.length..][0..bytes.len], bytes);
        self.length += bytes.len;
    }

    fn slice(self: *const MemorySink) []const u8 {
        return self.bytes[0..self.length];
    }

    fn clear(self: *MemorySink) void {
        self.length = 0;
    }
};

pub fn main() !void {
    var debug_allocator: std.heap.DebugAllocator(.{}) = .init;
    defer std.debug.assert(debug_allocator.deinit() == .ok);
    const allocator = debug_allocator.allocator();

    const audio_engine = opentui.audio.create(allocator, null) orelse return error.AudioEngineCreationFailed;
    defer opentui.audio.destroy(audio_engine);

    var graphemes = opentui.GraphemePool.init(allocator);
    defer graphemes.deinit();
    var links = opentui.LinkPool.init(allocator);
    defer links.deinit();
    var environment = std.process.Environ.Map.init(allocator);
    defer environment.deinit();
    var sink: MemorySink = .{};

    if (opentui.CliRenderer.createWithOptions(allocator, 0, 1, &graphemes, .{
        .output = .{ .buffered = sink.output() },
        .clearOnShutdown = false,
        .link_pool = &links,
        .env_map = &environment,
    })) |invalid_renderer| {
        invalid_renderer.destroy();
        return error.ExpectedInvalidDimensions;
    } else |err| {
        if (err != error.InvalidDimensions) return err;
    }

    const renderer = try opentui.CliRenderer.createWithOptions(allocator, 8, 1, &graphemes, .{
        .output = .{ .buffered = sink.output() },
        .clearOnShutdown = false,
        .link_pool = &links,
        .env_map = &environment,
    });
    defer renderer.destroy();

    try renderer.getNextBuffer().drawText(
        "OpenTUI",
        0,
        0,
        opentui.rgbColor(255, 180, 40, 255),
        opentui.rgbColor(10, 20, 30, 255),
        opentui.TextAttributes.BOLD | opentui.TextAttributes.UNDERLINE,
    );
    if (renderer.render(true) != .rendered) return error.FirstFrameNotRendered;
    const first_frame_length = sink.length;
    if (std.mem.indexOf(u8, sink.slice(), "OpenTUI") == null) return error.MissingFirstFrameText;

    sink.clear();
    try renderer.resize(12, 2);
    try renderer.getNextBuffer().drawText(
        "resized",
        1,
        1,
        opentui.rgbColor(80, 220, 255, 255),
        null,
        opentui.TextAttributes.ITALIC,
    );
    if (renderer.render(true) != .rendered) return error.SecondFrameNotRendered;
    if (std.mem.indexOf(u8, sink.slice(), "resized") == null) return error.MissingSecondFrameText;

    std.debug.print("rendered {d} and {d} bytes\n", .{ first_frame_length, sink.slice().len });
}
