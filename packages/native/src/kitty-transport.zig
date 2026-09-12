const std = @import("std");
const builtin = @import("builtin");
const io = if (builtin.is_test) std.testing.io else @import("root").io;
const terminal_image = @import("terminal-image.zig");
const native_image = @import("image.zig");

pub const Mode = enum(u32) { raw, zlib, file };
pub const FileState = enum(u32) { disabled, probing, ready, unsupported, timeout, io_error, cancelled };
pub const Fallback = enum(u32) { none, not_ready, unavailable, budget, busy, preparation, compression };

// A stalled terminal may pin at most eight files and 64 MiB per renderer.
pub const LEASES_MAX = 8;
pub const BYTES_MAX = terminal_image.KITTY_PREPARE_BYTES_MAX;
pub const TIMEOUT_MS = 5000;

const Lease = struct {
    id: u32 = 0,
    path: [768]u8 = undefined,
    path_len: usize = 0,
    size: usize = 0,
    deadline_ms: i64 = 0,

    fn release(self: *Lease) void {
        if (self.path_len == 0) return;
        std.Io.Dir.deleteFileAbsolute(io, self.path[0..self.path_len]) catch |err| {
            // Keep failed unlinks accounted for and retry on the next expiry/teardown.
            if (err != error.FileNotFound) return;
        };
        self.* = .{};
    }
};

pub const Transport = struct {
    mode: Mode = .raw,
    effective: terminal_image.KittyEncoding = .raw,
    file_state: FileState = .disabled,
    fallback: Fallback = .none,
    leases: [LEASES_MAX]Lease = @splat(.{}),
    query_id: u32 = 0,
    upload_probe_id: u32 = 0,
    query_ok: bool = false,
    upload_ok: bool = false,
    retry_images: bool = false,

    pub fn nowMs() i64 {
        return @intCast(std.Io.Clock.now(.awake, io).toMilliseconds());
    }

    pub fn pendingBytes(self: *const Transport) usize {
        var bytes: usize = 0;
        for (self.leases) |lease| bytes += lease.size;
        return bytes;
    }

    pub fn pendingCount(self: *const Transport) u32 {
        var count: u32 = 0;
        for (self.leases) |lease| count += @intFromBool(lease.path_len != 0);
        return count;
    }

    pub fn cancel(self: *Transport, reason: FileState) void {
        self.retry_images = self.retry_images or self.file_state == .ready;
        for (&self.leases) |*lease| lease.release();
        if (self.mode == .file or self.file_state != .disabled) self.file_state = if (self.pendingCount() == 0) reason else .io_error;
    }

    pub fn expire(self: *Transport, now_ms: i64) void {
        for (self.leases) |lease| {
            if (lease.path_len != 0 and now_ms >= lease.deadline_ms) {
                // Timeout is cancellation, never evidence that a terminal consumed a file.
                // Disable the medium permanently so late ACKs cannot release new leases.
                self.cancel(.timeout);
                return;
            }
        }
    }

    fn createLease(self: *Transport, id: u32, image: *native_image.Image, directory: []const u8) !*Lease {
        if (builtin.os.tag == .windows) return error.Unsupported;
        if (!std.fs.path.isAbsolute(directory)) return error.InvalidDirectory;
        const size = try terminal_image.kittyPayloadSize(image);
        if (size > BYTES_MAX - self.pendingBytes()) return error.Budget;
        var slot: ?*Lease = null;
        for (&self.leases) |*lease| {
            if (lease.path_len != 0 and lease.id == id) return error.Busy;
            if (lease.path_len == 0) slot = lease;
        }
        const lease = slot orelse return error.Budget;
        var random: [16]u8 = undefined;
        if (builtin.os.tag == .linux) {
            // Zig 0.16's glibc-2.17 randomSecure fallback reads /dev/urandom but
            // then returns EntropyUnavailable. Read that source directly.
            const entropy = try std.Io.Dir.openFileAbsolute(io, "/dev/urandom", .{});
            defer entropy.close(io);
            var reader = entropy.readerStreaming(io, &.{});
            try reader.interface.readSliceAll(&random);
        } else try io.randomSecure(&random);
        const path = try std.fmt.bufPrint(&lease.path, "{s}/opentui-kitty-{s}", .{ directory, std.fmt.bytesToHex(random, .lower) });
        const file = try std.Io.Dir.createFileAbsolute(io, path, .{ .exclusive = true, .permissions = .fromMode(0o600) });
        lease.path_len = path.len;
        lease.size = size;
        errdefer lease.release();
        defer file.close(io);
        var buffer: [8192]u8 = undefined;
        var output = file.writerStreaming(io, &buffer);
        try terminal_image.writeKittyPayload(&output.interface, image);
        try output.interface.flush();
        lease.id = id;
        lease.deadline_ms = nowMs() + TIMEOUT_MS;
        return lease;
    }

    fn writeReference(writer: anytype, lease: *const Lease, image: *native_image.Image, id: u32, action: u8) !void {
        var encoded: [1024]u8 = undefined;
        const payload = std.base64.standard.Encoder.encode(&encoded, lease.path[0..lease.path_len]);
        const format: u32 = if (image.encoded_png != null) 100 else if (image.metadata.has_alpha == 0) 24 else 32;
        try writer.print("\x1b_Ga={c},t=f,f={d},s={d},v={d},i={d},q=0;{s}\x1b\\", .{
            action, format, image.width(), image.height(), id, payload,
        });
    }

    pub fn startProbe(self: *Transport, writer: anytype, first_id: u32, directory: []const u8) !void {
        if (self.mode != .file or self.file_state != .disabled) return;
        var pixel = [_]u8{ 0, 0, 0, 255 };
        var image: native_image.Image = .{
            .allocator = std.heap.page_allocator,
            .pixels = &pixel,
            .metadata = .{ .width = 1, .height = 1, .has_alpha = 0 },
        };
        self.file_state = .probing;
        errdefer self.cancel(.io_error);
        self.query_id = first_id;
        self.upload_probe_id = first_id + 1;
        const lease = try self.createLease(self.upload_probe_id, &image, directory);
        try writeReference(writer, lease, &image, self.query_id, 'q');
        // Old WezTerm answers queries but omits explicit-ID upload OKs. Require both.
        try writeReference(writer, lease, &image, self.upload_probe_id, 't');
        try terminal_image.writeKittyDelete(writer, self.upload_probe_id, null, true, false);
    }

    pub fn handleReply(self: *Transport, response: []const u8) bool {
        if (self.file_state == .disabled or response.len > 4096 or !std.mem.startsWith(u8, response, "\x1b_G") or
            !std.mem.endsWith(u8, response, "\x1b\\")) return false;
        const separator = std.mem.findScalar(u8, response, ';') orelse return false;
        var fields = std.mem.splitScalar(u8, response[3..separator], ',');
        var id: ?u32 = null;
        while (fields.next()) |field| {
            if (!std.mem.startsWith(u8, field, "i=")) continue;
            if (id != null) return false;
            id = std.fmt.parseInt(u32, field[2..], 10) catch return false;
        }
        const image_id = id orelse return false;
        const ok = std.mem.eql(u8, response[separator + 1 .. response.len - 2], "OK");
        if (image_id == self.query_id or image_id == self.upload_probe_id) {
            if (self.file_state != .probing) return true;
            if (!ok) {
                self.cancel(.unsupported);
            } else {
                if (image_id == self.query_id) self.query_ok = true else self.upload_ok = true;
                if (self.query_ok and self.upload_ok) {
                    for (&self.leases) |*lease| lease.release();
                    self.file_state = if (self.pendingCount() == 0) .ready else .io_error;
                    if (self.file_state == .ready and self.mode == .file) self.retry_images = true;
                }
            }
            return true;
        }
        for (&self.leases) |*lease| {
            if (lease.path_len == 0 or lease.id != image_id) continue;
            if (ok) {
                lease.release();
                if (lease.path_len != 0) self.cancel(.io_error);
            } else self.cancel(.unsupported);
            return true;
        }
        return false;
    }

    pub fn transmit(self: *Transport, allocator: std.mem.Allocator, writer: anytype, image: *native_image.Image, id: u32, tmux: bool, directory: []const u8) !void {
        self.fallback = .none;
        if (self.mode == .file) file: {
            self.expire(nowMs());
            if (self.file_state != .ready or tmux) {
                self.fallback = if (self.file_state == .probing) .not_ready else .unavailable;
                break :file;
            }
            const lease = self.createLease(id, image, directory) catch |err| {
                self.fallback = if (err == error.Budget)
                    .budget
                else if (err == error.Busy)
                    .busy
                else
                    .preparation;
                if (self.fallback == .preparation) self.cancel(.io_error);
                break :file;
            };
            writeReference(writer, lease, image, id, 't') catch |err| {
                self.cancel(.io_error);
                return err;
            };
            self.effective = .file;
            return;
        }
        self.effective = try terminal_image.writeKittyTransmitEncoded(allocator, writer, image, id, tmux, self.mode == .zlib);
        if (self.mode == .zlib and self.effective == .raw) self.fallback = .compression;
    }
};
