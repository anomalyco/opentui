const ansi = @import("ansi.zig");

/// Re-exported from ansi.zig so modules that only need the type don't depend
/// on the full ANSI module.
pub const RGBA = ansi.RGBA;

/// Read 4 consecutive u16 values from a raw pointer into an RGBA color.
/// Used to unpack colors from the FFI boundary where TypeScript passes
/// packed u16 arrays (see StyledChunk.fg_ptr / bg_ptr).
pub fn ptrToRGBA(ptr: [*]const u16) RGBA {
    return .{ ptr[0], ptr[1], ptr[2], ptr[3] };
}
