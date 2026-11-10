const std = @import("std");
const builtin = @import("builtin");

const io = if (builtin.is_test) std.testing.io else @import("root").io;

pub const Mutex = struct {
    inner: std.Io.Mutex = .init,

    pub fn lock(self: *Mutex) void {
        self.inner.lockUncancelable(io);
    }

    pub fn tryLock(self: *Mutex) bool {
        return self.inner.tryLock();
    }

    pub fn unlock(self: *Mutex) void {
        self.inner.unlock(io);
    }
};

pub const Condition = struct {
    inner: std.Io.Condition = .init,

    pub fn wait(self: *Condition, mutex: *Mutex) void {
        self.inner.waitUncancelable(io, &mutex.inner);
    }

    pub fn timedWait(self: *Condition, mutex: *Mutex, timeout_ns: u64) std.Io.Cancelable!void {
        _ = self;
        mutex.unlock();
        defer mutex.lock();
        try io.sleep(.fromNanoseconds(timeout_ns), .awake);
    }

    pub fn signal(self: *Condition) void {
        self.inner.signal(io);
    }
};

pub fn sleep(ns: u64) void {
    io.sleep(.fromNanoseconds(ns), .awake) catch {};
}

pub fn nowNs() i128 {
    return @intCast(std.Io.Clock.now(.awake, io).nanoseconds);
}
