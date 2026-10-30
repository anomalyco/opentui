//! An allocator for tests that count allocations or retained bytes. It forwards
//! to `child` but never resizes or remaps in place. Zig 0.17's testing allocator
//! grows an allocation in place only while it ends its bucket, so whether growth
//! needs a new allocation depends on the bucket size and on earlier allocations.

const std = @import("std");

const NoResizeAllocator = @This();

child: std.mem.Allocator,

pub fn allocator(self: *NoResizeAllocator) std.mem.Allocator {
    return .{
        .ptr = self,
        .vtable = &.{
            .alloc = alloc,
            .resize = std.mem.Allocator.noResize,
            .remap = std.mem.Allocator.noRemap,
            .free = free,
        },
    };
}

fn alloc(context: *anyopaque, len: usize, alignment: std.mem.Alignment, return_address: usize) ?[*]u8 {
    const self: *NoResizeAllocator = @ptrCast(@alignCast(context));
    return self.child.rawAlloc(len, alignment, return_address);
}

fn free(context: *anyopaque, memory: []u8, alignment: std.mem.Alignment, return_address: usize) void {
    const self: *NoResizeAllocator = @ptrCast(@alignCast(context));
    self.child.rawFree(memory, alignment, return_address);
}
