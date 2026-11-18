//! Writes a copy of a Windows opentui-static.lib that Microsoft's linker links
//! too. OpenTUI's Windows objects are built for MinGW: Yoga needs Zig's libc++,
//! libc++abi, and libunwind, and the Zig code and FFmpeg need compiler-rt and
//! parts of MinGW's C runtime, none of which MSVC has. So the copy also holds
//! the members of those archives that the library needs and that the UCRT and
//! the Windows SDK do not provide, and a shim object for what MinGW's runtime
//! cannot give an MSVC program. A MinGW link takes the same members from here
//! instead of from its own copy of Zig's runtime.
//!
//! Usage: bundle-windows-runtime <zig> <target> <optimize> <probe.cpp> <shim.c> <mingw lib-common> <in.lib> <out.lib>
//!
//! As in bundle-libcxx.zig, the runtime archives come from the linker line of a
//! C++ probe for the same target and mode. Its import libraries say what the
//! UCRT and the SDK provide. The build fails when a symbol stays unresolved, or
//! when a member to add has constructors, which MinGW's start-up code runs and
//! MSVC's does not.
//!
//! Every object is also rewritten in place so that link.exe accepts its COMDAT
//! sections (see fixComdats) and does not warn about MinGW-only directives
//! (see blankExcludeSymbols).

const std = @import("std");

const Member = struct { name: []const u8, data: []u8 };
const Names = std.StringHashMapUnmanaged(void);
const Object = struct {
    defined: []const []const u8,
    /// Defined in a section, so not weak, which gives way to another definition.
    strong: []const []const u8,
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
    if (args.len != 9) return error.Usage;
    const zig, const target, const optimize, const probe, const shim, const lib_common, const input, const output =
        .{ args[1], args[2], args[3], args[4], args[5], args[6], args[7], args[8] };
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
    // externals, not imports, and the UCRT has none of them. The other libraries are the runtime. With crt-static
    // the UCRT is libucrt.lib, which defines its functions and no __imp_ pointers, so only the plain names count.
    var runtime: std.ArrayList(Member) = .empty;
    var crt_functions: Names = .empty;
    for (try libraries(arena, io, line.?)) |path| {
        const members = try readArchive(arena, path, try cwd.readFileAlloc(io, path, arena, .unlimited));
        const crt = std.mem.startsWith(u8, basename(path), "api-ms-win-crt-");
        var imports = false;
        for (members) |member| {
            const name = importName(member.data) orelse continue;
            imports = true;
            // The import's type: 0 code, 1 data, 2 const.
            const code = read(u16, member.data, 18) & 3 == 0;
            if (crt and code) try crt_functions.put(arena, name, {});
            if (!crt or code) try provided.put(arena, name, {});
            if (!crt) try provided.put(arena, try std.fmt.allocPrint(arena, "__imp_{s}", .{name}), {});
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

    // The input's members are slices of its bytes, so the output starts from them once they are rewritten.
    const input_bytes = try cwd.readFileAlloc(io, input, arena, .unlimited);
    var own: std.ArrayList(Member) = .empty;
    try own.appendSlice(arena, try readArchive(arena, input, input_bytes));
    const shim_object = try compileShim(arena, io, zig, target, shim, work, &.{});
    try own.append(arena, shim_object);
    var defined: Names = .empty;
    var queue: std.ArrayList([]const u8) = .empty;
    for (own.items) |member| {
        const object = try parse(arena, member);
        for (object.defined) |name| try defined.put(arena, name, {});
        try queue.appendSlice(arena, object.undefined);
    }
    // Members to add, in the order they are found, and CRT functions called through __imp_ pointers.
    var added: std.ArrayList(usize) = .empty;
    var missing: Names = .empty;
    var imported: Names = .empty;
    while (queue.pop()) |name| {
        if (defined.contains(name) or provided.contains(name)) continue;
        if (std.mem.startsWith(u8, name, "__imp_") and crt_functions.contains(name["__imp_".len..])) {
            try imported.put(arena, name["__imp_".len..], {});
            continue;
        }
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

    // A member brings everything it defines, not only the name it was added for. Where that includes a name MSVC
    // provides, such as MinGW's 80-bit strtold beside the __mingw_strtold its scanf calls, a program that links that
    // part of the static C runtime gets it twice. So such a member's names are renamed, in it and in the runtime
    // members that call them: neither MSVC's runtime nor a MinGW program's own copy of the member meets them, and
    // nothing here calls MSVC's version, whose long double has 64 bits.
    const long_double = try longDoubleFunctions(arena, io, lib_common);
    var private: Names = .empty;
    for (added.items) |i| {
        const names = runtime_objects[i].strong;
        for (names) |name| if (provided.contains(name) or long_double.contains(name)) {
            for (names) |each| try private.put(arena, each, {});
            break;
        };
    }
    for (own.items) |member| for ((try parse(arena, member)).undefined) |name| {
        if (private.contains(name)) return fail("{s} calls {s}, which a member that clashes with MSVC's runtime defines", .{ member.name, name });
    };
    for (added.items) |i| try rename(arena, &runtime.items[i], private);

    // The shim again, now with a pointer for each of those functions. An /alternatename directive makes the pointer
    // stand for __imp_name only when nothing else defines it, as with libucrt.lib; an import library's own pointer,
    // in a link with the UCRT DLL or MinGW's runtime, takes precedence. A linker reads directives only from members
    // it loads, and the Zig object, which every OpenTUI program loads, loads the shim.
    var names: std.ArrayList([]const u8) = .empty;
    var it = imported.keyIterator();
    while (it.next()) |name| try names.append(arena, name.*);
    std.mem.sortUnstable([]const u8, names.items, {}, lessThan);
    own.items[own.items.len - 1] = try compileShim(arena, io, zig, target, shim, work, names.items);
    const shim_symbols = try parse(arena, own.getLast());
    for (shim_symbols.undefined) |name| {
        if (!defined.contains(name) and !provided.contains(name)) return fail("the shim needs {s}", .{name});
    }
    const loads_shim = zig_object: for (own.items[0 .. own.items.len - 1]) |member| {
        if (!std.mem.endsWith(u8, member.name, "_zcu.obj")) continue;
        for ((try parse(arena, member)).undefined) |name| {
            for (shim_symbols.defined) |symbol| if (std.mem.eql(u8, symbol, name)) break :zig_object true;
        }
    } else false;
    if (!loads_shim) return fail("the Zig object uses nothing from the shim, so a linker may never read its directives", .{});

    for (own.items) |member| {
        try fixComdats(member);
        try blankExcludeSymbols(member);
    }
    const shim_copy = try std.fmt.allocPrint(arena, "{s}/{s}", .{ work, own.getLast().name });
    try cwd.writeFile(io, .{ .sub_path = shim_copy, .data = own.getLast().data });
    // Numbered names: the runtime archives repeat some, such as misc.obj.
    var argv: std.ArrayList([]const u8) = .empty;
    try argv.appendSlice(arena, &.{ zig, "ar", "q", output, shim_copy });
    for (added.items, 0..) |i, n| {
        try fixComdats(runtime.items[i]);
        try blankExcludeSymbols(runtime.items[i]);
        const path = try std.fmt.allocPrint(arena, "{s}/{d}-{s}", .{ work, n, basename(runtime.items[i].name) });
        try cwd.writeFile(io, .{ .sub_path = path, .data = runtime.items[i].data });
        try argv.append(arena, path);
    }
    try cwd.writeFile(io, .{ .sub_path = output, .data = input_bytes });
    _ = try run(arena, io, argv.items);
    try cwd.deleteTree(io, work);
}

/// Compiles the shim's source for the target, with a pointer to each CRT
/// function in `imported` that stands in for its __imp_ pointer.
fn compileShim(
    arena: std.mem.Allocator,
    io: std.Io,
    zig: []const u8,
    target: []const u8,
    source: []const u8,
    work: []const u8,
    imported: []const []const u8,
) !Member {
    const cwd = std.Io.Dir.cwd();
    var text: std.ArrayList(u8) = .empty;
    try text.appendSlice(arena, try cwd.readFileAlloc(io, source, arena, .unlimited));
    for (imported, 0..) |name, n| try text.print(arena,
        \\__asm__(".section .drectve,\"yn\"\n.ascii \" /alternatename:__imp_{0s}=__ot_imp_{0s}\"\n.text");
        \\extern char ot_crt_{1d}[] __asm__("{0s}");
        \\void *ot_crt_pointer_{1d} __asm__("__ot_imp_{0s}") = ot_crt_{1d};
        \\
    , .{ name, n });
    const c = try std.fmt.allocPrint(arena, "{s}/windows-msvc-shim.c", .{work});
    const object = try std.fmt.allocPrint(arena, "{s}/windows-msvc-shim.obj", .{work});
    try cwd.writeFile(io, .{ .sub_path = c, .data = text.items });
    _ = try run(arena, io, &.{ zig, "cc", "-target", target, "-std=c11", "-O2", "-g0", "-c", c, "-o", object });
    return .{ .name = "windows-msvc-shim.obj", .data = try cwd.readFileAlloc(io, object, arena, .unlimited) };
}

fn lessThan(_: void, a: []const u8, b: []const u8) bool {
    return std.mem.lessThan(u8, a, b);
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

/// The members of a GNU or COFF archive, as Zig and llvm-ar write them, as
/// slices of its bytes.
fn readArchive(arena: std.mem.Allocator, path: []const u8, bytes: []u8) ![]Member {
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

/// A COFF object's section and symbol tables. Zig writes no big COFF objects
/// for these targets, so one fails the build.
const Coff = struct {
    data: []u8,
    sections: usize,
    symtab: usize,
    count: usize,
    section_table: usize,
    strings: usize,

    fn init(member: Member) !Coff {
        const data = member.data;
        if (data.len < 20 or read(u16, data, 0) == 0) return fail("{s}: not a COFF object", .{member.name});
        const coff: Coff = .{
            .data = data,
            .sections = read(u16, data, 2),
            .symtab = read(u32, data, 8),
            .count = read(u32, data, 12),
            .section_table = 20 + @as(usize, read(u16, data, 16)),
            .strings = read(u32, data, 8) + @as(usize, read(u32, data, 12)) * 18,
        };
        if (coff.section_table + coff.sections * 40 > data.len or coff.strings > data.len) {
            return fail("{s}: truncated COFF object", .{member.name});
        }
        return coff;
    }

    /// Section `i`, counting from 0; long names are "/offset" into the string table.
    fn sectionName(coff: Coff, i: usize) ![]const u8 {
        const raw = coff.data[coff.section_table + i * 40 ..][0..8];
        if (raw[0] != '/') return std.mem.sliceTo(raw, 0);
        return std.mem.sliceTo(coff.data[coff.strings + try std.fmt.parseInt(usize, std.mem.sliceTo(raw[1..], 0), 10) ..], 0);
    }

    fn symbolName(coff: Coff, at: usize) []const u8 {
        const raw = coff.data[at..][0..8];
        if (read(u32, raw, 0) == 0) return std.mem.sliceTo(coff.data[coff.strings + read(u32, raw, 4) ..], 0);
        return std.mem.sliceTo(raw, 0);
    }

    fn comdat(coff: Coff, i: usize) bool {
        return read(u32, coff.data, coff.section_table + i * 40 + 36) & 0x1000 != 0;
    }

    /// Turns COMDAT section `i`, whose definition aux record is at `aux`, into an ordinary section.
    fn ordinary(coff: Coff, i: usize, aux: usize) void {
        const flags = coff.data[coff.section_table + i * 40 + 36 ..][0..4];
        std.mem.writeInt(u32, flags, std.mem.readInt(u32, flags, .little) & ~@as(u32, 0x1000), .little);
        coff.data[aux + 14] = 0;
    }

    /// The aux record of section `i`'s own symbol.
    fn definition(coff: Coff, i: usize) !?usize {
        var s: usize = 0;
        while (s < coff.count) : (s += 1 + coff.data[coff.symtab + s * 18 + 17]) {
            const at = coff.symtab + s * 18;
            if (coff.data[at + 16] != 3 or coff.data[at + 17] == 0 or read(i16, coff.data, at + 12) != @as(i32, @intCast(i + 1))) continue;
            if (std.mem.eql(u8, coff.symbolName(at), try coff.sectionName(i))) return at + 18;
        }
        return null;
    }

    /// Makes the "no duplicates" COMDATs that section `i` refers to ordinary sections.
    fn ordinaryTargets(coff: Coff, member: Member, i: usize) !void {
        const header = coff.section_table + i * 40;
        if (read(u32, coff.data, header + 36) & 0x0100_0000 != 0) return fail("{s}: too many relocations", .{member.name});
        const relocations: usize = read(u32, coff.data, header + 24);
        for (0..read(u16, coff.data, header + 32)) |r| {
            const symbol: usize = read(u32, coff.data, relocations + r * 10 + 4);
            const number = read(i16, coff.data, coff.symtab + symbol * 18 + 12);
            if (number <= 0 or !coff.comdat(@intCast(number - 1))) continue;
            const target: usize = @intCast(number - 1);
            const aux = (try coff.definition(target)) orelse return fail("{s}: COMDAT section {d} has no definition", .{ member.name, target + 1 });
            if (coff.data[aux + 14] != 1) {
                return fail("{s}: shared unwind data covers {s}, which a linker may drop", .{ member.name, try coff.sectionName(target) });
            }
            coff.ordinary(target, aux);
        }
    }
};

/// The UCRT's long double functions. MinGW's import libraries leave them out
/// on x86, where MinGW's long double has 80 bits and its runtime defines its
/// own; libucrt.lib defines them all (F_LD64 in the .def files in `common`).
fn longDoubleFunctions(arena: std.mem.Allocator, io: std.Io, common: []const u8) !Names {
    var dir = try std.Io.Dir.cwd().openDir(io, common, .{ .iterate = true });
    defer dir.close(io);
    var names: Names = .empty;
    var files = dir.iterate();
    while (try files.next(io)) |file| {
        if (!std.mem.startsWith(u8, file.name, "api-ms-win-crt-") or !std.mem.endsWith(u8, file.name, ".def.in")) continue;
        const text = try dir.readFileAlloc(io, file.name, arena, .unlimited);
        var at: usize = 0;
        while (std.mem.indexOfPos(u8, text, at, "F_LD64(")) |found| {
            at = found + "F_LD64(".len;
            try names.put(arena, text[at .. std.mem.indexOfAnyPos(u8, text, at, " )") orelse text.len], {});
        }
    }
    if (names.count() == 0) return fail("no F_LD64 functions in {s}", .{common});
    return names;
}

/// Renames the external symbols of `member` named in `names` to __ot_<name>,
/// appending the new names to its string table, which ends the object.
fn rename(arena: std.mem.Allocator, member: *Member, names: Names) !void {
    const coff = try Coff.init(member.*);
    if (coff.strings + 4 > coff.data.len or coff.strings + read(u32, coff.data, coff.strings) != coff.data.len) {
        return fail("{s}: the string table does not end the object", .{member.name});
    }
    var data: std.ArrayList(u8) = .empty;
    try data.appendSlice(arena, coff.data);
    var i: usize = 0;
    while (i < coff.count) : (i += 1 + coff.data[coff.symtab + i * 18 + 17]) {
        const at = coff.symtab + i * 18;
        const name = coff.symbolName(at);
        if (coff.data[at + 16] != 2 or !names.contains(name)) continue;
        std.mem.writeInt(u32, data.items[at..][0..4], 0, .little);
        std.mem.writeInt(u32, data.items[at + 4 ..][0..4], @intCast(data.items.len - coff.strings), .little);
        try data.print(arena, "__ot_{s}\x00", .{name});
    }
    std.mem.writeInt(u32, data.items[coff.strings..][0..4], @intCast(data.items.len - coff.strings), .little);
    member.data = data.items;
}

/// MinGW objects carry -exclude-symbols directives, which keep their names out
/// of a DLL that MinGW's linker builds by exporting everything. link.exe knows
/// no such option and warns about every one (LNK4229), thousands of lines per
/// link. Blanks them in place; other directives stay.
fn blankExcludeSymbols(member: Member) !void {
    const coff = try Coff.init(member);
    for (0..coff.sections) |i| {
        if (!std.mem.eql(u8, try coff.sectionName(i), ".drectve")) continue;
        const header = coff.section_table + i * 40;
        const directives = coff.data[read(u32, coff.data, header + 20)..][0..read(u32, coff.data, header + 16)];
        var at: usize = 0;
        while (at < directives.len) {
            if (directives[at] == ' ') {
                at += 1;
                continue;
            }
            var end = at;
            var quoted = false;
            while (end < directives.len and (quoted or directives[end] != ' ')) : (end += 1) {
                if (directives[end] == '"') quoted = !quoted;
            }
            const token = directives[at..end];
            if (std.mem.startsWith(u8, token, "-exclude-symbols:") or std.mem.startsWith(u8, token, "/exclude-symbols:")) @memset(token, ' ');
            at = end;
        }
    }
}

/// link.exe takes a COMDAT section's symbol from the entry right after the
/// section's own symbol, and stops with LNK1143 ("no symbol for COMDAT
/// section") when that entry is not one; lld does not ask. LLVM's MinGW mode
/// writes two kinds of COMDAT without one:
/// - unwind data in GNU-style linkonce sections, .xdata$name and .pdata$name
///   with selection "any". Each becomes associative to the COMDAT .text$name,
///   as LLVM's MSVC mode emits it, so it stays exactly when its function does.
///   Zig's own objects hold the unwind data of many functions in one .xdata$
///   and one .pdata$; those become ordinary sections.
/// - weak definitions (libc++abi's operator new and delete) in "no duplicates"
///   sections, whose symbol comes later in the table. They become ordinary
///   sections, which still reject a duplicate, and so does their unwind data.
/// Ordinary sections are never dropped, so they keep what they refer to. The
/// functions a shared .pdata$ covers become ordinary too: linkers fold only
/// COMDATs as identical code (/OPT:ICF), and a folded function would leave its
/// entry in the shared table beside the survivor's. Any other COMDAT without its
/// symbol fails the build. Only section flags and aux records change, so
/// nothing moves.
fn fixComdats(member: Member) !void {
    const coff = try Coff.init(member);
    const data = coff.data;
    // Code first, then Zig's shared unwind data, which may make more code ordinary, then the rest of the unwind data,
    // which follows what became of its function.
    for ([_]u2{ 0, 1, 2 }) |pass| {
        var i: usize = 0;
        while (i < coff.count) : (i += 1 + data[coff.symtab + i * 18 + 17]) {
            const at = coff.symtab + i * 18;
            const number = read(i16, data, at + 12);
            // A section's own symbol: static, with an aux record, named as the section.
            if (data[at + 16] != 3 or data[at + 17] == 0 or number <= 0) continue;
            const section: usize = @intCast(number - 1);
            if (!coff.comdat(section)) continue;
            const name = try coff.sectionName(section);
            if (!std.mem.eql(u8, coff.symbolName(at), name)) continue;
            const aux = at + 18;
            const next = i + 1 + data[at + 17];
            // Associative, or followed by its COMDAT symbol.
            if (data[aux + 14] == 5 or (next < coff.count and read(i16, data, coff.symtab + next * 18 + 12) == number)) continue;
            const unwind = std.mem.startsWith(u8, name, ".xdata$") or std.mem.startsWith(u8, name, ".pdata$");
            const suffix = if (unwind) name[".xdata$".len..] else "";
            if (pass != @as(u2, if (!unwind) 0 else if (suffix.len == 0) 1 else 2)) continue;
            if (!unwind) {
                if (data[aux + 14] != 1) return fail("{s}: COMDAT section {s} has no symbol", .{ member.name, name });
                coff.ordinary(section, aux);
                continue;
            }
            if (suffix.len == 0) {
                coff.ordinary(section, aux);
                if (name[1] == 'p') try coff.ordinaryTargets(member, section);
                continue;
            }
            const text = for (0..coff.sections) |t| {
                const candidate = try coff.sectionName(t);
                if (std.mem.startsWith(u8, candidate, ".text$") and std.mem.eql(u8, candidate[".text$".len..], suffix)) break t;
            } else return fail("{s}: {s} has no .text${s}", .{ member.name, name, suffix });
            if (!coff.comdat(text)) {
                coff.ordinary(section, aux);
                continue;
            }
            data[aux + 14] = 5;
            std.mem.writeInt(u16, data[aux + 12 ..][0..2], @intCast(text + 1), .little);
        }
    }
}

/// The external names a COFF object defines and uses, and whether it has
/// GCC-style constructor or destructor sections.
fn parse(arena: std.mem.Allocator, member: Member) !Object {
    const coff = try Coff.init(member);
    const data = coff.data;
    var constructors = false;
    for (0..coff.sections) |i| {
        const name = try coff.sectionName(i);
        constructors = constructors or std.mem.startsWith(u8, name, ".ctors") or std.mem.startsWith(u8, name, ".dtors");
    }
    var defined: std.ArrayList([]const u8) = .empty;
    var strong: std.ArrayList([]const u8) = .empty;
    var undefined_names: std.ArrayList([]const u8) = .empty;
    var i: usize = 0;
    while (i < coff.count) : (i += 1 + data[coff.symtab + i * 18 + 17]) {
        const at = coff.symtab + i * 18;
        const name = coff.symbolName(at);
        const section = read(i16, data, at + 12);
        switch (data[at + 16]) {
            // External: undefined with no section and no size, else defined, or common.
            2 => try (if (section == 0 and read(u32, data, at + 8) == 0) &undefined_names else &defined).append(arena, name),
            // A weak external has a default, so it defines its name.
            105 => try defined.append(arena, name),
            else => {},
        }
        if (data[at + 16] == 2 and section > 0) try strong.append(arena, name);
    }
    return .{ .defined = defined.items, .strong = strong.items, .undefined = undefined_names.items, .constructors = constructors };
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
