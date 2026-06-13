const std = @import("std");

pub const CallbackFn = fn (stream_ptr: usize, event_id: u32, arg0: usize, arg1: u64) callconv(.c) void;

pub const GrowthPolicy = enum(u8) {
    grow = 0,
    block = 1,
};

pub const Options = extern struct {
    chunk_size: u32,
    initial_chunks: u32,
    max_bytes: u64,
    growth_policy: u8,
    auto_commit_on_full: u8,
    span_queue_capacity: u32,
};

pub const Stats = extern struct {
    bytes_written: u64,
    spans_committed: u64,
    chunks: u32,
    pending_spans: u32,
};

const Chunk = struct {
    ptr: [*]u8,
    len: u32,
};

pub const SpanInfo = extern struct {
    chunk_ptr: usize,
    offset: u32,
    len: u32,
    chunk_index: u32,
    reserved: u32,

    pub fn slice(self: SpanInfo) []u8 {
        const base: [*]u8 = @ptrFromInt(self.chunk_ptr);
        const start: usize = @intCast(self.offset);
        const length: usize = @intCast(self.len);
        return base[start .. start + length];
    }
};

const SpanRing = struct {
    buffer: []SpanInfo,
    capacity: u32,
    head: u32,
    tail: u32,

    pub fn count(self: *SpanRing) u32 {
        return self.tail -% self.head;
    }

    fn grow(self: *SpanRing, stream: *Stream) StreamError!void {
        if (stream.options.growth_policy == @intFromEnum(GrowthPolicy.block)) {
            return StreamError.NoSpace;
        }

        const old_capacity = self.capacity;
        const old_count = self.count();
        const new_capacity = if (old_capacity == 0) 1 else old_capacity * 2;
        const new_buffer = stream.allocator.alloc(SpanInfo, new_capacity) catch return StreamError.OutOfMemory;

        var i: u32 = 0;
        while (i < old_count) : (i += 1) {
            const old_index = (self.head +% i) % old_capacity;
            new_buffer[i] = self.buffer[old_index];
        }

        if (old_capacity > 0) {
            stream.allocator.free(self.buffer);
        }
        self.buffer = new_buffer;
        self.capacity = new_capacity;
        self.head = 0;
        self.tail = old_count;
    }

    pub fn push(self: *SpanRing, stream: *Stream, span: SpanInfo, notify: *bool) StreamError!void {
        var capacity = self.capacity;
        var head = self.head;
        var tail = self.tail;
        var queued = tail -% head;

        if (queued >= capacity) {
            try self.grow(stream);
            capacity = self.capacity;
            head = self.head;
            tail = self.tail;
            queued = tail -% head;
        }

        const index = tail % capacity;
        self.buffer[index] = span;
        tail +%= 1;
        self.tail = tail;
        const new_count = queued + 1;

        stream.stats.pending_spans = new_count;
        if (stream.attached and stream.callback != null) {
            if (queued < notify_threshold_default and new_count >= notify_threshold_default) {
                notify.* = true;
            }
        }
    }

    pub fn popMany(self: *SpanRing, out: []SpanInfo) u32 {
        const available = self.tail -% self.head;
        if (available == 0) return 0;
        const to_read: u32 = if (available < out.len) @intCast(available) else @intCast(out.len);

        var i: u32 = 0;
        while (i < to_read) : (i += 1) {
            const index = (self.head +% i) % self.capacity;
            out[i] = self.buffer[index];
        }
        self.head +%= to_read;
        return to_read;
    }
};

pub const ReserveInfo = extern struct {
    ptr: usize,
    len: u32,
    reserved: u32,

    pub fn slice(self: ReserveInfo) []u8 {
        const base: [*]u8 = @ptrFromInt(self.ptr);
        const length: usize = @intCast(self.len);
        return base[0..length];
    }
};

pub const Stream = struct {
    allocator: std.mem.Allocator,
    options: Options,
    chunks: std.ArrayList(Chunk),
    current_chunk_index: usize,
    write_offset: usize,
    pending_chunk_index: usize,
    pending_offset: usize,
    pending_len: usize,
    reserved_active: bool,
    reserved_chunk_index: usize,
    reserved_offset: usize,
    reserved_len: usize,
    attached: bool,
    callback: ?*const CallbackFn,
    closed: bool,
    span_ring: SpanRing,
    state_buffer: []u8,
    state_capacity: u32,
    stats: Stats,

    pub fn create(allocator: std.mem.Allocator, options: ?Options) StreamError!*Stream {
        const opts = normalizeOptions(options orelse defaultOptions());
        const stream = allocator.create(Stream) catch return StreamError.OutOfMemory;
        stream.* = .{
            .allocator = allocator,
            .options = opts,
            .chunks = std.ArrayList(Chunk).empty,
            .current_chunk_index = 0,
            .write_offset = 0,
            .pending_chunk_index = 0,
            .pending_offset = 0,
            .pending_len = 0,
            .reserved_active = false,
            .reserved_chunk_index = 0,
            .reserved_offset = 0,
            .reserved_len = 0,
            .attached = false,
            .callback = null,
            .closed = false,
            .span_ring = .{
                .buffer = &[_]SpanInfo{},
                .capacity = 0,
                .head = 0,
                .tail = 0,
            },
            .state_buffer = &[_]u8{},
            .state_capacity = 0,
            .stats = .{
                .bytes_written = 0,
                .spans_committed = 0,
                .chunks = 0,
                .pending_spans = 0,
            },
        };

        errdefer stream.destroy();

        const ring_capacity = opts.span_queue_capacity;
        const ring_buffer = allocator.alloc(SpanInfo, ring_capacity) catch return StreamError.OutOfMemory;
        stream.span_ring = .{
            .buffer = ring_buffer,
            .capacity = ring_capacity,
            .head = 0,
            .tail = 0,
        };

        try stream.ensureStateCapacity(@intCast(opts.initial_chunks));

        const initial = @as(usize, opts.initial_chunks);
        var i: usize = 0;
        while (i < initial) : (i += 1) {
            try stream.addChunkLocked();
        }
        stream.stats.chunks = @intCast(stream.chunks.items.len);
        return stream;
    }

    pub fn attach(self: *Stream) StreamError!void {
        if (self.closed) return StreamError.Invalid;

        var notify = false;
        var queued: u32 = 0;
        defer self.finish(notify, queued);

        self.attached = true;
        if (self.callback == null) return;

        self.emitStateBuffer();

        for (self.chunks.items) |chunk| {
            self.emitChunkAdded(chunk);
        }

        queued = self.span_ring.count();
        if (queued > 0) {
            notify = true;
        }
    }

    pub fn setCallback(self: *Stream, cb: ?*const CallbackFn) void {
        self.callback = cb;
        if (cb == null or !self.attached) return;

        self.emitStateBuffer();
        for (self.chunks.items) |chunk| {
            self.emitChunkAdded(chunk);
        }
        const queued = self.span_ring.count();
        if (queued > 0) {
            self.emitDataAvailable(queued);
        }
    }

    pub fn write(self: *Stream, data: []const u8) StreamError!void {
        if (self.closed) return StreamError.Invalid;
        if (data.len == 0) return;
        if (self.reserved_active) return StreamError.Busy;

        var notify = false;
        // finish() must run on success and error so committed spans notify.
        defer self.finish(notify, 0);

        var remaining = data.len;
        var src_index: usize = 0;
        const auto_commit = self.options.auto_commit_on_full != 0;
        const chunk_len = self.options.chunk_size;

        while (remaining > 0) {
            var available = @as(usize, chunk_len) - self.write_offset;
            if (available == 0) {
                if (self.pending_len > 0) {
                    try self.commitLocked(&notify);
                }
                try self.ensureWritableChunkLocked();
                available = @as(usize, chunk_len);
            }

            if (remaining > available and !auto_commit) {
                return StreamError.NoSpace;
            }

            const to_write = if (remaining < available) remaining else available;
            if (self.pending_len == 0) {
                self.pending_chunk_index = self.current_chunk_index;
                self.pending_offset = self.write_offset;
            }

            const chunk = self.chunks.items[self.current_chunk_index];
            @memcpy(chunk.ptr[self.write_offset .. self.write_offset + to_write], data[src_index .. src_index + to_write]);

            self.write_offset += to_write;
            self.pending_len += to_write;
            self.stats.bytes_written += @as(u64, to_write);
            src_index += to_write;
            remaining -= to_write;

            if (self.write_offset == @as(usize, chunk_len) and auto_commit) {
                try self.commitLocked(&notify);
                if (remaining > 0) {
                    try self.ensureWritableChunkLocked();
                }
            }
        }
    }

    pub fn reserve(self: *Stream, min_len: u32) StreamError!ReserveInfo {
        if (self.closed) return StreamError.Invalid;
        return self.reserveLocked(min_len);
    }

    pub fn commitReserved(self: *Stream, len: u32) StreamError!void {
        if (self.closed) return StreamError.Invalid;

        var notify = false;
        defer self.finish(notify, 0);
        try self.commitReservedLocked(len, &notify);
    }

    pub fn commit(self: *Stream) StreamError!void {
        if (self.closed) return StreamError.Invalid;
        var notify = false;
        defer self.finish(notify, 0);
        if (self.reserved_active) return StreamError.Busy;
        try self.commitLocked(&notify);
    }

    pub fn getStats(self: *Stream) Stats {
        var out: Stats = undefined;
        out = self.stats;
        return out;
    }

    pub fn hasPendingBytes(self: *Stream) bool {
        return self.pending_len > 0;
    }

    /// Apply only runtime-safe options; creation-time fields are ignored.
    pub fn setOptions(self: *Stream, options: Options) StreamError!void {
        if (self.closed) return StreamError.Invalid;
        self.options.max_bytes = options.max_bytes;
        self.options.growth_policy = options.growth_policy;
        self.options.auto_commit_on_full = options.auto_commit_on_full;
    }

    pub fn close(self: *Stream) StreamError!void {
        var notify = false;
        if (self.closed) {
            return;
        }
        if (self.reserved_active) {
            return StreamError.Busy;
        }
        if (self.pending_len > 0) {
            try self.commitLocked(&notify);
        }
        self.closed = true;
        self.attached = false;
        self.finish(notify, 0);
        self.emitClosed();
    }

    pub fn destroy(self: *Stream) void {
        if (!self.closed) {
            _ = self.close() catch {};
        }
        for (self.chunks.items) |chunk| {
            self.allocator.free(chunk.ptr[0..@as(usize, chunk.len)]);
        }
        self.chunks.deinit(self.allocator);
        if (self.span_ring.capacity > 0) {
            self.allocator.free(self.span_ring.buffer);
        }
        if (self.state_capacity > 0) {
            self.allocator.free(self.state_buffer);
        }
        self.allocator.destroy(self);
    }

    pub fn drainSpans(self: *Stream, out: []SpanInfo) u32 {
        if (out.len == 0) return 0;
        const count = self.span_ring.popMany(out);
        self.stats.pending_spans = self.span_ring.count();
        return count;
    }

    pub fn hasPendingSpans(self: *Stream) bool {
        return self.span_ring.count() > 0;
    }

    pub fn stateBuffer(self: *Stream) []u8 {
        return self.state_buffer;
    }

    pub fn markChunkFree(self: *Stream, chunk_index: u32) void {
        if (chunk_index < self.state_capacity) {
            self.state_buffer[chunk_index] -|= 1;
        }
    }

    pub fn markSpanConsumed(self: *Stream, span: SpanInfo) void {
        self.markChunkFree(span.chunk_index);
    }

    pub fn finish(self: *Stream, notify: bool, queued_override: u32) void {
        if (notify and self.callback != null) {
            const queued = if (queued_override != 0)
                queued_override
            else
                self.span_ring.count();
            if (queued > 0) self.emitDataAvailable(queued);
        }
    }

    fn ensureStateCapacity(self: *Stream, required: u32) StreamError!void {
        if (required <= self.state_capacity) return;
        var new_capacity: u32 = if (self.state_capacity == 0) 1 else self.state_capacity;
        while (new_capacity < required) : (new_capacity *= 2) {}
        const new_buffer = self.allocator.alloc(u8, new_capacity) catch return StreamError.OutOfMemory;
        @memset(new_buffer, 0);
        if (self.state_capacity > 0) {
            std.mem.copyForwards(u8, new_buffer[0..self.state_capacity], self.state_buffer);
            self.allocator.free(self.state_buffer);
        }
        self.state_buffer = new_buffer;
        self.state_capacity = new_capacity;
        if (self.attached and self.callback != null) {
            self.emitStateBuffer();
        }
    }

    fn isChunkFree(self: *Stream, index: usize) bool {
        if (index >= self.state_capacity) return true;
        return self.state_buffer[index] == 0;
    }

    pub fn commitLocked(self: *Stream, notify: *bool) StreamError!void {
        if (self.pending_len == 0) return;
        const chunk = self.chunks.items[self.pending_chunk_index];
        const info: SpanInfo = .{
            .chunk_ptr = @intFromPtr(chunk.ptr),
            .offset = @intCast(self.pending_offset),
            .len = @intCast(self.pending_len),
            .chunk_index = @intCast(self.pending_chunk_index),
            .reserved = 0,
        };

        try self.span_ring.push(self, info, notify);
        self.markSpanPending(info.chunk_index);
        self.stats.spans_committed += 1;
        self.pending_len = 0;
        self.pending_offset = self.write_offset;
        self.pending_chunk_index = self.current_chunk_index;
    }

    fn markSpanPending(self: *Stream, chunk_index: u32) void {
        if (chunk_index < self.state_capacity) {
            self.state_buffer[chunk_index] +|= 1;
            // Avoid refcount saturation, which can corrupt data.
            if (self.state_buffer[chunk_index] == 255) {
                self.write_offset = self.options.chunk_size;
            }
        }
    }

    pub fn reserveLocked(self: *Stream, min_len: u32) StreamError!ReserveInfo {
        if (self.reserved_active) return StreamError.Busy;
        if (self.pending_len != 0) return StreamError.Busy;

        try self.ensureWritableChunkLocked();

        const chunk = self.chunks.items[self.current_chunk_index];
        const available = @as(usize, chunk.len) - self.write_offset;
        if (available < min_len) return StreamError.NoSpace;

        self.reserved_active = true;
        self.reserved_chunk_index = self.current_chunk_index;
        self.reserved_offset = self.write_offset;
        self.reserved_len = available;

        return .{
            .ptr = @intFromPtr(chunk.ptr + self.write_offset),
            .len = @intCast(available),
            .reserved = 0,
        };
    }

    pub fn commitReservedLocked(self: *Stream, len: u32, notify: *bool) StreamError!void {
        if (!self.reserved_active) return StreamError.Invalid;
        if (len > self.reserved_len) return StreamError.NoSpace;

        self.pending_chunk_index = self.reserved_chunk_index;
        self.pending_offset = self.reserved_offset;
        self.pending_len = len;
        self.write_offset = self.reserved_offset + len;
        self.reserved_active = false;
        self.reserved_len = 0;

        self.stats.bytes_written += @as(u64, len);

        try self.commitLocked(notify);
    }

    fn addChunkLocked(self: *Stream) StreamError!void {
        const chunk_size: u32 = self.options.chunk_size;
        const max_bytes = self.options.max_bytes;
        const allocated = @as(u64, self.chunks.items.len) * @as(u64, chunk_size);
        if (max_bytes != 0 and allocated + @as(u64, chunk_size) > max_bytes) {
            return StreamError.MaxBytes;
        }

        // Grow state buffer first to keep chunk/refcount in sync on failure.
        try self.ensureStateCapacity(@as(u32, @intCast(self.chunks.items.len)) + 1);

        const mem = self.allocator.alloc(u8, chunk_size) catch return StreamError.OutOfMemory;
        errdefer self.allocator.free(mem);
        const chunk: Chunk = .{ .ptr = mem.ptr, .len = chunk_size };
        self.chunks.append(self.allocator, chunk) catch return StreamError.OutOfMemory;
        self.stats.chunks = @intCast(self.chunks.items.len);
        if (self.attached and self.callback != null) {
            self.emitChunkAdded(chunk);
        }
    }

    fn ensureWritableChunkLocked(self: *Stream) StreamError!void {
        const total = self.chunks.items.len;
        if (total == 0) return StreamError.Invalid;

        var attempts: usize = 0;
        var index = self.current_chunk_index % total;
        while (attempts < total) : (attempts += 1) {
            if (self.isChunkFree(index)) {
                self.current_chunk_index = index;
                self.write_offset = 0;
                self.pending_chunk_index = index;
                self.pending_offset = 0;
                self.pending_len = 0;
                return;
            }
            index = (index + 1) % total;
        }

        if (self.options.growth_policy == @intFromEnum(GrowthPolicy.block)) {
            return StreamError.NoSpace;
        }

        try self.addChunkLocked();
        const new_total = self.chunks.items.len;
        if (new_total == 0) return StreamError.Invalid;
        self.current_chunk_index = new_total - 1;
        self.write_offset = 0;
        self.pending_chunk_index = self.current_chunk_index;
        self.pending_offset = 0;
        self.pending_len = 0;
    }

    fn emitChunkAdded(self: *Stream, chunk: Chunk) void {
        if (self.callback) |cb| {
            cb(@intFromPtr(self), Event.ChunkAdded, @intFromPtr(chunk.ptr), chunk.len);
        }
    }

    fn emitDataAvailable(self: *Stream, count: u32) void {
        if (self.callback) |cb| {
            cb(@intFromPtr(self), Event.DataAvailable, count, 0);
        }
    }

    fn emitStateBuffer(self: *Stream) void {
        if (self.callback) |cb| {
            cb(@intFromPtr(self), Event.StateBuffer, @intFromPtr(self.state_buffer.ptr), self.state_capacity);
        }
    }

    fn emitClosed(self: *Stream) void {
        if (self.callback) |cb| {
            cb(@intFromPtr(self), Event.Closed, 0, 0);
        }
    }
};

pub const default_pattern = "\x1b[32mnative-span-feed\x1b[0m\n";
const span_queue_capacity_default: u32 = 4096;
const notify_threshold_default: u32 = 1;

pub const EventId = enum(u32) {
    ChunkAdded = 2,
    Closed = 5,
    Error = 6,
    DataAvailable = 7,
    StateBuffer = 8,
};

const Event = struct {
    pub const ChunkAdded: u32 = @intFromEnum(EventId.ChunkAdded);
    pub const Closed: u32 = @intFromEnum(EventId.Closed);
    pub const Error: u32 = @intFromEnum(EventId.Error);
    pub const DataAvailable: u32 = @intFromEnum(EventId.DataAvailable);
    pub const StateBuffer: u32 = @intFromEnum(EventId.StateBuffer);
};

pub const Status = struct {
    pub const ok: i32 = 0;
    pub const err_no_space: i32 = -1;
    pub const err_max_bytes: i32 = -2;
    pub const err_invalid: i32 = -3;
    pub const err_alloc: i32 = -4;
    pub const err_busy: i32 = -5;
};

pub const StreamError = error{
    NoSpace,
    MaxBytes,
    Invalid,
    OutOfMemory,
    Busy,
};

pub fn defaultOptions() Options {
    return .{
        .chunk_size = 64 * 1024,
        .initial_chunks = 2,
        .max_bytes = 0,
        .growth_policy = @intFromEnum(GrowthPolicy.grow),
        .auto_commit_on_full = 1,
        .span_queue_capacity = 0,
    };
}

pub fn normalizeOptions(opts: Options) Options {
    var out = opts;
    if (out.chunk_size == 0) out.chunk_size = 64 * 1024;
    if (out.initial_chunks == 0) out.initial_chunks = 1;
    if (out.span_queue_capacity == 0) out.span_queue_capacity = span_queue_capacity_default;
    return out;
}

fn errorToStatus(err: StreamError) i32 {
    return switch (err) {
        StreamError.NoSpace => Status.err_no_space,
        StreamError.MaxBytes => Status.err_max_bytes,
        StreamError.Invalid => Status.err_invalid,
        StreamError.OutOfMemory => Status.err_alloc,
        StreamError.Busy => Status.err_busy,
    };
}

pub fn createNativeSpanFeedWithAllocator(allocator: std.mem.Allocator, options_ptr: ?*const Options) ?*Stream {
    const opts = normalizeOptions(if (options_ptr) |p| p.* else defaultOptions());
    return Stream.create(allocator, opts) catch null;
}

pub export fn streamSetCallback(stream: ?*Stream, callback: ?*const CallbackFn) void {
    if (stream == null) return;
    stream.?.setCallback(callback);
}

pub export fn attachNativeSpanFeed(stream: ?*Stream) i32 {
    if (stream == null) return Status.err_invalid;
    const s = stream.?;
    s.attach() catch |err| return errorToStatus(err);
    return Status.ok;
}

pub export fn streamClose(stream: ?*Stream) i32 {
    if (stream == null) return Status.err_invalid;
    const s = stream.?;
    s.close() catch |err| return errorToStatus(err);
    return Status.ok;
}

pub export fn destroyNativeSpanFeed(stream: ?*Stream) void {
    if (stream == null) return;
    const s = stream.?;
    s.destroy();
}

/// Copy API: copies len bytes from src_ptr into the stream's chunk pool.
/// Handles spanning across multiple chunks automatically. If auto_commit_on_full
/// is enabled, commits and emits DataAvailable each time a chunk fills.
/// Best for producers that already have data in a buffer (formatted output,
/// serialized messages, file contents).
/// When auto_commit_on_full is disabled, writes are all-or-nothing per
/// chunk boundary: a write that fits in the remaining space succeeds,
/// but a write that would exceed it returns err_no_space without writing
/// any bytes. A write that exactly fills the chunk succeeds; the next
/// write will move to a new chunk (committing the full one first).
pub export fn streamWrite(stream: ?*Stream, src_ptr: ?[*]const u8, len: u32) i32 {
    if (stream == null) return Status.err_invalid;
    const s = stream.?;
    if (len == 0) return Status.ok;
    if (src_ptr == null) return Status.err_invalid;
    const src = src_ptr.?[0..@as(usize, len)];
    s.write(src) catch |err| return errorToStatus(err);
    return Status.ok;
}

/// Commits the pending span accumulated by streamWrite and emits DataAvailable.
/// Only needed when auto_commit_on_full is disabled or to flush a partially
/// filled chunk.
pub export fn streamCommit(stream: ?*Stream) i32 {
    if (stream == null) return Status.err_invalid;
    const s = stream.?;
    s.commit() catch |err| return errorToStatus(err);
    return Status.ok;
}

/// Zero-copy API: returns a pointer and available length for direct writes
/// into the current chunk's memory. The caller writes directly into this
/// region (no memcpy) and then calls streamCommitReserved with the number
/// of bytes actually written.
/// Best for producers that can format output in place (e.g., serializing
/// directly into the chunk buffer). Only one reservation can be active at
/// a time; the stream is locked until streamCommitReserved is called.
/// Returns at most one chunk's worth of available space.
pub export fn streamReserve(stream: ?*Stream, min_len: u32, out_ptr: ?*ReserveInfo) i32 {
    if (stream == null or out_ptr == null) return Status.err_invalid;
    const s = stream.?;
    const info = s.reserve(min_len) catch |err| return errorToStatus(err);
    out_ptr.?.* = info;
    return Status.ok;
}

/// Commits len bytes of the previously reserved region and emits DataAvailable.
/// Must be called after streamReserve. len must not exceed the reserved length.
pub export fn streamCommitReserved(stream: ?*Stream, len: u32) i32 {
    if (stream == null) return Status.err_invalid;
    const s = stream.?;
    s.commitReserved(len) catch |err| return errorToStatus(err);
    return Status.ok;
}

pub export fn streamSetOptions(stream: ?*Stream, options_ptr: ?*const Options) i32 {
    if (stream == null or options_ptr == null) return Status.err_invalid;
    const s = stream.?;
    s.setOptions(options_ptr.?.*) catch |err| return errorToStatus(err);
    return Status.ok;
}

pub export fn streamGetStats(stream: ?*Stream, stats_ptr: ?*Stats) i32 {
    if (stream == null or stats_ptr == null) return Status.err_invalid;
    const s = stream.?;
    stats_ptr.?.* = s.getStats();
    return Status.ok;
}

pub export fn streamDrainSpans(stream: ?*Stream, out_ptr: ?*SpanInfo, max_spans: u32) u32 {
    if (stream == null or out_ptr == null or max_spans == 0) return 0;
    const s = stream.?;
    const out = @as([*]SpanInfo, @ptrCast(out_ptr.?))[0..max_spans];
    return s.drainSpans(out);
}
