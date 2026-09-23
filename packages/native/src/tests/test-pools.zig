const std = @import("std");
const gp = @import("../grapheme.zig");
const link = @import("../link.zig");

pub const TestPools = struct {
    graphemes: gp.GraphemePool,
    links: link.LinkPool,

    pub fn init(allocator: std.mem.Allocator) TestPools {
        return .{
            .graphemes = gp.GraphemePool.init(allocator),
            .links = link.LinkPool.init(allocator),
        };
    }

    pub fn deinit(self: *TestPools) void {
        self.links.deinit();
        self.graphemes.deinit();
    }
};
