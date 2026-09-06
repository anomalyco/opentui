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
    outstanding_spans: u32,
    reserved: u32 = 0,
    outstanding_bytes: u64,
};

const Chunk = struct {
    ptr: [*]u8,
    len: u32,
    refcount: u8 = 0,
};

pub const SpanInfo = extern struct {
    chunk_ptr: usize,
    offset: u32,
    len: u32,
    chunk_index: u32,
    slot_index: u32 = 0,
    release_id: u64 = 0,

    pub fn slice(self: SpanInfo) []u8 {
        const base: [*]u8 = @ptrFromInt(self.chunk_ptr);
        const start: usize = @intCast(self.offset);
        const length: usize = @intCast(self.len);
        return base[start .. start + length];
    }
};

const SpanRing = struct {
    const none = std.math.maxInt(u32);
    const Entry = struct {
        span: SpanInfo = undefined,
        next: u32 = none,
        state: enum { free, queued, borrowed } = .free,
    };

    buffer: []Entry,
    capacity: u32,
    head: u32 = none,
    tail: u32 = none,
    free_head: u32 = none,
    queued: u32 = 0,
    borrowed: u32 = 0,
    bytes: u64 = 0,
    next_id: u64 = 1,

    pub fn count(self: *SpanRing) u32 {
        return self.queued;
    }

    fn grow(self: *SpanRing, stream: *Stream) StreamError!void {
        if (stream.bounded()) {
            return StreamError.NoSpace;
        }

        const old_capacity = self.capacity;
        const new_capacity = std.math.mul(u32, old_capacity, 2) catch return StreamError.NoSpace;
        const new_buffer = stream.allocator.alloc(Entry, new_capacity) catch return StreamError.OutOfMemory;
        @memcpy(new_buffer[0..old_capacity], self.buffer);
        for (old_capacity..new_capacity) |index| {
            new_buffer[index] = .{
                .next = if (index + 1 < new_capacity) @intCast(index + 1) else self.free_head,
            };
        }

        stream.allocator.free(self.buffer);
        self.buffer = new_buffer;
        self.capacity = new_capacity;
        self.free_head = old_capacity;
    }

    pub fn push(self: *SpanRing, stream: *Stream, span: SpanInfo, notify: *bool) StreamError!void {
        try self.ensureAdditionalCapacity(stream, 1);
        const index = self.free_head;
        const entry = &self.buffer[index];
        std.debug.assert(entry.state == .free);
        self.free_head = entry.next;
        entry.* = .{ .span = span, .state = .queued };
        entry.span.slot_index = index;
        entry.span.release_id = self.next_id;
        self.next_id += 1;
        if (self.tail == none) {
            self.head = index;
        } else {
            self.buffer[self.tail].next = index;
        }
        self.tail = index;
        self.queued += 1;
        self.bytes += span.len;
        if (stream.attached and stream.callback != null and self.queued == 1) notify.* = true;
    }

    fn ensureAdditionalCapacity(self: *SpanRing, stream: *Stream, additional: u32) StreamError!void {
        const unpublished = @as(u64, additional) + stream.control_chunks - stream.control_spans;
        // IDs never wrap, including after a slot is reused or storage grows.
        _ = std.math.add(u64, self.next_id, additional) catch return StreamError.NoSpace;
        const required = @as(u64, self.queued) + self.borrowed + unpublished;
        while (required > self.capacity) try self.grow(stream);
    }

    pub fn popMany(self: *SpanRing, out: []SpanInfo) u32 {
        const to_read: u32 = @intCast(@min(self.queued, out.len));
        for (out[0..to_read]) |*span| {
            const entry = &self.buffer[self.head];
            std.debug.assert(entry.state == .queued);
            span.* = entry.span;
            entry.state = .borrowed;
            self.head = entry.next;
        }
        self.queued -= to_read;
        self.borrowed += to_read;
        if (self.queued == 0) self.tail = none;
        return to_read;
    }

    fn release(self: *SpanRing, slot_index: u32, release_id: u64) StreamError!SpanInfo {
        if (slot_index >= self.capacity) return StreamError.Invalid;
        const entry = &self.buffer[slot_index];
        if (entry.state != .borrowed or entry.span.release_id != release_id) {
            return StreamError.Invalid;
        }
        const span = entry.span;
        entry.state = .free;
        entry.next = self.free_head;
        self.free_head = slot_index;
        self.borrowed -= 1;
        self.bytes -= span.len;
        return span;
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

pub const ControlSequenceReservation = struct {
    bytes: u64 = 0,
    spans: u64 = 0,
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
    in_callback: bool,
    producing: bool,
    closed: bool,
    span_ring: SpanRing,
    staged_bytes: usize,
    control_chunks: u32 = 0,
    control_spans: u32 = 0,
    control_bytes: u64 = 0,
    control_sequence: ControlSequenceReservation = .{},
    stats: Stats,

    const Admission = enum { ordinary, reserved_control, control_capacity };

    pub fn create(allocator: std.mem.Allocator, options: ?Options) StreamError!*Stream {
        const opts = normalizeOptions(options orelse defaultOptions());
        if (opts.growth_policy > @intFromEnum(GrowthPolicy.block)) return StreamError.Invalid;
        if (opts.max_bytes != 0 and @as(u64, opts.initial_chunks) * opts.chunk_size > opts.max_bytes) {
            return StreamError.MaxBytes;
        }
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
            .in_callback = false,
            .producing = false,
            .closed = false,
            .span_ring = .{
                .buffer = &.{},
                .capacity = 0,
            },
            .staged_bytes = 0,
            .stats = .{
                .bytes_written = 0,
                .spans_committed = 0,
                .chunks = 0,
                .pending_spans = 0,
                .outstanding_spans = 0,
                .outstanding_bytes = 0,
            },
        };

        errdefer stream.destroy();

        const ring_capacity = opts.span_queue_capacity;
        const ring_buffer = allocator.alloc(SpanRing.Entry, ring_capacity) catch return StreamError.OutOfMemory;
        for (ring_buffer, 0..) |*entry, index| {
            entry.* = .{ .next = if (index + 1 < ring_capacity) @intCast(index + 1) else SpanRing.none };
        }
        stream.span_ring = .{
            .buffer = ring_buffer,
            .capacity = ring_capacity,
            .free_head = 0,
        };

        const initial = @as(usize, opts.initial_chunks);
        var i: usize = 0;
        while (i < initial) : (i += 1) {
            try stream.addChunkLocked();
        }
        stream.stats.chunks = @intCast(stream.chunks.items.len);
        return stream;
    }

    pub fn attach(self: *Stream) StreamError!void {
        if (self.producing) return StreamError.Busy;
        if (self.closed) return StreamError.Invalid;

        var notify = false;
        var queued: u32 = 0;
        defer self.finish(notify, queued);

        self.attached = true;
        if (self.callback == null) return;

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

        for (self.chunks.items) |chunk| {
            self.emitChunkAdded(chunk);
        }
        const queued = self.span_ring.count();
        if (queued > 0) {
            self.emitDataAvailable(queued);
        }
    }

    /// Install once, while idle: no queued, borrowed, pending, reserved, or staged output.
    /// Hold ceil(bytes / chunk_size) chunks, ring slots, and chunk-rounded byte capacity
    /// for one control publication. Storage must already exist; this does not allocate.
    /// Configure this before attaching a renderer.
    pub fn reserveControlCapacity(self: *Stream, bytes: usize) StreamError!void {
        if (self.producing) return StreamError.Busy;
        if (self.closed) return StreamError.Invalid;
        if (self.control_chunks != 0 or self.pending_len != 0 or self.reserved_active or
            self.staged_bytes != 0 or self.span_ring.queued != 0 or self.span_ring.borrowed != 0)
        {
            return StreamError.Busy;
        }
        if (bytes == 0) return StreamError.Invalid;
        const count = std.math.divCeil(usize, bytes, self.options.chunk_size) catch return StreamError.NoSpace;
        const required = std.math.cast(u32, count) orelse return StreamError.NoSpace;
        const storage_bytes = std.math.mul(usize, count, self.options.chunk_size) catch return StreamError.NoSpace;
        try self.checkAdmission(storage_bytes, required, .control_capacity);
        if (count > self.chunks.items.len or required > self.span_ring.capacity) return StreamError.NoSpace;
        self.control_chunks = required;
        // The current chunk may now belong to control output. Advance before normal writes.
        self.write_offset = self.options.chunk_size;
        self.pending_offset = self.write_offset;
    }

    /// Set independent byte-counter and release-ID headroom for remaining packets.
    /// Requires installed control capacity and does not allocate storage.
    /// Count spans per packet: sum ceil(packet.len / chunk_size), not ceil(total bytes
    /// / chunk_size). Both counts must be nonzero, or both zero to clear the reservation.
    /// Queued or borrowed raw output is allowed; unfinished producers or controls are not.
    pub fn setControlSequenceReservation(self: *Stream, reservation: ControlSequenceReservation) StreamError!void {
        if (self.producing) return StreamError.Busy;
        if (self.closed) return StreamError.Invalid;
        if (self.pending_len != 0 or self.reserved_active or self.staged_bytes != 0 or
            self.control_spans != 0)
        {
            return StreamError.Busy;
        }
        if ((reservation.bytes == 0) != (reservation.spans == 0)) return StreamError.Invalid;
        if (reservation.bytes != 0 and self.control_chunks == 0) return StreamError.Invalid;
        if (reservation.bytes > std.math.maxInt(u64) - self.stats.bytes_written or
            reservation.spans > std.math.maxInt(u64) - self.span_ring.next_id)
        {
            return StreamError.NoSpace;
        }
        self.control_sequence = reservation;
    }

    pub fn write(self: *Stream, data: []const u8) StreamError!void {
        if (self.producing) return StreamError.Busy;
        if (self.closed) return StreamError.Invalid;
        if (data.len == 0) return;
        if (self.reserved_active) return StreamError.Busy;

        var notify = false;
        // finish() must run on success and error so committed spans notify.
        defer self.finish(notify, 0);
        self.producing = true;
        defer self.producing = false;

        var remaining = data.len;
        var src_index: usize = 0;
        const auto_commit = self.options.auto_commit_on_full != 0;
        const chunk_len = self.options.chunk_size;

        while (remaining > 0) {
            if (self.pending_len == 0) try self.checkAdmission(0, 1, .ordinary);
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
            try self.checkAdmission(to_write, if (self.pending_len == 0) 1 else 0, .ordinary);
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

    /// Publish one complete byte sequence or nothing. Renderer frames use this
    /// so a capacity/allocation failure cannot expose a truncated ANSI sequence.
    pub fn writeAtomic(self: *Stream, data: []const u8) StreamError!void {
        const notify = try self.writeAtomicUnnotified(data);
        self.finish(notify, 0);
    }

    /// The caller finishes its publication state before delivering DataAvailable.
    pub fn writeAtomicUnnotified(self: *Stream, data: []const u8) StreamError!bool {
        return self.publishAtomic(data, .ordinary);
    }

    /// Publish one packet using reusable control storage and sequence headroom.
    /// Only success consumes the packet's bytes and spans from the reservation.
    /// All prior control spans must be released before the next packet.
    pub fn writeReservedControlAtomic(self: *Stream, data: []const u8) StreamError!void {
        const notify = try self.publishAtomic(data, .reserved_control);
        self.finish(notify, 0);
    }

    fn publishAtomic(self: *Stream, data: []const u8, comptime kind: Admission) StreamError!bool {
        std.debug.assert(kind != .control_capacity);
        const control = kind != .ordinary;
        if (self.producing) return StreamError.Busy;
        if (self.closed) return StreamError.Invalid;
        if (data.len == 0) return false;
        if (self.reserved_active or self.pending_len != 0) return StreamError.Busy;
        if (control) {
            if (self.control_chunks == 0) return StreamError.Invalid;
            if (self.staged_bytes != 0 or self.control_spans != 0) return StreamError.Busy;
        }
        self.producing = true;
        defer self.producing = false;

        const chunk_size = @as(usize, self.options.chunk_size);
        const required_chunks_usize = std.math.divCeil(usize, data.len, chunk_size) catch return StreamError.Invalid;
        const required_chunks = std.math.cast(u32, required_chunks_usize) orelse return StreamError.NoSpace;
        if (kind == .reserved_control) {
            if (data.len > self.control_sequence.bytes or required_chunks > self.control_sequence.spans) {
                return StreamError.NoSpace;
            }
        }
        if (control) {
            if (required_chunks > self.control_chunks) return StreamError.NoSpace;
            self.control_spans = required_chunks;
            self.control_bytes = data.len;
        }
        errdefer if (control) {
            self.control_spans = 0;
            self.control_bytes = 0;
        };
        try self.checkAdmission(data.len, required_chunks, kind);
        try self.span_ring.ensureAdditionalCapacity(self, required_chunks);

        if (!control) {
            var free_chunks: usize = 0;
            for (0..self.chunks.items.len) |index| {
                if (self.isChunkFree(index)) free_chunks += 1;
            }
            if (free_chunks < required_chunks_usize) {
                if (self.options.growth_policy == @intFromEnum(GrowthPolicy.block)) return StreamError.NoSpace;
                var missing = required_chunks_usize - free_chunks;
                while (missing > 0) : (missing -= 1) try self.addChunkLocked();
            }
        }

        var notify = false;
        var source_offset: usize = 0;
        var last_chunk_index: usize = self.current_chunk_index;
        for (self.chunks.items, 0..) |chunk, index| {
            if (control) {
                std.debug.assert(index < self.control_chunks and chunk.refcount == 0);
            } else if (!self.isChunkFree(index)) continue;
            const len = @min(chunk_size, data.len - source_offset);
            @memcpy(chunk.ptr[0..len], data[source_offset .. source_offset + len]);
            const info: SpanInfo = .{
                .chunk_ptr = @intFromPtr(chunk.ptr),
                .offset = 0,
                .len = @intCast(len),
                .chunk_index = @intCast(index),
            };
            // Capacity was secured before the first byte was copied.
            self.span_ring.push(self, info, &notify) catch unreachable;
            self.markSpanPending(info.chunk_index);
            self.stats.spans_committed += 1;
            source_offset += len;
            last_chunk_index = index;
            if (source_offset == data.len) break;
        }
        std.debug.assert(source_offset == data.len);
        if (!control) {
            self.current_chunk_index = last_chunk_index;
            self.write_offset = @as(usize, self.chunks.items[last_chunk_index].len);
            self.pending_chunk_index = last_chunk_index;
            self.pending_offset = self.write_offset;
            self.pending_len = 0;
        }
        self.stats.bytes_written += data.len;
        if (kind == .reserved_control) {
            self.control_sequence.bytes -= data.len;
            self.control_sequence.spans -= required_chunks;
        }
        return notify;
    }

    pub fn reserve(self: *Stream, min_len: u32) StreamError!ReserveInfo {
        if (self.producing) return StreamError.Busy;
        if (self.closed) return StreamError.Invalid;
        self.producing = true;
        defer self.producing = false;
        return self.reserveLocked(min_len);
    }

    pub fn commitReserved(self: *Stream, len: u32) StreamError!void {
        if (self.producing) return StreamError.Busy;
        if (self.closed) return StreamError.Invalid;

        var notify = false;
        defer self.finish(notify, 0);
        try self.commitReservedLocked(len, &notify);
    }

    pub fn commit(self: *Stream) StreamError!void {
        if (self.producing) return StreamError.Busy;
        if (self.closed) return StreamError.Invalid;
        var notify = false;
        defer self.finish(notify, 0);
        if (self.reserved_active) return StreamError.Busy;
        try self.commitLocked(&notify);
    }

    pub fn getStats(self: *Stream) Stats {
        var out = self.stats;
        out.pending_spans = self.span_ring.queued;
        out.outstanding_spans = self.span_ring.queued + self.span_ring.borrowed;
        out.outstanding_bytes = self.span_ring.bytes;
        return out;
    }

    pub fn bounded(self: *Stream) bool {
        return self.options.max_bytes != 0 or
            self.options.growth_policy == @intFromEnum(GrowthPolicy.block);
    }

    pub fn byteLimit(self: *Stream) u64 {
        if (self.options.growth_policy == @intFromEnum(GrowthPolicy.block)) {
            const pool_bytes = @as(u64, self.options.chunk_size) * self.chunks.items.len;
            return if (self.options.max_bytes == 0) pool_bytes else @min(pool_bytes, self.options.max_bytes);
        }
        return self.options.max_bytes;
    }

    /// Empty-queue ordinary atomic capacity, excluding reserved control chunks and slots.
    pub fn atomicByteLimit(self: *Stream) u64 {
        std.debug.assert(self.bounded());
        const chunks = @min(self.byteLimit() / self.options.chunk_size, self.options.span_queue_capacity);
        return (chunks -| self.control_chunks) * self.options.chunk_size;
    }

    fn stagedSpans(self: *Stream) u64 {
        return std.math.divCeil(u64, self.staged_bytes, self.options.chunk_size) catch unreachable;
    }

    fn controlHeldBytes(self: *Stream) u64 {
        return @as(u64, self.control_chunks) * self.options.chunk_size - self.control_bytes;
    }

    fn checkAdmission(self: *Stream, bytes: usize, spans: u32, comptime kind: Admission) StreamError!void {
        const producer_span: u64 = if (self.pending_len > 0 or self.reserved_active) 1 else 0;
        const control_slots = self.control_chunks - self.control_spans;
        // Sequence packets reuse storage, but each packet needs fresh release IDs.
        const held_ids = if (kind == .reserved_control)
            self.control_sequence.spans - spans
        else
            @max(self.control_sequence.spans, control_slots);
        var remaining_ids = std.math.maxInt(u64) - self.span_ring.next_id;
        for ([_]u64{ producer_span, self.stagedSpans(), spans, held_ids }) |used| {
            if (used > remaining_ids) return StreamError.NoSpace;
            remaining_ids -= used;
        }
        const required_spans = std.math.add(
            u64,
            @as(u64, self.span_ring.queued) + self.span_ring.borrowed + producer_span + spans + control_slots,
            self.stagedSpans(),
        ) catch return StreamError.NoSpace;
        if (self.bounded() and required_spans > self.options.span_queue_capacity) {
            return StreamError.NoSpace;
        }
        if (kind != .control_capacity) {
            const held_bytes = if (kind == .reserved_control)
                self.control_sequence.bytes - bytes
            else
                self.control_sequence.bytes;
            var remaining_bytes = std.math.maxInt(u64) - self.stats.bytes_written;
            // Pending raw bytes are already counted; staging and direct borrows are not.
            for ([_]u64{ held_bytes, self.staged_bytes, self.reserved_len, bytes }) |used| {
                if (used > remaining_bytes) return StreamError.NoSpace;
                remaining_bytes -= used;
            }
        }
        const max_bytes = self.byteLimit();
        if (max_bytes == 0) return;
        var remaining = max_bytes;
        for ([_]u64{ self.controlHeldBytes(), self.span_ring.bytes, self.pending_len, self.reserved_len, self.staged_bytes, bytes }) |used| {
            if (used > remaining) {
                return if (self.options.growth_policy == @intFromEnum(GrowthPolicy.block))
                    StreamError.NoSpace
                else
                    StreamError.MaxBytes;
            }
            remaining -= used;
        }
    }

    /// Check storage for at least one ordinary atomic byte without allocating.
    pub fn hasAtomicCapacity(self: *Stream) bool {
        self.checkAdmission(1, 1, .ordinary) catch return false;
        for (0..self.chunks.items.len) |index| {
            if (self.isChunkFree(index)) return true;
        }
        if (self.options.growth_policy == @intFromEnum(GrowthPolicy.block)) return false;
        if (self.chunks.items.len == std.math.maxInt(u32)) return false;
        const grown_bytes = (@as(u64, self.chunks.items.len) + 1) * self.options.chunk_size;
        return self.options.max_bytes == 0 or grown_bytes <= self.options.max_bytes;
    }

    pub fn setStagedBytes(self: *Stream, bytes: usize) StreamError!void {
        if (self.producing) return StreamError.Busy;
        if (bytes <= self.staged_bytes) {
            self.staged_bytes = bytes;
            return;
        }
        if (self.closed) return StreamError.Invalid;
        const spans = std.math.divCeil(u64, bytes, self.options.chunk_size) catch return StreamError.NoSpace;
        const additional = std.math.cast(u32, spans - self.stagedSpans()) orelse return StreamError.NoSpace;
        try self.checkAdmission(bytes - self.staged_bytes, additional, .ordinary);
        self.staged_bytes = bytes;
    }

    pub fn hasPendingBytes(self: *Stream) bool {
        return self.pending_len > 0;
    }

    /// Apply only runtime-safe options; creation-time fields are ignored.
    pub fn setOptions(self: *Stream, options: Options) StreamError!void {
        if (self.producing) return StreamError.Busy;
        if (self.closed) return StreamError.Invalid;
        if (options.growth_policy > @intFromEnum(GrowthPolicy.block)) return StreamError.Invalid;
        if (options.max_bytes != 0 and
            @as(u64, self.chunks.items.len) * self.options.chunk_size > options.max_bytes)
        {
            return StreamError.MaxBytes;
        }
        const previous = self.options;
        self.options.max_bytes = options.max_bytes;
        self.options.growth_policy = options.growth_policy;
        self.checkAdmission(0, 0, .ordinary) catch |err| {
            self.options = previous;
            return err;
        };
        self.options.auto_commit_on_full = options.auto_commit_on_full;
    }

    pub fn close(self: *Stream) StreamError!void {
        if (self.producing) return StreamError.Busy;
        var notify = false;
        if (self.closed) {
            return;
        }
        if (self.reserved_active or self.staged_bytes != 0) {
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
        self.tryDestroy() catch @panic("Cannot destroy a stream with outstanding borrows");
    }

    pub fn tryDestroy(self: *Stream) StreamError!void {
        if (self.in_callback or self.producing or self.span_ring.borrowed != 0 or self.reserved_active or self.staged_bytes != 0) {
            return StreamError.Busy;
        }
        if (!self.closed) {
            try self.close();
        }
        // Closing can synchronously notify a consumer that borrows more spans.
        if (self.span_ring.borrowed != 0) {
            return StreamError.Busy;
        }
        for (self.chunks.items) |chunk| {
            self.allocator.free(chunk.ptr[0..@as(usize, chunk.len)]);
        }
        self.chunks.deinit(self.allocator);
        if (self.span_ring.capacity > 0) {
            self.allocator.free(self.span_ring.buffer);
        }
        self.allocator.destroy(self);
    }

    pub fn drainSpans(self: *Stream, out: []SpanInfo) u32 {
        if (out.len == 0) return 0;
        return self.span_ring.popMany(out);
    }

    pub fn hasPendingSpans(self: *Stream) bool {
        return self.span_ring.count() > 0;
    }

    pub fn releaseSpan(self: *Stream, slot_index: u32, release_id: u64) StreamError!void {
        const span = try self.span_ring.release(slot_index, release_id);
        const chunk = &self.chunks.items[span.chunk_index];
        std.debug.assert(chunk.refcount > 0);
        chunk.refcount -= 1;
        if (span.chunk_index < self.control_chunks) {
            self.control_spans -= 1;
            self.control_bytes -= span.len;
        }
    }

    pub fn markSpanConsumed(self: *Stream, span: SpanInfo) void {
        self.releaseSpan(span.slot_index, span.release_id) catch {};
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

    fn isChunkFree(self: *Stream, index: usize) bool {
        return index >= self.control_chunks and self.chunks.items[index].refcount == 0;
    }

    pub fn commitLocked(self: *Stream, notify: *bool) StreamError!void {
        if (self.pending_len == 0) return;
        const chunk = self.chunks.items[self.pending_chunk_index];
        const info: SpanInfo = .{
            .chunk_ptr = @intFromPtr(chunk.ptr),
            .offset = @intCast(self.pending_offset),
            .len = @intCast(self.pending_len),
            .chunk_index = @intCast(self.pending_chunk_index),
        };

        try self.span_ring.push(self, info, notify);
        self.markSpanPending(info.chunk_index);
        self.stats.spans_committed += 1;
        self.pending_len = 0;
        self.pending_offset = self.write_offset;
        self.pending_chunk_index = self.current_chunk_index;
    }

    fn markSpanPending(self: *Stream, chunk_index: u32) void {
        const chunk = &self.chunks.items[chunk_index];
        std.debug.assert(chunk.refcount < 255);
        chunk.refcount += 1;
        if (chunk.refcount == 255) {
            self.write_offset = self.options.chunk_size;
        }
    }

    pub fn reserveLocked(self: *Stream, min_len: u32) StreamError!ReserveInfo {
        if (self.reserved_active) return StreamError.Busy;
        if (self.pending_len != 0) return StreamError.Busy;
        try self.checkAdmission(min_len, 1, .ordinary);

        try self.ensureWritableChunkLocked();

        const chunk = self.chunks.items[self.current_chunk_index];
        var available = @as(usize, chunk.len) - self.write_offset;
        const counter_bytes = std.math.maxInt(u64) - self.stats.bytes_written -
            self.control_sequence.bytes - self.staged_bytes;
        available = @intCast(@min(available, counter_bytes));
        const max_bytes = self.byteLimit();
        if (max_bytes != 0) {
            const used = self.span_ring.bytes + self.staged_bytes + self.controlHeldBytes();
            available = @intCast(@min(available, max_bytes - used));
        }
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

        if (self.chunks.items.len == std.math.maxInt(u32)) return StreamError.NoSpace;

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
        const was_producing = self.producing;
        self.producing = true;
        defer self.producing = was_producing;
        self.emitEvent(Event.ChunkAdded, @intFromPtr(chunk.ptr), chunk.len);
    }

    fn emitDataAvailable(self: *Stream, count: u32) void {
        self.emitEvent(Event.DataAvailable, count, 0);
    }

    fn emitClosed(self: *Stream) void {
        self.emitEvent(Event.Closed, 0, 0);
    }

    fn emitEvent(self: *Stream, event: u32, arg0: usize, arg1: u64) void {
        const callback = self.callback orelse return;
        const was_in_callback = self.in_callback;
        self.in_callback = true;
        defer self.in_callback = was_in_callback;
        callback(@intFromPtr(self), event, arg0, arg1);
    }
};

pub const default_pattern = "\x1b[32mnative-span-feed\x1b[0m\n";
const span_queue_capacity_default: u32 = 4096;

pub const EventId = enum(u32) {
    ChunkAdded = 2,
    Closed = 5,
    Error = 6,
    DataAvailable = 7,
};

const Event = struct {
    pub const ChunkAdded: u32 = @intFromEnum(EventId.ChunkAdded);
    pub const Closed: u32 = @intFromEnum(EventId.Closed);
    pub const Error: u32 = @intFromEnum(EventId.Error);
    pub const DataAvailable: u32 = @intFromEnum(EventId.DataAvailable);
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

pub export fn destroyNativeSpanFeed(stream: ?*Stream) i32 {
    if (stream == null) return Status.err_invalid;
    const s = stream.?;
    s.tryDestroy() catch |err| return errorToStatus(err);
    return Status.ok;
}

pub export fn streamReleaseSpan(stream: ?*Stream, slot_index: u32, release_id: u64) i32 {
    const s = stream orelse return Status.err_invalid;
    s.releaseSpan(slot_index, release_id) catch |err| return errorToStatus(err);
    return Status.ok;
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
