const std = @import("std");
const c = @import("context_abi_c");

// Reflect the same Translate-C module used by the native implementation. No C parsing
// or guessed padding belongs in the TypeScript generator.
pub const json = blk: {
    @setEvalBranchQuota(2_000_000);
    var symbols: []const u8 = "";
    var callbacks: []const u8 = "";
    var layouts: []const u8 = "";
    var constants: []const u8 = "";
    for (@typeInfo(c).@"struct".decls) |decl| {
        if (!std.mem.startsWith(u8, decl.name, "OT_") and
            !std.mem.startsWith(u8, decl.name, "ot_")) continue;
        const value = @field(c, decl.name);
        if (std.mem.startsWith(u8, decl.name, "OT_")) {
            switch (@typeInfo(@TypeOf(value))) {
                .int, .comptime_int => {
                    constants = constants ++ separator(constants) ++ quote(decl.name) ++ ":" ++
                        std.fmt.comptimePrint("{d}", .{value});
                },
                else => @compileError("Unsupported ABI constant: " ++ decl.name),
            }
        } else if (std.mem.startsWith(u8, decl.name, "ot_")) {
            if (@TypeOf(value) == type) {
                switch (@typeInfo(value)) {
                    .@"struct" => layouts = layouts ++ separator(layouts) ++ quote(decl.name) ++ ":" ++ layout(value),
                    .optional, .pointer => callbacks = callbacks ++ separator(callbacks) ++ quote(decl.name) ++ ":" ++ function(callback(value)),
                    .int => {},
                    .@"opaque" => {
                        if (!std.mem.eql(u8, decl.name, "ot_context"))
                            @compileError("Unsupported opaque ABI type: " ++ decl.name);
                    },
                    else => @compileError("Unsupported ABI typedef: " ++ decl.name),
                }
            } else if (@typeInfo(@TypeOf(value)) == .@"fn") {
                symbols = symbols ++ separator(symbols) ++ quote(decl.name) ++ ":" ++ function(@TypeOf(value));
            } else {
                @compileError("Unsupported ABI declaration: " ++ decl.name);
            }
        }
    }
    break :blk "{\"symbols\":{" ++ symbols ++ "},\"callbacks\":{" ++ callbacks ++
        "},\"layouts\":{" ++ layouts ++ "},\"constants\":{" ++ constants ++ "}}";
};

fn separator(comptime text: []const u8) []const u8 {
    return if (text.len == 0) "" else ",";
}

fn quote(comptime text: []const u8) []const u8 {
    return "\"" ++ text ++ "\"";
}

fn callback(comptime T: type) type {
    return switch (@typeInfo(T)) {
        .optional => |info| callback(info.child),
        .pointer => |info| if (@typeInfo(info.child) == .@"fn") info.child else @compileError("ABI pointer typedef needs explicit support: " ++ @typeName(T)),
        else => @compileError("Not a callback: " ++ @typeName(T)),
    };
}

fn name(comptime T: type) []const u8 {
    return switch (@typeInfo(T)) {
        .void => "void",
        .int => |info| switch (info.bits) {
            8, 16, 32, 64 => std.fmt.comptimePrint("{s}{d}", .{ if (info.signedness == .signed) "i" else "u", info.bits }),
            else => @compileError("Unsupported ABI integer: " ++ @typeName(T)),
        },
        .float => |info| switch (info.bits) {
            32, 64 => std.fmt.comptimePrint("f{d}", .{info.bits}),
            else => @compileError("Unsupported ABI float: " ++ @typeName(T)),
        },
        .optional => |info| name(info.child),
        .pointer => |info| if (@typeInfo(info.child) == .@"fn") blk: {
            const signature = @typeInfo(info.child).@"fn";
            if (signature.is_var_args or signature.is_generic)
                @compileError("Unsupported ABI callback: " ++ @typeName(T));
            if (!std.meta.eql(signature.calling_convention, std.builtin.CallingConvention.c))
                @compileError("Unsupported ABI calling convention: " ++ @typeName(T));
            var args: []const u8 = "";
            for (signature.params) |param|
                args = args ++ separator(args) ++ name(param.type.?);
            break :blk "callback(" ++ args ++ ")->" ++ name(signature.return_type.?);
        } else "*" ++ (if (info.is_const) "const " else "") ++ name(info.child),
        .array => |info| std.fmt.comptimePrint("[{d}]{s}", .{ info.len, name(info.child) }),
        .@"struct", .@"opaque" => blk: {
            const full = @typeName(T);
            const short = full[(std.mem.lastIndexOfScalar(u8, full, '.') orelse
                @compileError("Expected translated C type: " ++ full)) + 1 ..];
            const record = if (std.mem.startsWith(u8, short, "struct_")) short[7..] else short;
            // Named ot_ records are reflected separately. Anonymous/private nested
            // records would hide their fields and must not produce partial metadata.
            if (!std.mem.startsWith(u8, record, "ot_") or !@hasDecl(c, record))
                @compileError("Unsupported nested ABI record: " ++ full);
            if (@TypeOf(@field(c, record)) != type)
                @compileError("Unsupported nested ABI record: " ++ full);
            if (@field(c, record) != T)
                @compileError("Unsupported nested ABI record: " ++ full);
            break :blk record;
        },
        else => @compileError("Unsupported ABI type: " ++ @typeName(T)),
    };
}

fn function(comptime T: type) []const u8 {
    const info = @typeInfo(T).@"fn";
    if (info.is_var_args or info.is_generic) @compileError("Unsupported ABI function: " ++ @typeName(T));
    if (!std.meta.eql(info.calling_convention, std.builtin.CallingConvention.c))
        @compileError("Unsupported ABI calling convention: " ++ @typeName(T));
    var args: []const u8 = "";
    for (info.params) |param| args = args ++ separator(args) ++ quote(name(param.type.?));
    return "{\"args\":[" ++ args ++ "],\"returns\":" ++ quote(name(info.return_type.?)) ++ "}";
}

fn layout(comptime T: type) []const u8 {
    if (@typeInfo(T).@"struct".layout != .@"extern") @compileError("Expected C record: " ++ @typeName(T));
    var fields: []const u8 = "";
    for (@typeInfo(T).@"struct".fields) |field| {
        fields = fields ++ separator(fields) ++ quote(field.name) ++ ":" ++ std.fmt.comptimePrint(
            "{{\"offset\":{d},\"size\":{d},\"alignment\":{d},\"type\":{s}}}",
            .{ @offsetOf(T, field.name), @sizeOf(field.type), field.alignment orelse @alignOf(field.type), quote(name(field.type)) },
        );
    }
    return std.fmt.comptimePrint("{{\"size\":{d},\"alignment\":{d},\"fields\":{{{s}}}}}", .{ @sizeOf(T), @alignOf(T), fields });
}

pub fn main(init: std.process.Init) !void {
    var buffer: [4096]u8 = undefined;
    var stdout = std.Io.File.stdout().writer(init.io, &buffer);
    try stdout.interface.writeAll(json);
    try stdout.interface.flush();
}
