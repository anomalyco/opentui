const std = @import("std");
const event_emitter = @import("../event-emitter.zig");

const EventType = enum {
    start,
    stop,
    update,
};

const Counter = struct {
    count: u32,

    pub fn increment(ctx: *anyopaque) void {
        const self: *Counter = @ptrCast(@alignCast(ctx));
        self.count += 1;
    }

    pub fn reset(ctx: *anyopaque) void {
        const self: *Counter = @ptrCast(@alignCast(ctx));
        self.count = 0;
    }
};

test "EventEmitter - can initialize and deinitialize" {
    const Emitter = event_emitter.EventEmitter(EventType);
    var emitter = Emitter.init(std.testing.allocator);
    defer emitter.deinit();
}

test "EventEmitter - can add listener with on" {
    const Emitter = event_emitter.EventEmitter(EventType);
    var emitter = Emitter.init(std.testing.allocator);
    defer emitter.deinit();

    var counter: Counter = .{ .count = 0 };
    const listener: Emitter.Listener = .{
        .ctx = &counter,
        .handle = Counter.increment,
    };

    try emitter.on(.start, listener);

    const list = emitter.listeners.get(.start);
    try std.testing.expect(list != null);
    try std.testing.expectEqual(@as(usize, 1), list.?.items.len);
}

test "EventEmitter - can add multiple listeners to same event" {
    const Emitter = event_emitter.EventEmitter(EventType);
    var emitter = Emitter.init(std.testing.allocator);
    defer emitter.deinit();

    var counter1: Counter = .{ .count = 0 };
    var counter2: Counter = .{ .count = 0 };

    const listener1: Emitter.Listener = .{
        .ctx = &counter1,
        .handle = Counter.increment,
    };

    const listener2: Emitter.Listener = .{
        .ctx = &counter2,
        .handle = Counter.increment,
    };

    try emitter.on(.start, listener1);
    try emitter.on(.start, listener2);

    const list = emitter.listeners.get(.start);
    try std.testing.expectEqual(@as(usize, 2), list.?.items.len);
}

test "EventEmitter - can add listeners to different events" {
    const Emitter = event_emitter.EventEmitter(EventType);
    var emitter = Emitter.init(std.testing.allocator);
    defer emitter.deinit();

    var counter1: Counter = .{ .count = 0 };
    var counter2: Counter = .{ .count = 0 };

    const listener1: Emitter.Listener = .{
        .ctx = &counter1,
        .handle = Counter.increment,
    };

    const listener2: Emitter.Listener = .{
        .ctx = &counter2,
        .handle = Counter.reset,
    };

    try emitter.on(.start, listener1);
    try emitter.on(.stop, listener2);

    const start_list = emitter.listeners.get(.start);
    const stop_list = emitter.listeners.get(.stop);

    try std.testing.expectEqual(@as(usize, 1), start_list.?.items.len);
    try std.testing.expectEqual(@as(usize, 1), stop_list.?.items.len);
}

test "EventEmitter - emit calls all listeners for event" {
    const Emitter = event_emitter.EventEmitter(EventType);
    var emitter = Emitter.init(std.testing.allocator);
    defer emitter.deinit();

    var counter1: Counter = .{ .count = 0 };
    var counter2: Counter = .{ .count = 0 };
    var counter3: Counter = .{ .count = 0 };

    const listener1: Emitter.Listener = .{
        .ctx = &counter1,
        .handle = Counter.increment,
    };

    const listener2: Emitter.Listener = .{
        .ctx = &counter2,
        .handle = Counter.increment,
    };

    const listener3: Emitter.Listener = .{
        .ctx = &counter3,
        .handle = Counter.increment,
    };

    try emitter.on(.start, listener1);
    try emitter.on(.start, listener2);
    try emitter.on(.stop, listener3);

    emitter.emit(.start);

    try std.testing.expectEqual(@as(u32, 1), counter1.count);
    try std.testing.expectEqual(@as(u32, 1), counter2.count);
    try std.testing.expectEqual(@as(u32, 0), counter3.count);

    emitter.emit(.stop);

    try std.testing.expectEqual(@as(u32, 1), counter1.count);
    try std.testing.expectEqual(@as(u32, 1), counter2.count);
    try std.testing.expectEqual(@as(u32, 1), counter3.count);
}

test "EventEmitter - can remove listener with off" {
    const Emitter = event_emitter.EventEmitter(EventType);
    var emitter = Emitter.init(std.testing.allocator);
    defer emitter.deinit();

    var counter: Counter = .{ .count = 0 };
    const listener: Emitter.Listener = .{
        .ctx = &counter,
        .handle = Counter.increment,
    };

    try emitter.on(.start, listener);

    var list = emitter.listeners.get(.start);
    try std.testing.expectEqual(@as(usize, 1), list.?.items.len);

    emitter.off(.start, listener);

    list = emitter.listeners.get(.start);
    try std.testing.expectEqual(@as(usize, 0), list.?.items.len);
}

test "EventEmitter - off removes only matching listener by reference" {
    const Emitter = event_emitter.EventEmitter(EventType);
    var emitter = Emitter.init(std.testing.allocator);
    defer emitter.deinit();

    var counter1: Counter = .{ .count = 0 };
    var counter2: Counter = .{ .count = 0 };

    const listener1: Emitter.Listener = .{
        .ctx = &counter1,
        .handle = Counter.increment,
    };

    const listener2: Emitter.Listener = .{
        .ctx = &counter2,
        .handle = Counter.increment,
    };

    try emitter.on(.start, listener1);
    try emitter.on(.start, listener2);

    var list = emitter.listeners.get(.start);
    try std.testing.expectEqual(@as(usize, 2), list.?.items.len);

    emitter.off(.start, listener1);

    list = emitter.listeners.get(.start);
    try std.testing.expectEqual(@as(usize, 1), list.?.items.len);

    emitter.emit(.start);
    try std.testing.expectEqual(@as(u32, 0), counter1.count);
    try std.testing.expectEqual(@as(u32, 1), counter2.count);
}

test "EventEmitter - emit with no listeners does not crash" {
    const Emitter = event_emitter.EventEmitter(EventType);
    var emitter = Emitter.init(std.testing.allocator);
    defer emitter.deinit();

    emitter.emit(.start);
    emitter.emit(.stop);
    emitter.emit(.update);
}

test "EventEmitter - multiple emits increment counter correctly" {
    const Emitter = event_emitter.EventEmitter(EventType);
    var emitter = Emitter.init(std.testing.allocator);
    defer emitter.deinit();

    var counter: Counter = .{ .count = 0 };
    const listener: Emitter.Listener = .{
        .ctx = &counter,
        .handle = Counter.increment,
    };

    try emitter.on(.update, listener);

    emitter.emit(.update);
    emitter.emit(.update);
    emitter.emit(.update);

    try std.testing.expectEqual(@as(u32, 3), counter.count);
}

test "EventEmitter - listeners are isolated per event type" {
    const Emitter = event_emitter.EventEmitter(EventType);
    var emitter = Emitter.init(std.testing.allocator);
    defer emitter.deinit();

    var counter: Counter = .{ .count = 0 };
    const listener: Emitter.Listener = .{
        .ctx = &counter,
        .handle = Counter.increment,
    };

    try emitter.on(.start, listener);

    emitter.emit(.start);
    try std.testing.expectEqual(@as(u32, 1), counter.count);

    emitter.emit(.stop);
    try std.testing.expectEqual(@as(u32, 1), counter.count);

    emitter.emit(.start);
    try std.testing.expectEqual(@as(u32, 2), counter.count);
}
