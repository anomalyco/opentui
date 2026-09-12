pub const ansi = @import("ansi.zig");
pub const audio = @import("audio.zig");
pub const buffer = @import("buffer.zig");
pub const renderer = @import("renderer.zig");
pub const text_buffer = @import("text-buffer.zig");
pub const text_buffer_view = @import("text-buffer-view.zig");
/// Preliminary, unstable API. May change or be removed at any time without compatibility guarantees.
/// Temporary access for native integration until OpenTUI has a native render tree.
pub const yoga_c = @import("yoga");

pub const BufferedOutput = renderer.BufferedOutput;
pub const CliRenderer = renderer.CliRenderer;
pub const GraphemePool = @import("grapheme.zig").GraphemePool;
pub const LinkPool = @import("link.zig").LinkPool;
pub const OptimizedBuffer = buffer.OptimizedBuffer;
pub const RGBA = ansi.RGBA;
pub const TextAttributes = ansi.TextAttributes;
pub const UnifiedTextBuffer = text_buffer.UnifiedTextBuffer;
pub const UnifiedTextBufferView = text_buffer_view.UnifiedTextBufferView;
pub const rgbColor = ansi.rgbColor;
