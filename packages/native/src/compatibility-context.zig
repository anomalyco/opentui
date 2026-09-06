const std = @import("std");
const build_options = @import("build_options");
const handles = @import("handles.zig");
const grapheme = @import("grapheme.zig");
const link = @import("link.zig");
const yoga = @import("yoga.zig");
const logger = @import("logger.zig");

/// Storage for the serialized, shipped 32-bit FFI. This is not the 64-bit Context
/// API: its registry has no context identity and does not own resource destructors.
/// Keep this owner address-stable until all resources and borrowed pool IDs expire.
pub const CompatibilityOwner = struct {
    gpa: std.heap.DebugAllocator(.{
        .enable_memory_limit = build_options.gpa_safe_stats,
        .safety = build_options.gpa_safe_stats,
    }) = .init,
    arena: std.heap.ArenaAllocator,
    registry: handles.Registry = .{},
    graphemes: ?grapheme.GraphemePool = null,
    links: ?link.LinkPool = null,
    logger: logger.Logger = .{ .callback = null },
    io_threaded: std.Io.Threaded = .init_single_threaded,
    yoga_config: yoga.Config = undefined,
    yoga_initialized: bool = false,
    yoga_mutex: std.Io.Mutex = .init,

    pub fn init(self: *CompatibilityOwner) void {
        self.gpa = .init;
        self.arena = std.heap.ArenaAllocator.init(self.gpa.allocator());
        self.registry.init();
        self.graphemes = null;
        self.links = null;
        self.logger = .{ .callback = null };
        self.io_threaded = .init_single_threaded;
        self.yoga_initialized = false;
        self.yoga_mutex = .init;
    }

    /// Callers destroy resources first, including Yoga nodes outside the registry.
    /// Refuse teardown while a handle or Yoga node is live.
    pub fn deinit(self: *CompatibilityOwner) error{ LiveHandles, LiveYogaNodes }!std.heap.Check {
        if (!self.registry.isEmpty()) return error.LiveHandles;
        if (self.yoga_initialized) {
            if (self.yoga_config.hasLiveNodes()) return error.LiveYogaNodes;
            self.yoga_config.deinit();
            self.yoga_initialized = false;
        }
        self.logger = .{ .callback = null };
        self.deinitGraphemePool();
        self.deinitLinkPool();
        self.arena.deinit();
        self.io_threaded.deinit();
        return self.gpa.deinit();
    }

    pub fn getYogaConfig(self: *CompatibilityOwner) yoga.Error!*yoga.Config {
        const io = self.io_threaded.io();
        self.yoga_mutex.lockUncancelable(io);
        defer self.yoga_mutex.unlock(io);
        if (!self.yoga_initialized) {
            try self.yoga_config.init(self.gpa.allocator(), .{});
            self.yoga_initialized = true;
        }
        return &self.yoga_config;
    }

    pub fn initGraphemePool(
        self: *CompatibilityOwner,
        allocator: std.mem.Allocator,
        options: grapheme.GraphemePool.InitOptions,
    ) *grapheme.GraphemePool {
        if (self.graphemes == null) {
            self.graphemes = grapheme.GraphemePool.initWithOptions(allocator, options);
        }
        return &self.graphemes.?;
    }

    pub fn deinitGraphemePool(self: *CompatibilityOwner) void {
        if (self.graphemes) |*pool| {
            pool.deinit();
            self.graphemes = null;
        }
    }

    pub fn initLinkPool(self: *CompatibilityOwner, allocator: std.mem.Allocator) *link.LinkPool {
        if (self.links == null) self.links = link.LinkPool.init(allocator);
        return &self.links.?;
    }

    pub fn deinitLinkPool(self: *CompatibilityOwner) void {
        if (self.links) |*pool| {
            pool.deinit();
            self.links = null;
        }
    }
};

// Only compatibility adapters use this singleton. Native Context instances and
// independent registries keep their own storage and never route through it.
pub var compatDefault: CompatibilityOwner = .{
    .arena = std.heap.ArenaAllocator.init(compatDefault.gpa.allocator()),
};
