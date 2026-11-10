//! Writes a copy of a Linux libopentui.a that carries Zig's libc++ and
//! libc++abi privately, so a C, Rust, or Zig program links it without a system
//! libc++, and its own C++ runtime (libstdc++, or another libc++) never binds to
//! OpenTUI's.
//!
//! Usage: bundle-libcxx <zig> <target> <optimize> <probe.cpp> <in.a> <out.a>
//!
//! A static library never carries libc++, and the build API offers no path to
//! the archives Zig builds. So this links a stripped C++ probe for the same
//! target and mode and takes both archives from the probe's linker line. The
//! members that call into the C++ runtime (Yoga and its bridge) are linked with
//! it into one relocatable object, whose symbols turn local except those the
//! other members use. The other members stay as they are, so a program still
//! links only the ones it needs. libunwind and compiler-rt stay out: the
//! program's own toolchain supplies unwinding and builtins.

const std = @import("std");
const elf = std.elf;

const Member = struct { name: []const u8, data: []u8 };
const Names = std.StringHashMapUnmanaged(void);

pub fn main(init: std.process.Init) !void {
    const arena = init.arena.allocator();
    const io = init.io;
    const args = try init.minimal.args.toSlice(arena);
    if (args.len != 7) return error.Usage;
    const zig, const target, const optimize, const probe, const input, const output =
        .{ args[1], args[2], args[3], args[4], args[5], args[6] };
    const cwd = std.Io.Dir.cwd();
    const work = try std.fmt.allocPrint(arena, "{s}.d", .{output});
    try cwd.deleteTree(io, work);
    try cwd.createDirPath(io, work);

    // An explicit -femit-bin links on every run, so the linker line prints even when Zig's cache has the probe.
    const emit = try std.fmt.allocPrint(arena, "-femit-bin={s}/probe.so", .{work});
    const link = try run(arena, io, &.{
        zig, "build-lib", "-dynamic", "-lc++", "-fstrip", "-fPIC", "--verbose-link", "-target", target, "-O", optimize, probe, emit,
    });
    var line: ?[]const u8 = null;
    var lines = std.mem.splitScalar(u8, link, '\n');
    while (lines.next()) |raw| {
        if (std.mem.startsWith(u8, raw, "ld.lld ")) line = std.mem.trimEnd(u8, raw, "\r");
    }
    if (line == null) return fail("no ld.lld line in the probe's output:\n{s}", .{link});
    const libcxx = try archivePath(io, line.?, "libc++.a");
    const libcxxabi = try archivePath(io, line.?, "libc++abi.a");

    // Every symbol the C++ runtime defines.
    var runtime: Names = .empty;
    for ([_][]const u8{ libcxx, libcxxabi }) |path| {
        for (try readArchive(arena, io, path)) |member| try symbols(arena, member, .defined, &runtime);
    }
    // Members that call into the runtime go into one object; the rest keep the symbols they need from it.
    var cxx: std.ArrayList([]const u8) = .empty;
    var rest: std.ArrayList(Member) = .empty;
    var needed: Names = .empty;
    for (try readArchive(arena, io, input)) |member| {
        var undefined_names: Names = .empty;
        try symbols(arena, member, .undefined, &undefined_names);
        var calls_runtime = false;
        var it = undefined_names.keyIterator();
        while (it.next()) |name| calls_runtime = calls_runtime or runtime.contains(name.*);
        if (!calls_runtime) {
            try rest.append(arena, member);
            it = undefined_names.keyIterator();
            while (it.next()) |name| try needed.put(arena, name.*, {});
            continue;
        }
        const path = try std.fmt.allocPrint(arena, "{s}/{d}-{s}", .{ work, cxx.items.len, std.fs.path.basename(member.name) });
        try cwd.writeFile(io, .{ .sub_path = path, .data = member.data });
        try cxx.append(arena, path);
    }
    if (cxx.items.len == 0) return fail("no member of {s} uses the C++ runtime", .{input});

    // --force-group-allocation merges COMDAT groups, so the object has no groups to keep in step with its symbols.
    const object = try std.fmt.allocPrint(arena, "{s}/opentui-cxx.o", .{work});
    var argv: std.ArrayList([]const u8) = .empty;
    try argv.appendSlice(arena, &.{ zig, "ld.lld", "-r", "--force-group-allocation", "-o", object });
    try argv.appendSlice(arena, cxx.items);
    try argv.appendSlice(arena, &.{ "--start-group", libcxx, libcxxabi, "--end-group" });
    _ = try run(arena, io, argv.items);
    const data = try cwd.readFileAlloc(io, object, arena, .unlimited);
    try localize(arena, data, &needed);
    try rest.append(arena, .{ .name = "opentui-cxx.o", .data = data });

    try cwd.writeFile(io, .{ .sub_path = output, .data = try writeArchive(arena, rest.items) });
    _ = try run(arena, io, &.{ zig, "ar", "s", output });
    try cwd.deleteTree(io, work);
}

/// The path of `name` on the probe's linker line. Zig prints paths unquoted, so
/// a path may hold spaces: the path is the shortest absolute one that exists.
fn archivePath(io: std.Io, line: []const u8, name: []const u8) ![]const u8 {
    var at: usize = 0;
    const end = while (std.mem.indexOfPos(u8, line, at, name)) |found| : (at = found + 1) {
        const after = found + name.len;
        const whole = (after == line.len or line[after] == ' ') and (line[found - 1] == '/' or line[found - 1] == '\\');
        if (whole) break after;
    } else return fail("no {s} on the probe's linker line:\n{s}", .{ name, line });
    var start = end - name.len;
    while (std.mem.lastIndexOfScalar(u8, line[0..start], ' ')) |space| : (start = space) {
        const path = line[space + 1 .. end];
        if (!std.fs.path.isAbsolute(path)) continue;
        std.Io.Dir.cwd().access(io, path, .{}) catch continue;
        return path;
    }
    return fail("no existing path ends in {s} on the probe's linker line:\n{s}", .{ name, line });
}

/// The members of a GNU archive, as Zig and llvm-ar write it.
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
        if (std.mem.eql(u8, raw, "/") or std.mem.eql(u8, raw, "/SYM64/")) continue;
        if (std.mem.eql(u8, raw, "//")) {
            names = data;
            continue;
        }
        const name = if (raw.len > 1 and raw[0] == '/') long: {
            const offset = try std.fmt.parseInt(usize, raw[1..], 10);
            const len = std.mem.indexOfPos(u8, names, offset, "/\n") orelse return fail("{s}: bad member name", .{path});
            break :long names[offset..len];
        } else if (std.mem.endsWith(u8, raw, "/")) raw[0 .. raw.len - 1] else return fail("{s}: member name {s} is not GNU", .{ path, raw });
        try members.append(arena, .{ .name = name, .data = data });
    }
    return members.items;
}

/// Writes a GNU archive without a symbol table; `zig ar s` adds it.
fn writeArchive(arena: std.mem.Allocator, members: []const Member) ![]u8 {
    var names: std.ArrayList(u8) = .empty;
    for (members) |member| try names.print(arena, "{s}/\n", .{member.name});
    var out: std.ArrayList(u8) = .empty;
    try out.appendSlice(arena, "!<arch>\n");
    try appendMember(arena, &out, "//", names.items);
    var offset: usize = 0;
    for (members) |member| {
        try appendMember(arena, &out, try std.fmt.allocPrint(arena, "/{d}", .{offset}), member.data);
        offset += member.name.len + 2;
    }
    return out.items;
}

fn appendMember(arena: std.mem.Allocator, out: *std.ArrayList(u8), name: []const u8, data: []const u8) !void {
    try out.print(arena, "{s: <16}{s: <12}{s: <6}{s: <6}{s: <8}{d: <10}`\n", .{ name, "0", "0", "0", "644", data.len });
    try out.appendSlice(arena, data);
    if (data.len % 2 == 1) try out.append(arena, '\n');
}

const Object = struct {
    shdrs: []elf.Elf64_Shdr,
    symtab: usize,

    /// Linux targets are 64-bit little-endian; anything else fails the build.
    fn parse(arena: std.mem.Allocator, data: []const u8) !Object {
        if (data.len < 64 or !std.mem.startsWith(u8, data, elf.MAGIC) or data[elf.EI_CLASS] != elf.ELFCLASS64 or
            data[elf.EI_DATA] != elf.ELFDATA2LSB) return error.NotElf64Le;
        const shoff = std.mem.readInt(u64, data[40..48], .little);
        const shnum = std.mem.readInt(u16, data[60..62], .little);
        if (shnum == 0 or shnum >= elf.SHN_LORESERVE) return error.TooManySections;
        const shdrs = try arena.alloc(elf.Elf64_Shdr, shnum);
        var symtab: ?usize = null;
        for (shdrs, 0..) |*shdr, i| {
            shdr.* = std.mem.bytesToValue(elf.Elf64_Shdr, data[shoff + i * @sizeOf(elf.Elf64_Shdr) ..][0..@sizeOf(elf.Elf64_Shdr)]);
            if (shdr.sh_type == elf.SHT_SYMTAB) symtab = i;
            if (shdr.sh_type == elf.SHT_SYMTAB_SHNDX) return error.TooManySections;
        }
        return .{ .shdrs = shdrs, .symtab = symtab orelse return error.NoSymbolTable };
    }

    fn sym(object: Object, data: []const u8, i: usize) elf.Elf64_Sym {
        const at = object.shdrs[object.symtab].sh_offset + i * @sizeOf(elf.Elf64_Sym);
        return std.mem.bytesToValue(elf.Elf64_Sym, data[at..][0..@sizeOf(elf.Elf64_Sym)]);
    }

    fn count(object: Object) usize {
        return object.shdrs[object.symtab].sh_size / @sizeOf(elf.Elf64_Sym);
    }

    fn name(object: Object, data: []const u8, s: elf.Elf64_Sym) []const u8 {
        const strtab = object.shdrs[object.shdrs[object.symtab].sh_link];
        return std.mem.sliceTo(data[strtab.sh_offset + s.st_name ..], 0);
    }
};

/// Adds a member's global names that it defines, or that it uses without defining.
fn symbols(arena: std.mem.Allocator, member: Member, kind: enum { defined, undefined }, out: *Names) !void {
    const object = Object.parse(arena, member.data) catch |err| return fail("member {s}: {t}", .{ member.name, err });
    for (1..object.count()) |i| {
        const s = object.sym(member.data, i);
        if (s.st_bind() == elf.STB_LOCAL or (s.st_shndx == elf.SHN_UNDEF) != (kind == .undefined)) continue;
        try out.put(arena, object.name(member.data, s), {});
    }
}

/// Makes every symbol the object defines local, except those in `keep`. ELF
/// lists local symbols first, so this reorders the table and renumbers the
/// relocations that point into it.
fn localize(arena: std.mem.Allocator, data: []u8, keep: *const Names) !void {
    const object = try Object.parse(arena, data);
    const n = object.count();
    const old = try arena.alloc(elf.Elf64_Sym, n);
    for (old, 0..) |*s, i| s.* = object.sym(data, i);
    const new_index = try arena.alloc(u32, n);
    var next: u32 = 0;
    for ([_]bool{ true, false }) |local_pass| {
        for (old, 0..) |*s, i| {
            const local = s.st_bind() == elf.STB_LOCAL or
                (s.st_shndx != elf.SHN_UNDEF and !keep.contains(object.name(data, s.*)));
            if (local != local_pass) continue;
            if (local) s.st_info = @as(u8, elf.STB_LOCAL) << 4 | s.st_type();
            new_index[i] = next;
            const at = object.shdrs[object.symtab].sh_offset + next * @sizeOf(elf.Elf64_Sym);
            @memcpy(data[at..][0..@sizeOf(elf.Elf64_Sym)], std.mem.asBytes(s));
            next += 1;
        }
        if (local_pass) object.shdrs[object.symtab].sh_info = next;
    }
    const shoff = std.mem.readInt(u64, data[40..48], .little);
    for (object.shdrs, 0..) |*shdr, i| {
        if (shdr.sh_link != object.symtab and i != object.symtab) continue;
        switch (shdr.sh_type) {
            elf.SHT_RELA, elf.SHT_REL => {
                const size: usize = if (shdr.sh_type == elf.SHT_RELA) @sizeOf(elf.Elf64_Rela) else @sizeOf(elf.Elf64_Rel);
                var at = shdr.sh_offset + 8;
                while (at < shdr.sh_offset + shdr.sh_size) : (at += size) {
                    const info = std.mem.readInt(u64, data[at..][0..8], .little);
                    const index: u64 = new_index[@intCast(info >> 32)];
                    std.mem.writeInt(u64, data[at..][0..8], index << 32 | (info & 0xffff_ffff), .little);
                }
            },
            // The address-significance table lists symbol indices; without it the linker only folds less.
            elf.SHT_LLVM_ADDRSIG => shdr.sh_size = 0,
            elf.SHT_GROUP => return error.UnexpectedGroup,
            else => {},
        }
        @memcpy(data[shoff + i * @sizeOf(elf.Elf64_Shdr) ..][0..@sizeOf(elf.Elf64_Shdr)], std.mem.asBytes(shdr));
    }
}

/// Runs a command and returns its stderr; fails unless it exits with 0.
fn run(arena: std.mem.Allocator, io: std.Io, argv: []const []const u8) ![]const u8 {
    const result = try std.process.run(arena, io, .{ .argv = argv });
    if (result.term != .exited or result.term.exited != 0) {
        return fail("{s} {s} failed:\n{s}", .{ argv[0], argv[1], result.stderr });
    }
    return result.stderr;
}

fn fail(comptime format: []const u8, args: anytype) error{BundleLibcxx} {
    std.debug.print("bundle-libcxx: " ++ format ++ "\n", args);
    return error.BundleLibcxx;
}
