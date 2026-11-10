//! Environment changes for tests. Zig 0.17 reads the startup environment array on the first
//! stderr write, and libc setenv and unsetenv can leave that array with a null or freed entry.
//! A failing test then panics in that read, and the panic handler deadlocks on its mutex. `set`
//! prints nothing to stderr first, which makes Zig read the array while it is still intact.
const std = @import("std");

extern "c" fn setenv(name: [*:0]const u8, value: [*:0]const u8, overwrite: c_int) c_int;
extern "c" fn unsetenv(name: [*:0]const u8) c_int;

/// Sets `name` to `value`, or removes it when `value` is null.
pub fn set(name: [*:0]const u8, value: ?[*:0]const u8) void {
    std.debug.print("", .{});
    // A Zig that no longer reads the environment on this print fails here, before the change.
    std.debug.assert(std.Options.debug_threaded_io.?.environ_initialized);
    const result = if (value) |text| setenv(name, text, 1) else unsetenv(name);
    std.debug.assert(result == 0);
}

/// The values a test found before it changed them. The Wayland connection reads the most: three.
pub const Saved = struct {
    names: []const [*:0]const u8,
    values: [3]?[:0]u8 = @splat(null),

    /// Puts each variable back as `save` found it.
    pub fn restore(saved: Saved) void {
        for (saved.names, saved.values[0..saved.names.len]) |name, value| {
            set(name, if (value) |text| text.ptr else null);
            if (value) |text| std.testing.allocator.free(text);
        }
    }
};

pub fn save(names: []const [*:0]const u8) !Saved {
    var saved: Saved = .{ .names = names };
    for (names, saved.values[0..names.len]) |name, *value| {
        if (std.c.getenv(name)) |current| value.* = try std.testing.allocator.dupeSentinel(u8, std.mem.span(current), 0);
    }
    return saved;
}
