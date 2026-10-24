const std = @import("std");
const Allocator = std.mem.Allocator;
const buffer = @import("buffer.zig");
const events = @import("event-emitter.zig");
const text_work = @import("text-work.zig");

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

/// The first id that registration never returns (`OT_STYLE_RUN_FLAG`).
pub const id_limit: u32 = 0x8000_0000;

pub const SyntaxStyle = struct {
    allocator: Allocator,
    global_allocator: Allocator,
    arena: *std.heap.ArenaAllocator,

    name_to_id: std.StringHashMapUnmanaged(u32),
    id_to_style: std.AutoHashMapUnmanaged(u32, StyleDefinition),
    next_id: u32,

    emitter: events.EventEmitter(Event),

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
        self.arena.deinit();
        global_allocator.destroy(self.arena);
        self.* = undefined;
    }

    pub fn registerStyleDefinition(self: *SyntaxStyle, name: []const u8, definition: StyleDefinition) SyntaxStyleError!u32 {
        text_work.add(.style_registrations, 1);
        if (self.name_to_id.get(name)) |existing_id| {
            self.id_to_style.getPtr(existing_id).?.* = definition;
            return existing_id;
        }

        const id = self.next_id;
        // Ids with bit 31 set name a text buffer's run styles.
        if (id == 0 or id >= id_limit) return SyntaxStyleError.InvalidId;

        try self.name_to_id.ensureUnusedCapacity(self.allocator, 1);
        try self.id_to_style.ensureUnusedCapacity(self.allocator, 1);
        // Duplicate last so a rejected registration cannot strand an arena-owned name.
        const owned_name = self.allocator.dupe(u8, name) catch return SyntaxStyleError.OutOfMemory;

        self.name_to_id.putAssumeCapacity(owned_name, id);
        self.id_to_style.putAssumeCapacity(id, definition);
        self.next_id += 1;

        return id;
    }

    pub fn registerStyle(self: *SyntaxStyle, name: []const u8, fg: ?RGBA, bg: ?RGBA, attributes: u32) SyntaxStyleError!u32 {
        return self.registerStyleDefinition(name, .{
            .fg = fg,
            .bg = bg,
            .attributes = attributes,
        });
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
