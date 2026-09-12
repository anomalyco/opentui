const std = @import("std");
const builtin = @import("builtin");
const kitty = @import("../kitty-transport.zig");
const image = @import("../image.zig");

const Fixture = struct {
    tmp: std.testing.TmpDir,
    directory: [512]u8 = undefined,
    directory_len: usize = 0,
    transport: kitty.Transport = .{ .mode = .file },
    output: std.Io.Writer.Allocating = .init(std.testing.allocator),

    fn init(self: *Fixture) !void {
        if (builtin.os.tag == .windows) return error.SkipZigTest;
        self.* = .{ .tmp = std.testing.tmpDir(.{ .iterate = true }) };
        errdefer self.tmp.cleanup();
        self.directory_len = try self.tmp.dir.realPath(std.testing.io, &self.directory);
    }

    fn deinit(self: *Fixture) void {
        self.transport.cancel(.cancelled);
        self.output.deinit();
        self.tmp.cleanup();
    }

    fn expectNoFiles(self: *Fixture) !void {
        var iterator = self.tmp.dir.iterate();
        try std.testing.expectEqual(null, try iterator.next(std.testing.io));
    }

    fn probe(self: *Fixture) !void {
        try self.transport.startProbe(&self.output.writer, 7, self.directory[0..self.directory_len]);
    }

    fn ready(self: *Fixture) !void {
        try self.probe();
        try std.testing.expect(self.transport.handleReply("\x1b_Gi=7;OK\x1b\\"));
        try std.testing.expect(self.transport.handleReply("\x1b_Gi=8;OK\x1b\\"));
        try std.testing.expectEqual(.ready, self.transport.file_state);
        self.transport.retry_images = false;
        self.output.clearRetainingCapacity();
    }

    fn transmit(self: *Fixture, value: *image.Image, id: u32) !void {
        try self.transport.transmit(std.testing.allocator, &self.output.writer, value, id, false, self.directory[0..self.directory_len]);
    }
};

test "kitty file query requires medium and explicit image ACK, not ordinary frame reports" {
    var f: Fixture = undefined;
    try f.init();
    defer f.deinit();
    try f.probe();
    try std.testing.expect(std.mem.find(u8, f.output.written(), "a=q,t=f") != null);
    try std.testing.expect(std.mem.find(u8, f.output.written(), "a=t,t=f") != null);
    try std.testing.expectEqual(@as(u32, 1), f.transport.pendingCount());
    try std.testing.expect(!f.transport.handleReply("\x1b[0n"));
    try std.testing.expect(!f.transport.handleReply("\x1b_Gi=31337;OK\x1b\\"));
    try std.testing.expect(!f.transport.handleReply("\x1b_Gi=7,i=8;OK\x1b\\"));
    try std.testing.expect(f.transport.handleReply("\x1b_Gi=7;OK\x1b\\"));
    try std.testing.expectEqual(.probing, f.transport.file_state);
    f.transport.expire(std.math.maxInt(i64));
    try std.testing.expectEqual(.timeout, f.transport.file_state);
    try std.testing.expectEqual(@as(u32, 0), f.transport.pendingCount());
    try f.expectNoFiles();
    try std.testing.expect(f.transport.handleReply("\x1b_Gi=8;OK\x1b\\"));
    try std.testing.expectEqual(.timeout, f.transport.file_state);
}

test "kitty file leases contain immutable bytes and are released only by matching ACK" {
    var f: Fixture = undefined;
    try f.init();
    defer f.deinit();
    try f.ready();
    const value = try image.createFromRgba(std.testing.allocator, &.{ 1, 2, 3, 255 }, 1, 1, 4);
    defer value.deinit();
    try f.transmit(value, 19);
    try std.testing.expectEqual(.file, f.transport.effective);
    const path = try @import("terminal-image_test.zig").decodeKittyChunks(f.output.written());
    defer std.testing.allocator.free(path);
    const contents = try std.Io.Dir.cwd().readFileAlloc(std.testing.io, path, std.testing.allocator, .limited(16));
    defer std.testing.allocator.free(contents);
    try std.testing.expectEqualSlices(u8, &.{ 1, 2, 3 }, contents);
    f.transport.mode = .raw;
    value.pixels[0] = 99;
    try f.transmit(value, 19);
    try std.testing.expectEqual(.raw, f.transport.effective);
    f.transport.mode = .file;
    try f.transmit(value, 19);
    try std.testing.expectEqual(.raw, f.transport.effective);
    try std.testing.expectEqual(.busy, f.transport.fallback);
    try std.testing.expectEqual(@as(u32, 1), f.transport.pendingCount());
    try std.testing.expect(!f.transport.handleReply("\x1b_Gi=190;OK\x1b\\"));
    const unchanged = try std.Io.Dir.cwd().readFileAlloc(std.testing.io, path, std.testing.allocator, .limited(16));
    defer std.testing.allocator.free(unchanged);
    try std.testing.expectEqualSlices(u8, contents, unchanged);
    f.transport.mode = .zlib;
    try std.testing.expect(f.transport.handleReply("\x1b_Gi=19;OK\x1b\\"));
    try std.testing.expectError(error.FileNotFound, std.Io.Dir.accessAbsolute(std.testing.io, path, .{}));
    try std.testing.expectEqual(@as(u32, 0), f.transport.pendingCount());
    try std.testing.expectEqual(.ready, f.transport.file_state);
    try std.testing.expect(!f.transport.retry_images);
}

test "kitty file probe readiness retries only images using the selected file mode" {
    for ([_]kitty.Mode{ .file, .raw, .zlib }) |mode| {
        var f: Fixture = undefined;
        try f.init();
        defer f.deinit();
        try f.probe();
        try std.testing.expect(f.transport.handleReply("\x1b_Gi=7;OK\x1b\\"));
        try std.testing.expect(!f.transport.retry_images);
        f.transport.mode = mode;
        try std.testing.expect(f.transport.handleReply("\x1b_Gi=8;OK\x1b\\"));
        try std.testing.expectEqual(.ready, f.transport.file_state);
        try std.testing.expectEqual(mode == .file, f.transport.retry_images);
        try f.expectNoFiles();
        f.transport.retry_images = false;
        try std.testing.expect(f.transport.handleReply("\x1b_Gi=8;OK\x1b\\"));
        try std.testing.expect(!f.transport.retry_images);
        f.transport.mode = .file;
        f.output.clearRetainingCapacity();
        try f.probe();
        try std.testing.expectEqual(@as(usize, 0), f.output.written().len);
    }
}

test "kitty file upload expiry cancels rather than reusing a late acknowledged lease" {
    var f: Fixture = undefined;
    try f.init();
    defer f.deinit();
    try f.ready();
    const value = try image.createFromRgba(std.testing.allocator, &.{ 1, 2, 3, 4 }, 1, 1, 4);
    defer value.deinit();
    try f.transmit(value, 19);
    var deadline: i64 = 0;
    for (f.transport.leases) |lease| if (lease.path_len != 0) {
        deadline = lease.deadline_ms;
    };
    f.transport.mode = .raw;
    f.transport.expire(deadline - 1);
    try std.testing.expectEqual(@as(u32, 1), f.transport.pendingCount());
    f.transport.expire(deadline);
    try std.testing.expectEqual(@as(u32, 0), f.transport.pendingCount());
    try f.expectNoFiles();
    try std.testing.expectEqual(.timeout, f.transport.file_state);
    try std.testing.expect(f.transport.retry_images);
    f.transport.mode = .file;
    f.output.clearRetainingCapacity();
    try f.probe();
    try std.testing.expectEqual(@as(usize, 0), f.output.written().len);
    try f.transmit(value, 19);
    try std.testing.expectEqual(.raw, f.transport.effective);
    try std.testing.expect(!f.transport.handleReply("\x1b_Gi=19;OK\x1b\\"));
    try std.testing.expectEqual(.timeout, f.transport.file_state);
}

test "kitty file slot budget falls back to raw and upload errors release all leases" {
    var f: Fixture = undefined;
    try f.init();
    defer f.deinit();
    try f.ready();
    const value = try image.createFromRgba(std.testing.allocator, &.{ 1, 2, 3, 4 }, 1, 1, 4);
    defer value.deinit();
    for (0..kitty.LEASES_MAX) |i| try f.transmit(value, @intCast(20 + i));
    try f.transmit(value, 100);
    try std.testing.expectEqual(.raw, f.transport.effective);
    try std.testing.expectEqual(.budget, f.transport.fallback);
    try std.testing.expectEqual(@as(u32, kitty.LEASES_MAX), f.transport.pendingCount());
    try std.testing.expectEqual(@as(usize, kitty.LEASES_MAX * 4), f.transport.pendingBytes());
    try std.testing.expect(f.transport.handleReply("\x1b_Gi=20;ENOENT:not found\x1b\\"));
    try std.testing.expectEqual(.unsupported, f.transport.file_state);
    try std.testing.expect(f.transport.retry_images);
    try std.testing.expectEqual(@as(u32, 0), f.transport.pendingCount());
    try f.expectNoFiles();
    try f.transmit(value, 100);
    try std.testing.expectEqual(.raw, f.transport.effective);
}

test "kitty file output failures do not leak resources" {
    var f: Fixture = undefined;
    try f.init();
    defer f.deinit();
    var failed: std.Io.Writer = .failing;
    try std.testing.expectError(error.WriteFailed, f.transport.startProbe(&failed, 7, f.directory[0..f.directory_len]));
    try std.testing.expectEqual(@as(u32, 0), f.transport.pendingCount());
    try f.expectNoFiles();
}

test "kitty file preparation failures fall back to raw without leases" {
    var transport: kitty.Transport = .{ .mode = .file, .file_state = .ready };
    defer transport.cancel(.cancelled);
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    const value = try image.createFromRgba(std.testing.allocator, &.{ 1, 2, 3, 4 }, 1, 1, 4);
    defer value.deinit();
    try transport.transmit(std.testing.allocator, &output.writer, value, 19, false, "relative/path");
    try std.testing.expectEqual(.raw, transport.effective);
    try std.testing.expectEqual(.preparation, transport.fallback);
    try std.testing.expectEqual(.io_error, transport.file_state);
    try std.testing.expectEqual(@as(u32, 0), transport.pendingCount());
    try std.testing.expectEqual(@as(usize, 0), transport.pendingBytes());
    const payload = try @import("terminal-image_test.zig").decodeKittyChunks(output.written());
    defer std.testing.allocator.free(payload);
    try std.testing.expectEqualSlices(u8, &.{ 1, 2, 3, 4 }, payload);
}
