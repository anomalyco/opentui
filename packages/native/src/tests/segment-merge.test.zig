const std = @import("std");
const TestPools = @import("test-pools.zig").TestPools;
const EditBuffer = @import("../edit-buffer.zig").EditBuffer;
const link = @import("../link.zig");

test "EditBuffer - merging after delete and re-insert" {
    var pools = TestPools.init(std.testing.allocator);
    defer pools.deinit();

    var eb = try EditBuffer.init(std.testing.allocator, &pools.graphemes, &pools.links, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("hello");
    try eb.backspace();
    try eb.insertText("p");

    var buffer: [1024]u8 = undefined;
    const len = eb.getText(&buffer);
    try std.testing.expectEqualStrings("hellp", buffer[0..len]);
}
