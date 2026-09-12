const std = @import("std");
const Allocator = std.mem.Allocator;

pub fn EventEmitter(comptime EventType: type) type {
    if (@typeInfo(EventType) != .@"enum") {
        @compileError("EventType must be an enum");
    }

    return struct {
        const Self = @This();

        pub const Listener = struct {
            ctx: *anyopaque,
            handle: *const fn (ctx: *anyopaque) void,
        };

        allocator: Allocator,
        listeners: std.EnumMap(EventType, std.ArrayListUnmanaged(Listener)),

        pub fn init(allocator: Allocator) Self {
            return .{
                .allocator = allocator,
                .listeners = std.EnumMap(EventType, std.ArrayListUnmanaged(Listener)).init(.{}),
            };
        }

        pub fn deinit(self: *Self) void {
            var iter = self.listeners.iterator();
            while (iter.next()) |entry| {
                entry.value.deinit(self.allocator);
            }
        }

        pub fn on(self: *Self, event: EventType, listener: Listener) !void {
            const list_ptr = self.listeners.getPtr(event) orelse {
                self.listeners.put(event, .empty);
                return self.on(event, listener);
            };

            try list_ptr.append(self.allocator, listener);
        }

        pub fn off(self: *Self, event: EventType, listener: Listener) void {
            const list_ptr = self.listeners.getPtr(event) orelse return;

            var i: usize = 0;
            while (i < list_ptr.items.len) {
                const item = list_ptr.items[i];
                if (item.ctx == listener.ctx and item.handle == listener.handle) {
                    _ = list_ptr.swapRemove(i);
                } else {
                    i += 1;
                }
            }
        }

        pub fn emit(self: *Self, event: EventType) void {
            const list_ptr = self.listeners.getPtr(event) orelse return;

            for (list_ptr.items) |listener| {
                listener.handle(listener.ctx);
            }
        }
    };
}
