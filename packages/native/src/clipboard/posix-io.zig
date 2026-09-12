const std = @import("std");
const builtin = @import("builtin");

const io = if (builtin.is_test) std.testing.io else @import("root").io;

pub const close = std.Io.Threaded.closeFd;
pub const pipe = std.Io.Threaded.pipe2;

pub fn socket(domain: u32, socket_type: u32, protocol: u32) !std.posix.socket_t {
    const result = std.posix.system.socket(domain, socket_type, protocol);
    return switch (std.posix.errno(result)) {
        .SUCCESS => @intCast(result),
        .ACCES => error.AccessDenied,
        .AFNOSUPPORT => error.AddressFamilyNotSupported,
        .INVAL => error.ProtocolFamilyNotAvailable,
        .MFILE => error.ProcessFdQuotaExceeded,
        .NFILE => error.SystemFdQuotaExceeded,
        .NOBUFS, .NOMEM => error.SystemResources,
        .PROTONOSUPPORT => error.ProtocolNotSupported,
        .PROTOTYPE => error.SocketTypeNotSupported,
        else => |err| std.posix.unexpectedErrno(err),
    };
}

pub fn connect(handle: std.posix.socket_t, address: *const std.posix.sockaddr, length: std.posix.socklen_t) !void {
    while (true) {
        switch (std.posix.errno(std.posix.system.connect(handle, address, length))) {
            .SUCCESS => return,
            .ACCES => return error.AccessDenied,
            .PERM => return error.PermissionDenied,
            .ADDRINUSE => return error.AddressInUse,
            .ADDRNOTAVAIL => return error.AddressNotAvailable,
            .AFNOSUPPORT => return error.AddressFamilyNotSupported,
            .AGAIN, .INPROGRESS => return error.WouldBlock,
            .ALREADY => return error.ConnectionPending,
            .CONNREFUSED => return error.ConnectionRefused,
            .CONNRESET => return error.ConnectionResetByPeer,
            .HOSTUNREACH, .NETUNREACH => return error.NetworkUnreachable,
            .TIMEDOUT => return error.ConnectionTimedOut,
            .NOENT => return error.FileNotFound,
            .INTR => continue,
            else => |err| return std.posix.unexpectedErrno(err),
        }
    }
}

pub fn bind(handle: std.posix.socket_t, address: *const std.posix.sockaddr, length: std.posix.socklen_t) !void {
    return switch (std.posix.errno(std.posix.system.bind(handle, address, length))) {
        .SUCCESS => {},
        .ACCES, .PERM => error.AccessDenied,
        .ADDRINUSE => error.AddressInUse,
        .AFNOSUPPORT => error.AddressFamilyNotSupported,
        .ADDRNOTAVAIL => error.AddressNotAvailable,
        .LOOP => error.SymLinkLoop,
        .NAMETOOLONG => error.NameTooLong,
        .NOENT => error.FileNotFound,
        .NOMEM => error.SystemResources,
        .NOTDIR => error.NotDir,
        .ROFS => error.ReadOnlyFileSystem,
        else => |err| std.posix.unexpectedErrno(err),
    };
}

pub fn stat(handle: std.posix.fd_t) !std.Io.File.Stat {
    const file: std.Io.File = .{ .handle = handle, .flags = .{ .nonblocking = true } };
    return file.stat(io);
}

pub fn duplicate(handle: std.posix.fd_t) !std.posix.fd_t {
    const result = std.posix.system.dup(handle);
    return switch (std.posix.errno(result)) {
        .SUCCESS => @intCast(result),
        .MFILE => error.ProcessFdQuotaExceeded,
        else => |err| std.posix.unexpectedErrno(err),
    };
}

pub fn unlink(path: []const u8) !void {
    if (std.fs.path.isAbsolute(path)) return std.Io.Dir.deleteFileAbsolute(io, path);
    return std.Io.Dir.cwd().deleteFile(io, path);
}

pub fn checkSocketError(handle: std.posix.fd_t) !void {
    var error_code: c_int = undefined;
    var size: std.posix.socklen_t = @sizeOf(c_int);
    const result = std.posix.system.getsockopt(
        handle,
        std.posix.SOL.SOCKET,
        std.posix.SO.ERROR,
        @ptrCast(&error_code),
        &size,
    );
    if (std.posix.errno(result) != .SUCCESS) return error.Unexpected;
    return switch (@as(std.posix.E, @enumFromInt(error_code))) {
        .SUCCESS => {},
        .ACCES => error.AccessDenied,
        .PERM => error.PermissionDenied,
        .ADDRINUSE => error.AddressInUse,
        .ADDRNOTAVAIL => error.AddressNotAvailable,
        .AFNOSUPPORT => error.AddressFamilyNotSupported,
        .AGAIN => error.SystemResources,
        .ALREADY => error.ConnectionPending,
        .CONNREFUSED => error.ConnectionRefused,
        .HOSTUNREACH, .NETUNREACH => error.NetworkUnreachable,
        .TIMEDOUT => error.ConnectionTimedOut,
        .CONNRESET => error.ConnectionResetByPeer,
        else => |err| std.posix.unexpectedErrno(err),
    };
}

pub fn listen(handle: std.posix.socket_t, backlog: u31) !void {
    return switch (std.posix.errno(std.posix.system.listen(handle, backlog))) {
        .SUCCESS => {},
        .ADDRINUSE => error.AddressInUse,
        .NOBUFS, .NOMEM => error.SystemResources,
        .OPNOTSUPP => error.OperationNotSupported,
        else => |err| std.posix.unexpectedErrno(err),
    };
}

pub fn truncate(handle: std.posix.fd_t, length: u64) !void {
    const file: std.Io.File = .{ .handle = handle, .flags = .{ .nonblocking = false } };
    try file.setLength(io, length);
}

pub fn write(handle: std.posix.fd_t, bytes: []const u8) std.Io.File.Writer.Error!usize {
    const file: std.Io.File = .{ .handle = handle, .flags = .{ .nonblocking = true } };
    return file.writeStreaming(io, &.{}, &.{bytes}, 1);
}

pub fn getFlags(handle: std.posix.fd_t) !u32 {
    const result = std.posix.system.fcntl(handle, std.posix.F.GETFL, @as(c_int, 0));
    return switch (std.posix.errno(result)) {
        .SUCCESS => @intCast(result),
        else => |err| std.posix.unexpectedErrno(err),
    };
}

pub fn setFlags(handle: std.posix.fd_t, flags: u32) !void {
    return switch (std.posix.errno(std.posix.system.fcntl(handle, std.posix.F.SETFL, flags))) {
        .SUCCESS => {},
        else => |err| std.posix.unexpectedErrno(err),
    };
}

pub fn setDescriptorFlags(handle: std.posix.fd_t, flags: u32) !void {
    return switch (std.posix.errno(std.posix.system.fcntl(handle, std.posix.F.SETFD, flags))) {
        .SUCCESS => {},
        else => |err| std.posix.unexpectedErrno(err),
    };
}

pub fn shutdownRead(handle: std.posix.fd_t) void {
    _ = std.posix.system.shutdown(handle, std.posix.SHUT.RD);
}

pub fn getEnv(name: [*:0]const u8) ?[:0]const u8 {
    const Environment = struct {
        extern "c" fn getenv(key: [*:0]const u8) ?[*:0]const u8;
    };
    return std.mem.span(Environment.getenv(name) orelse return null);
}
