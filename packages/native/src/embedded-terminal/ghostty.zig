const vt = @import("../ghostty-vt.zig").vt;

pub const Terminal = vt.Terminal;
pub const TerminalStream = vt.TerminalStream;
pub const Coordinate = vt.Coordinate;
pub const RenderState = vt.RenderState;
pub const Selection = vt.Selection;

pub const Key = struct {
    action: vt.input.KeyAction = .press,
    key: vt.input.Key = .unidentified,
    mods: vt.input.KeyMods = .{},
    consumed_mods: vt.input.KeyMods = .{},
    composing: bool = false,
    utf8: []const u8 = "",
    unshifted_codepoint: u21 = 0,

    pub fn event(self: Key) vt.input.KeyEvent {
        return .{
            .action = self.action,
            .key = self.key,
            .mods = self.mods,
            .consumed_mods = self.consumed_mods,
            .composing = self.composing,
            .utf8 = self.utf8,
            .unshifted_codepoint = self.unshifted_codepoint,
        };
    }
};

pub const Mouse = struct {
    action: vt.input.MouseAction,
    button: ?vt.input.MouseButton = null,
    mods: vt.input.KeyMods = .{},
    x: f32,
    y: f32,
    any_button_pressed: bool = false,

    pub fn event(self: Mouse) vt.input.MouseEncodeEvent {
        return .{
            .action = self.action,
            .button = self.button,
            .mods = self.mods,
            .pos = .{ .x = self.x, .y = self.y },
        };
    }
};

pub const MouseEncodeOptions = vt.input.MouseEncodeOptions;
pub const encodeKey = vt.input.encodeKey;
pub const encodeMouse = vt.input.encodeMouse;
pub const encodePaste = vt.input.encodePaste;
pub const encodeFocus = vt.input.encodeFocus;
