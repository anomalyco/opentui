const std = @import("std");
const Config = @import("src/build/Config.zig");
const GhosttyZig = @import("src/build/GhosttyZig.zig");
const SharedDeps = @import("src/build/SharedDeps.zig");

pub fn build(b: *std.Build) !void {
    const config = try Config.init(b, @import("build.zig.zon").version, "0.1.0-dev");
    const dependencies = try SharedDeps.init(b, &config);
    _ = try GhosttyZig.init(b, &config, &dependencies);
}
