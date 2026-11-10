const std = @import("std");
const ghostty_vt = @import("../ghostty-vt.zig");

test "Ghostty VT dependency parses and formats terminal output" {
    const alloc = std.testing.allocator;
    var terminal: ghostty_vt.vt.Terminal = try .init(std.testing.io, alloc, .{
        .cols = 16,
        .rows = 4,
    });
    defer terminal.deinit(alloc);

    var stream = terminal.vtStream();
    defer stream.deinit();
    stream.nextSlice("\x1b[31mhello\x1b[0m");

    const output = try terminal.plainString(alloc);
    defer alloc.free(output);
    try std.testing.expectEqualStrings("hello", output);
}
