const std = @import("std");
const Allocator = std.mem.Allocator;
const buffer = @import("buffer.zig");
const events = @import("event-emitter.zig");
const link = @import("link.zig");
const ansi = @import("ansi.zig");

pub const RGBA = buffer.RGBA;

/// Foreground, background, and text attributes for a syntax highlight style.
/// Color intent (rgb, indexed, default) is embedded in the RGBA values.
pub const StyleDefinition = struct {
    fg: ?RGBA,
    bg: ?RGBA,
    attributes: u32,
};

pub const SyntaxStyleError = error{
    OutOfMemory,
    InvalidId,
    StyleNotFound,
};

pub const Event = enum { Destroy };

pub const SyntaxStyle = struct {
    allocator: Allocator,
    global_allocator: Allocator,
    arena: *std.heap.ArenaAllocator,

    name_to_id: std.StringHashMapUnmanaged(u32),
    id_to_style: std.AutoHashMapUnmanaged(u32, StyleDefinition),
    next_id: u32,

    merged_cache: std.StringHashMapUnmanaged(StyleDefinition),

    emitter: events.EventEmitter(Event),
    link_tracker: ?link.LinkTracker = null,

    pub fn init(global_allocator: Allocator) SyntaxStyleError!*SyntaxStyle {
        const self = global_allocator.create(SyntaxStyle) catch return SyntaxStyleError.OutOfMemory;
        errdefer global_allocator.destroy(self);

        const internal_arena = global_allocator.create(std.heap.ArenaAllocator) catch return SyntaxStyleError.OutOfMemory;
        errdefer global_allocator.destroy(internal_arena);
        internal_arena.* = std.heap.ArenaAllocator.init(global_allocator);

        const internal_allocator = internal_arena.allocator();

        self.* = .{
            .allocator = internal_allocator,
            .global_allocator = global_allocator,
            .arena = internal_arena,
            .name_to_id = .empty,
            .id_to_style = .empty,
            .next_id = 1, // Start from 1, 0 can be used as "invalid"
            .merged_cache = .empty,
            // Subscriptions survive replacement of the definition arena.
            .emitter = events.EventEmitter(Event).init(global_allocator),
        };

        return self;
    }

    pub fn deinit(self: *SyntaxStyle) void {
        const global_allocator = self.global_allocator;
        defer global_allocator.destroy(self);

        self.emitter.emit(.Destroy);
        self.emitter.deinit();
        if (self.link_tracker) |*tracker| tracker.deinit();
        self.arena.deinit();
        global_allocator.destroy(self.arena);
        self.* = undefined;
    }

    /// A provisional copy without subscriptions; retain its links before publication.
    pub fn prepareDefinitions(self: *const SyntaxStyle) SyntaxStyleError!*SyntaxStyle {
        const prepared = try SyntaxStyle.init(self.global_allocator);
        errdefer prepared.deinit();
        try prepared.name_to_id.ensureTotalCapacity(prepared.allocator, self.name_to_id.count());
        try prepared.id_to_style.ensureTotalCapacity(prepared.allocator, self.id_to_style.count());
        var names = self.name_to_id.iterator();
        while (names.next()) |entry| {
            const name = try prepared.allocator.dupe(u8, entry.key_ptr.*);
            prepared.name_to_id.putAssumeCapacity(name, entry.value_ptr.*);
        }
        var definitions = self.id_to_style.iterator();
        while (definitions.next()) |entry| prepared.id_to_style.putAssumeCapacity(entry.key_ptr.*, entry.value_ptr.*);
        prepared.next_id = self.next_id;
        return prepared;
    }

    /// Shared definitions can outlive the document that introduced their URLs.
    pub fn retainLinks(self: *SyntaxStyle, pool: *link.LinkPool) !void {
        std.debug.assert(self.link_tracker == null);
        self.link_tracker = link.LinkTracker.init(self.global_allocator, pool);
        var definitions = self.id_to_style.valueIterator();
        while (definitions.next()) |definition| {
            const id = ansi.TextAttributes.getLinkId(definition.attributes);
            if (id == 0) continue;
            const url = try pool.get(id);
            const retained = try self.link_tracker.?.trackUrl(url);
            std.debug.assert(retained == id);
        }
    }

    /// Keep identity and destroy subscriptions; retire old definitions with prepared.
    pub fn publishDefinitions(self: *SyntaxStyle, prepared: *SyntaxStyle) void {
        std.debug.assert(self != prepared);
        std.debug.assert(std.meta.eql(self.global_allocator, prepared.global_allocator));
        std.mem.swap(SyntaxStyle, self, prepared);
        std.mem.swap(events.EventEmitter(Event), &self.emitter, &prepared.emitter);
    }

    fn putStyle(self: *SyntaxStyle, name: []const u8, definition: StyleDefinition) SyntaxStyleError!u32 {
        if (self.name_to_id.get(name)) |existing_id| {
            self.id_to_style.getPtr(existing_id).?.* = definition;
            return existing_id;
        }

        const id = self.next_id;
        if (id == 0) return SyntaxStyleError.InvalidId;

        try self.name_to_id.ensureUnusedCapacity(self.allocator, 1);
        try self.id_to_style.ensureUnusedCapacity(self.allocator, 1);
        // Duplicate last so a rejected registration cannot strand an arena-owned name.
        const owned_name = self.allocator.dupe(u8, name) catch return SyntaxStyleError.OutOfMemory;

        self.name_to_id.putAssumeCapacity(owned_name, id);
        self.id_to_style.putAssumeCapacity(id, definition);
        self.next_id +%= 1;

        return id;
    }

    pub fn registerStyle(self: *SyntaxStyle, name: []const u8, fg: ?RGBA, bg: ?RGBA, attributes: u32) SyntaxStyleError!u32 {
        return self.registerStyleDefinition(name, .{
            .fg = fg,
            .bg = bg,
            .attributes = attributes,
        });
    }

    pub fn registerStyleDefinition(self: *SyntaxStyle, name: []const u8, definition: StyleDefinition) SyntaxStyleError!u32 {
        return self.putStyle(name, definition);
    }

    pub fn resolveById(self: *const SyntaxStyle, id: u32) ?StyleDefinition {
        return self.id_to_style.get(id);
    }

    pub fn resolveByName(self: *const SyntaxStyle, name: []const u8) ?u32 {
        return self.name_to_id.get(name);
    }

    pub fn getStyleByName(self: *const SyntaxStyle, name: []const u8) ?StyleDefinition {
        const id = self.resolveByName(name) orelse return null;
        return self.resolveById(id);
    }

    pub fn mergeStyles(self: *SyntaxStyle, ids: []const u32) SyntaxStyleError!StyleDefinition {
        var cache_key_buffer: [512]u8 = undefined;
        var writer: std.Io.Writer = .fixed(&cache_key_buffer);

        for (ids, 0..) |id, i| {
            if (i > 0) writer.writeByte(':') catch return SyntaxStyleError.OutOfMemory;
            writer.print("{d}", .{id}) catch return SyntaxStyleError.OutOfMemory;
        }

        const cache_key = writer.buffered();

        if (self.merged_cache.get(cache_key)) |cached| {
            return cached;
        }

        var merged: StyleDefinition = .{
            .fg = null,
            .bg = null,
            .attributes = 0,
        };

        for (ids) |id| {
            if (self.resolveById(id)) |style| {
                if (style.fg) |fg| {
                    merged.fg = fg;
                }
                if (style.bg) |bg| {
                    merged.bg = bg;
                }
                // Attributes are OR'd together
                merged.attributes |= style.attributes;
            }
        }

        const owned_cache_key = self.allocator.dupe(u8, cache_key) catch return SyntaxStyleError.OutOfMemory;
        self.merged_cache.put(self.allocator, owned_cache_key, merged) catch return SyntaxStyleError.OutOfMemory;

        return merged;
    }

    pub fn clearCache(self: *SyntaxStyle) void {
        self.merged_cache.clearRetainingCapacity();
    }

    pub fn getCacheSize(self: *const SyntaxStyle) usize {
        return self.merged_cache.count();
    }

    pub fn getStyleCount(self: *const SyntaxStyle) usize {
        return self.id_to_style.count();
    }

    pub fn onDestroy(self: *SyntaxStyle, ctx: *anyopaque, handle: *const fn (*anyopaque) void) SyntaxStyleError!void {
        self.emitter.on(.Destroy, .{ .ctx = ctx, .handle = handle }) catch return SyntaxStyleError.OutOfMemory;
    }

    pub fn offDestroy(self: *SyntaxStyle, ctx: *anyopaque, handle: *const fn (*anyopaque) void) void {
        self.emitter.off(.Destroy, .{ .ctx = ctx, .handle = handle });
    }
};
