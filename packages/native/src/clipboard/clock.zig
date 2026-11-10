const sync = @import("sync.zig");

pub fn init() !void {}

pub const sleep = sync.sleep;

pub fn nowNs() i128 {
    return sync.nowNs();
}
