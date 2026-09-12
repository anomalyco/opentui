const buffer = @import("../buffer.zig");

pub const Error = error{Unsupported};

pub const Cursor = struct {
    x: u16 = 0,
    y: u16 = 0,
    has_value: bool = false,
    visible: bool = false,
    blinking: bool = false,
    wide_tail: bool = false,
    style: u8 = 1,
    color: ?struct { r: u8, g: u8, b: u8 } = null,
};

pub const EmbeddedTerminal = struct {
    pub fn init(_: anytype, _: anytype, _: anytype) Error!*EmbeddedTerminal {
        return error.Unsupported;
    }

    pub fn deinit(_: *EmbeddedTerminal) void {}
    pub fn write(_: *EmbeddedTerminal, _: []const u8) Error!void {
        return error.Unsupported;
    }
    pub fn resize(_: *EmbeddedTerminal, _: u16, _: u16) Error!void {
        return error.Unsupported;
    }
    pub fn scroll(_: *EmbeddedTerminal, _: i32) void {}
    pub fn setSelection(_: *EmbeddedTerminal, _: anytype, _: anytype) Error!void {
        return error.Unsupported;
    }
    pub fn clearSelection(_: *EmbeddedTerminal) void {}
    pub fn selectedText(_: *EmbeddedTerminal) Error![:0]const u8 {
        return error.Unsupported;
    }
    pub fn freeSelectedText(_: *EmbeddedTerminal, _: [:0]const u8) void {}
    pub fn invalidate(_: *EmbeddedTerminal) void {}
    pub fn compose(_: *EmbeddedTerminal, _: *buffer.OptimizedBuffer, _: i32, _: i32) Error!void {
        return error.Unsupported;
    }
    pub fn cursor(_: *EmbeddedTerminal) Cursor {
        return .{};
    }
    pub fn encodePaste(_: *EmbeddedTerminal, _: []const u8) Error![]u8 {
        return error.Unsupported;
    }
    pub fn encodeFocus(_: *EmbeddedTerminal, _: bool) Error![]u8 {
        return error.Unsupported;
    }
    pub fn freeEncoded(_: *EmbeddedTerminal, _: []u8) void {}
    pub fn drainResponses(_: *EmbeddedTerminal, _: []u8) Error!usize {
        return error.Unsupported;
    }
};
