//! Writes a copy of a Windows opentui-static.lib that Microsoft's linker links
//! too. OpenTUI's Windows objects are built for MinGW: Yoga needs Zig's libc++,
//! libc++abi, and libunwind, and the Zig code and FFmpeg need compiler-rt and
//! parts of MinGW's C runtime, none of which MSVC has. So the copy also holds
//! the members of those archives that the library needs and that the UCRT and
//! the Windows SDK do not provide, and a shim object for what MinGW's runtime
//! cannot give an MSVC program. A MinGW link takes the same members from here
//! instead of from its own copy of Zig's runtime.
//!
//! Usage: bundle-windows-runtime <zig> <target> <optimize> <probe.cpp> <shim.obj> <in.lib> <out.lib>
//!
//! As in bundle-libcxx.zig, the runtime archives come from the linker line of a
//! C++ probe for the same target and mode. Its import libraries say what the
//! UCRT and the SDK provide. The build fails when a symbol stays unresolved, or
//! when a member to add has constructors, which MinGW's start-up code runs and
//! MSVC's does not.

const std = @import("std");

const Member = struct { name: []const u8, data: []const u8 };
const Names = std.StringHashMapUnmanaged(void);
const Object = struct {
    defined: []const []const u8,
    undefined: []const []const u8,
    constructors: bool,
};

/// What an MSVC program has besides the UCRT DLL's exports and Windows: TLS
/// and atexit from the C runtime's start-up code, and the stdio functions that
/// MSVC's headers define inline, which legacy_stdio_definitions.lib defines out
/// of line. MinGW's versions of these would clash with MSVC's.
const msvc_runtime = [_][]const u8{
    "_tls_index", "atexit",    "printf", "fprintf", "sprintf", "snprintf", "vprintf", "vfprintf",
    "vsprintf",   "vsnprintf", "scanf",  "fscanf",  "sscanf",  "vscanf",   "vfscanf", "vsscanf",
};

pub fn main(init: std.process.Init) !void {
    const arena = init.arena.allocator();
    const io = init.io;
    const args = try init.minimal.args.toSlice(arena);
    if (args.len != 8) return error.Usage;
    const zig, const target, const optimize, const probe, const shim, const input, const output =
        .{ args[1], args[2], args[3], args[4], args[5], args[6], args[7] };
    const cwd = std.Io.Dir.cwd();
    const work = try std.fmt.allocPrint(arena, "{s}.d", .{output});
    try cwd.deleteTree(io, work);
    try cwd.createDirPath(io, work);

    // An explicit -femit-bin links on every run, so the linker line prints even when Zig's cache has the probe.
    const emit = try std.fmt.allocPrint(arena, "-femit-bin={s}/probe.dll", .{work});
    const link = try run(arena, io, &.{
        zig,       "build-lib", "-dynamic", "-lc++",  "-lbcrypt", "-luser32", "-lntdll", "-fstrip", "--verbose-link",
        "-target", target,      "-O",       optimize, probe,      emit,
    });
    var line: ?[]const u8 = null;
    var lines = std.mem.splitScalar(u8, link, '\n');
    while (lines.next()) |raw| {
        if (std.mem.startsWith(u8, raw, "lld-link ")) line = std.mem.trimEnd(u8, raw, "\r");
    }
    if (line == null) return fail("no lld-link line in the probe's output:\n{s}", .{link});

    var provided: Names = .empty;
    for (msvc_runtime) |name| try provided.put(arena, name, {});
    // Import libraries say what DLLs provide; MinGW's POSIX aliases in them, such as close for _close, are weak
    // externals, not imports, and the UCRT has none of them. The other libraries are the runtime.
    var runtime: std.ArrayList(Member) = .empty;
    for (try libraries(arena, io, line.?)) |path| {
        const members = try readArchive(arena, io, path);
        var imports = false;
        for (members) |member| {
            const name = importName(member.data) orelse continue;
            imports = true;
            try provided.put(arena, name, {});
            try provided.put(arena, try std.fmt.allocPrint(arena, "__imp_{s}", .{name}), {});
        }
        if (!imports) try runtime.appendSlice(arena, members);
    }
    const runtime_objects = try arena.alloc(Object, runtime.items.len);
    var index: std.StringHashMapUnmanaged(usize) = .empty;
    for (runtime.items, runtime_objects, 0..) |member, *object, i| {
        object.* = try parse(arena, member);
        for (object.defined) |name| {
            const slot = try index.getOrPut(arena, name);
            if (!slot.found_existing) slot.value_ptr.* = i;
        }
    }

    var own: std.ArrayList(Member) = .empty;
    try own.appendSlice(arena, try readArchive(arena, io, input));
    try own.append(arena, .{ .name = std.fs.path.basename(shim), .data = try cwd.readFileAlloc(io, shim, arena, .unlimited) });
    var defined: Names = .empty;
    var queue: std.ArrayList([]const u8) = .empty;
    for (own.items) |member| {
        const object = try parse(arena, member);
        for (object.defined) |name| try defined.put(arena, name, {});
        try queue.appendSlice(arena, object.undefined);
    }
    // Members to add, in the order they are found.
    var added: std.ArrayList(usize) = .empty;
    var missing: Names = .empty;
    while (queue.pop()) |name| {
        if (defined.contains(name) or provided.contains(name)) continue;
        const i = index.get(name) orelse {
            try missing.put(arena, name, {});
            continue;
        };
        const object = runtime_objects[i];
        if (object.constructors) return fail("{s}, which defines {s}, has constructors", .{ runtime.items[i].name, name });
        try added.append(arena, i);
        for (object.defined) |symbol| try defined.put(arena, symbol, {});
        try queue.appendSlice(arena, object.undefined);
    }
    if (missing.count() > 0) {
        var names: std.ArrayList(u8) = .empty;
        var it = missing.keyIterator();
        while (it.next()) |name| try names.print(arena, " {s}", .{name.*});
        return fail("neither the MinGW runtime nor MSVC defines:{s}", .{names.items});
    }

    // Numbered names: the runtime archives repeat some, such as misc.obj.
    var argv: std.ArrayList([]const u8) = .empty;
    try argv.appendSlice(arena, &.{ zig, "ar", "q", output, shim });
    for (added.items, 0..) |i, n| {
        const path = try std.fmt.allocPrint(arena, "{s}/{d}-{s}", .{ work, n, basename(runtime.items[i].name) });
        try cwd.writeFile(io, .{ .sub_path = path, .data = runtime.items[i].data });
        try argv.append(arena, path);
    }
    try cwd.writeFile(io, .{ .sub_path = output, .data = try cwd.readFileAlloc(io, input, arena, .unlimited) });
    _ = try run(arena, io, argv.items);
    try cwd.deleteTree(io, work);
}

/// The existing absolute paths of .lib files on the probe's linker line. Zig
/// prints paths unquoted, so a path may hold spaces: each is the shortest
/// absolute path that ends in .lib and exists.
fn libraries(arena: std.mem.Allocator, io: std.Io, line: []const u8) ![]const []const u8 {
    var out: std.ArrayList([]const u8) = .empty;
    var at: usize = 0;
    while (std.mem.indexOfPos(u8, line, at, ".lib")) |found| : (at = found + 1) {
        const end = found + ".lib".len;
        if (end != line.len and line[end] != ' ') continue;
        var start = found;
        while (std.mem.lastIndexOfScalar(u8, line[0..start], ' ')) |space| : (start = space) {
            const path = line[space + 1 .. end];
            if (!std.fs.path.isAbsolute(path)) continue;
            std.Io.Dir.cwd().access(io, path, .{}) catch continue;
            try out.append(arena, path);
            break;
        }
    }
    return out.items;
}

fn basename(name: []const u8) []const u8 {
    const slash = std.mem.lastIndexOfAny(u8, name, "/\\") orelse return name;
    return name[slash + 1 ..];
}

/// The members of a GNU or COFF archive, as Zig and llvm-ar write them.
fn readArchive(arena: std.mem.Allocator, io: std.Io, path: []const u8) ![]Member {
    const bytes = try std.Io.Dir.cwd().readFileAlloc(io, path, arena, .unlimited);
    if (!std.mem.startsWith(u8, bytes, "!<arch>\n")) return fail("{s} is not an archive", .{path});
    var members: std.ArrayList(Member) = .empty;
    var names: []const u8 = "";
    var pos: usize = 8;
    while (pos < bytes.len) {
        if (bytes.len - pos < 60) return fail("{s}: truncated member header", .{path});
        const header = bytes[pos..][0..60];
        const size = try std.fmt.parseInt(usize, std.mem.trimEnd(u8, header[48..58], " "), 10);
        if (bytes.len - pos - 60 < size) return fail("{s}: truncated member", .{path});
        const data = bytes[pos + 60 ..][0..size];
        pos += 60 + size + size % 2;
        const raw = std.mem.trimEnd(u8, header[0..16], " ");
        // The linker members: one in GNU archives, two in COFF ones.
        if (std.mem.eql(u8, raw, "/") or std.mem.eql(u8, raw, "/SYM64/")) continue;
        if (std.mem.eql(u8, raw, "//")) {
            names = data;
            continue;
        }
        // GNU ends a long name with "/\n", COFF with a NUL; Zig's names are paths, so they hold slashes.
        const name = if (raw.len > 1 and raw[0] == '/') long: {
            const offset = try std.fmt.parseInt(usize, raw[1..], 10);
            if (offset >= names.len) return fail("{s}: bad member name", .{path});
            const gnu = std.mem.indexOfPos(u8, names, offset, "/\n") orelse names.len;
            break :long names[offset..@min(gnu, std.mem.indexOfScalarPos(u8, names, offset, 0) orelse names.len)];
        } else std.mem.trimEnd(u8, raw, "/");
        try members.append(arena, .{ .name = name, .data = data });
    }
    return members.items;
}

/// The symbol a short import member imports, or null for any other member.
fn importName(data: []const u8) ?[]const u8 {
    if (data.len < 21 or read(u16, data, 0) != 0 or read(u16, data, 2) != 0xffff or read(u16, data, 4) != 0) return null;
    return std.mem.sliceTo(data[20..], 0);
}

/// The external names a COFF object defines and uses, and whether it has
/// GCC-style constructor or destructor sections. Zig writes no big COFF
/// objects for these targets, so one fails the build.
fn parse(arena: std.mem.Allocator, member: Member) !Object {
    const data = member.data;
    if (data.len < 20 or read(u16, data, 0) == 0) return fail("{s}: not a COFF object", .{member.name});
    const sections: usize = read(u16, data, 2);
    const symtab: usize = read(u32, data, 8);
    const count: usize = read(u32, data, 12);
    const section_table = 20 + @as(usize, read(u16, data, 16));
    const strings = symtab + count * 18;
    if (section_table + sections * 40 > data.len or strings > data.len) return fail("{s}: truncated COFF object", .{member.name});

    var constructors = false;
    for (0..sections) |i| {
        const raw = data[section_table + i * 40 ..][0..8];
        const name = if (raw[0] == '/')
            std.mem.sliceTo(data[strings + try std.fmt.parseInt(usize, std.mem.sliceTo(raw[1..], 0), 10) ..], 0)
        else
            std.mem.sliceTo(raw, 0);
        constructors = constructors or std.mem.startsWith(u8, name, ".ctors") or std.mem.startsWith(u8, name, ".dtors");
    }
    var defined: std.ArrayList([]const u8) = .empty;
    var undefined_names: std.ArrayList([]const u8) = .empty;
    var i: usize = 0;
    while (i < count) : (i += 1 + data[symtab + i * 18 + 17]) {
        const at = symtab + i * 18;
        const raw = data[at..][0..8];
        const name = if (read(u32, raw, 0) == 0) std.mem.sliceTo(data[strings + read(u32, raw, 4) ..], 0) else std.mem.sliceTo(raw, 0);
        switch (data[at + 16]) {
            // External: undefined with no section and no size, else defined, or common.
            2 => try (if (read(i16, data, at + 12) == 0 and read(u32, data, at + 8) == 0) &undefined_names else &defined).append(arena, name),
            // A weak external has a default, so it defines its name.
            105 => try defined.append(arena, name),
            else => {},
        }
    }
    return .{ .defined = defined.items, .undefined = undefined_names.items, .constructors = constructors };
}

fn read(comptime T: type, data: []const u8, at: usize) T {
    return std.mem.readInt(T, data[at..][0..@sizeOf(T)], .little);
}

/// Runs a command and returns its stderr; fails unless it exits with 0.
fn run(arena: std.mem.Allocator, io: std.Io, argv: []const []const u8) ![]const u8 {
    const result = try std.process.run(arena, io, .{ .argv = argv });
    if (result.term != .exited or result.term.exited != 0) {
        return fail("{s} {s} failed:\n{s}", .{ argv[0], argv[1], result.stderr });
    }
    return result.stderr;
}

fn fail(comptime format: []const u8, args: anytype) error{BundleWindowsRuntime} {
    std.debug.print("bundle-windows-runtime: " ++ format ++ "\n", args);
    return error.BundleWindowsRuntime;
}
