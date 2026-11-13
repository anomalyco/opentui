// @generated from packages/native/include/opentui.h by packages/core/scripts/native-abi-rust.ts. Do not edit.
// Regenerate with `bun run generate:abi` in packages/core.

use core::ffi::c_void;

/// FNV-1a 64-bit hash of the `opentui.h` these declarations were generated from.
/// The build script rejects native artifacts whose header has a different hash.
pub const OPENTUI_HEADER_FNV1A64: u64 = 0x34ec93e20f4ce940;

pub type ot_status = i32;

/// Opaque native Context. Only pointers to it cross the ABI.
#[repr(C)]
pub struct ot_context {
    _data: [u8; 0],
    _marker: core::marker::PhantomData<(*mut u8, core::marker::PhantomPinned)>,
}

pub const OT_CONTEXT_ABI_VERSION: u32 = 2;
pub const OT_OK: i32 = 0;
pub const OT_INVALID_ARGUMENT: i32 = -1;
pub const OT_UNSUPPORTED_VERSION: i32 = -2;
pub const OT_OUT_OF_MEMORY: i32 = -3;
pub const OT_WRONG_THREAD: i32 = -4;
pub const OT_INTERNAL_ERROR: i32 = -5;
pub const OT_CONTEXT_BUSY: i32 = -6;
pub const OT_WRONG_CONTEXT: i32 = -7;
pub const OT_WRONG_KIND: i32 = -8;
pub const OT_STALE_HANDLE: i32 = -9;
pub const OT_WRONG_SESSION: i32 = -10;
pub const OT_OUTPUT_BACKPRESSURE: i32 = -11;
pub const OT_SESSION_CLOSED: i32 = -12;
pub const OT_OUTPUT_BUSY: i32 = -13;
pub const OT_STALE_OUTPUT: i32 = -14;
pub const OT_OUTPUT_FAILED: i32 = -15;
pub const OT_OBJECT_LIMIT: i32 = -16;
pub const OT_RENDERER_ATTACHED: i32 = -17;
pub const OT_RENDERER_NOT_ATTACHED: i32 = -18;
pub const OT_INVALID_PHASE: i32 = -19;
pub const OT_CONTROL_PACKET_LIMIT: i32 = -20;
pub const OT_LEASE_LIMIT: i32 = -21;
pub const OT_LEASE_BYTES_LIMIT: i32 = -22;
pub const OT_STALE_LEASE: i32 = -23;
pub const OT_UNSUPPORTED_RESOURCE: i32 = -24;
pub const OT_STALE_FRAME: i32 = -25;
pub const OT_LAYOUT_LIMIT: i32 = -26;
pub const OT_FRAME_BUSY: i32 = -27;
pub const OT_FRAME_REQUEST_LIMIT: i32 = -28;
pub const OT_IMAGE_UNSUPPORTED_FORMAT: i32 = -40;
pub const OT_IMAGE_UNSUPPORTED_COLOR_SPACE: i32 = -41;
pub const OT_IMAGE_MALFORMED_DATA: i32 = -42;
pub const OT_IMAGE_DIMENSION_LIMIT: i32 = -43;
pub const OT_IMAGE_MEMORY_LIMIT: i32 = -44;
pub const OT_IMAGE_OUTPUT_TOO_SMALL: i32 = -45;
pub const OT_IMAGE_UNSUPPORTED_FEATURE: i32 = -46;
pub const OT_IMAGE_BUSY: i32 = -47;
pub const OT_VIDEO_FAILED: i32 = -60;
pub const OT_AUDIO_DECODE_FAILED: i32 = -61;
pub const OT_AUDIO_DEVICE_FAILED: i32 = -62;
pub const OT_SCENE_ROOT: u32 = 0;
pub const OT_SCENE_BOX: u32 = 1;
pub const OT_SCENE_TEXT: u32 = 2;
pub const OT_SCENE_SLIDER: u32 = 3;
pub const OT_SCENE_ARROW: u32 = 4;
pub const OT_SCENE_EDITOR: u32 = 5;
pub const OT_SCENE_CUSTOM: u32 = 6;
pub const OT_SCENE_TEXT_VIEW: u32 = 7;
pub const OT_SCENE_IMAGE: u32 = 8;
pub const OT_SCENE_VIDEO: u32 = 9;
pub const OT_SCENE_WRAP_NONE: u32 = 0;
pub const OT_SCENE_WRAP_CHAR: u32 = 1;
pub const OT_SCENE_WRAP_WORD: u32 = 2;
pub const OT_SCENE_ALIGN_LEFT: u32 = 0;
pub const OT_SCENE_ALIGN_CENTER: u32 = 1;
pub const OT_SCENE_ALIGN_RIGHT: u32 = 2;
pub const OT_STYLE_ENUM: u32 = 0;
pub const OT_STYLE_FLOAT: u32 = 1;
pub const OT_STYLE_VALUE: u32 = 2;
pub const OT_STYLE_BORDER: u32 = 3;
pub const OT_STYLE_DIMENSION: u32 = 4;
pub const OT_STYLE_BORDER_WIDTH: u32 = 0;
pub const OT_STYLE_FLAGS_NONE: u32 = 0;
pub const OT_STYLE_DISABLE_FLEX_SHRINK: u32 = 1;
pub const OT_STYLE_CONTENT: u32 = 2;
pub const OT_STYLE_ENUM_DIRECTION: u32 = 0;
pub const OT_STYLE_ENUM_FLEX_DIRECTION: u32 = 1;
pub const OT_STYLE_ENUM_JUSTIFY_CONTENT: u32 = 2;
pub const OT_STYLE_ENUM_ALIGN_CONTENT: u32 = 3;
pub const OT_STYLE_ENUM_ALIGN_ITEMS: u32 = 4;
pub const OT_STYLE_ENUM_ALIGN_SELF: u32 = 5;
pub const OT_STYLE_ENUM_POSITION_TYPE: u32 = 6;
pub const OT_STYLE_ENUM_FLEX_WRAP: u32 = 7;
pub const OT_STYLE_ENUM_OVERFLOW: u32 = 8;
pub const OT_STYLE_ENUM_DISPLAY: u32 = 9;
pub const OT_STYLE_ENUM_BOX_SIZING: u32 = 10;
pub const OT_STYLE_ENUM_LAYOUT_MODE: u32 = 11;
pub const OT_STYLE_FLOAT_FLEX: u32 = 0;
pub const OT_STYLE_FLOAT_FLEX_GROW: u32 = 1;
pub const OT_STYLE_FLOAT_FLEX_SHRINK: u32 = 2;
pub const OT_STYLE_FLOAT_ASPECT_RATIO: u32 = 3;
pub const OT_STYLE_VALUE_WIDTH: u32 = 0;
pub const OT_STYLE_VALUE_HEIGHT: u32 = 1;
pub const OT_STYLE_VALUE_MIN_WIDTH: u32 = 2;
pub const OT_STYLE_VALUE_MIN_HEIGHT: u32 = 3;
pub const OT_STYLE_VALUE_MAX_WIDTH: u32 = 4;
pub const OT_STYLE_VALUE_MAX_HEIGHT: u32 = 5;
pub const OT_STYLE_VALUE_FLEX_BASIS: u32 = 6;
pub const OT_STYLE_VALUE_MARGIN: u32 = 7;
pub const OT_STYLE_VALUE_PADDING: u32 = 8;
pub const OT_STYLE_VALUE_POSITION: u32 = 9;
pub const OT_STYLE_VALUE_GAP: u32 = 10;
pub const OT_DIMENSION_WIDTH: u32 = 0;
pub const OT_DIMENSION_HEIGHT: u32 = 1;
pub const OT_UNIT_UNDEFINED: u32 = 0;
pub const OT_UNIT_POINT: u32 = 1;
pub const OT_UNIT_PERCENT: u32 = 2;
pub const OT_UNIT_AUTO: u32 = 3;
pub const OT_EDGE_NONE: u32 = 0;
pub const OT_EDGE_LEFT: u32 = 0;
pub const OT_EDGE_TOP: u32 = 1;
pub const OT_EDGE_RIGHT: u32 = 2;
pub const OT_EDGE_BOTTOM: u32 = 3;
pub const OT_EDGE_START: u32 = 4;
pub const OT_EDGE_END: u32 = 5;
pub const OT_EDGE_HORIZONTAL: u32 = 6;
pub const OT_EDGE_VERTICAL: u32 = 7;
pub const OT_EDGE_ALL: u32 = 8;
pub const OT_GUTTER_COLUMN: u32 = 0;
pub const OT_GUTTER_ROW: u32 = 1;
pub const OT_GUTTER_ALL: u32 = 2;
pub const OT_DIRECTION_INHERIT: u32 = 0;
pub const OT_DIRECTION_LTR: u32 = 1;
pub const OT_DIRECTION_RTL: u32 = 2;
pub const OT_FLEX_DIRECTION_COLUMN: u32 = 0;
pub const OT_FLEX_DIRECTION_COLUMN_REVERSE: u32 = 1;
pub const OT_FLEX_DIRECTION_ROW: u32 = 2;
pub const OT_FLEX_DIRECTION_ROW_REVERSE: u32 = 3;
pub const OT_JUSTIFY_FLEX_START: u32 = 0;
pub const OT_JUSTIFY_CENTER: u32 = 1;
pub const OT_JUSTIFY_FLEX_END: u32 = 2;
pub const OT_JUSTIFY_SPACE_BETWEEN: u32 = 3;
pub const OT_JUSTIFY_SPACE_AROUND: u32 = 4;
pub const OT_JUSTIFY_SPACE_EVENLY: u32 = 5;
pub const OT_ALIGN_AUTO: u32 = 0;
pub const OT_ALIGN_FLEX_START: u32 = 1;
pub const OT_ALIGN_CENTER: u32 = 2;
pub const OT_ALIGN_FLEX_END: u32 = 3;
pub const OT_ALIGN_STRETCH: u32 = 4;
pub const OT_ALIGN_BASELINE: u32 = 5;
pub const OT_ALIGN_SPACE_BETWEEN: u32 = 6;
pub const OT_ALIGN_SPACE_AROUND: u32 = 7;
pub const OT_ALIGN_SPACE_EVENLY: u32 = 8;
pub const OT_POSITION_STATIC: u32 = 0;
pub const OT_POSITION_RELATIVE: u32 = 1;
pub const OT_POSITION_ABSOLUTE: u32 = 2;
pub const OT_FLEX_WRAP_NONE: u32 = 0;
pub const OT_FLEX_WRAP_WRAP: u32 = 1;
pub const OT_FLEX_WRAP_REVERSE: u32 = 2;
pub const OT_OVERFLOW_VISIBLE: u32 = 0;
pub const OT_OVERFLOW_HIDDEN: u32 = 1;
pub const OT_OVERFLOW_SCROLL: u32 = 2;
pub const OT_DISPLAY_FLEX: u32 = 0;
pub const OT_DISPLAY_NONE: u32 = 1;
pub const OT_BOX_SIZING_BORDER_BOX: u32 = 0;
pub const OT_BOX_SIZING_CONTENT_BOX: u32 = 1;
pub const OT_LAYOUT_MODE_FLEX: u32 = 0;
pub const OT_LAYOUT_MODE_LIST: u32 = 1;
pub const OT_DISPLAY_CONTENTS: u32 = 2;
pub const OT_YOGA_ERRATA_NONE: u32 = 0;
pub const OT_YOGA_ERRATA_STRETCH_FLEX_BASIS: u32 = 1;
pub const OT_YOGA_ERRATA_ABSOLUTE_POSITION_WITHOUT_INSETS_EXCLUDES_PADDING: u32 = 2;
pub const OT_YOGA_ERRATA_ABSOLUTE_PERCENT_AGAINST_INNER_SIZE: u32 = 4;
pub const OT_YOGA_ERRATA_ALL: u32 = 2147483647;
pub const OT_YOGA_ERRATA_CLASSIC: u32 = 2147483646;
pub const OT_YOGA_EXPERIMENTAL_FEATURE_WEB_FLEX_BASIS: u32 = 0;
pub const OT_YOGA_LOG_LEVEL_ERROR: u32 = 0;
pub const OT_YOGA_LOG_LEVEL_WARN: u32 = 1;
pub const OT_YOGA_LOG_LEVEL_INFO: u32 = 2;
pub const OT_YOGA_LOG_LEVEL_DEBUG: u32 = 3;
pub const OT_YOGA_LOG_LEVEL_VERBOSE: u32 = 4;
pub const OT_YOGA_LOG_LEVEL_FATAL: u32 = 5;
pub const OT_YOGA_NODE_TYPE_DEFAULT: u32 = 0;
pub const OT_YOGA_NODE_TYPE_TEXT: u32 = 1;
pub const OT_STYLE_ENUM_DIRECTION_MAX: u32 = 2;
pub const OT_STYLE_ENUM_FLEX_DIRECTION_MAX: u32 = 3;
pub const OT_STYLE_ENUM_JUSTIFY_CONTENT_MAX: u32 = 5;
pub const OT_STYLE_ENUM_ALIGN_CONTENT_MAX: u32 = 8;
pub const OT_STYLE_ENUM_ALIGN_ITEMS_MAX: u32 = 8;
pub const OT_STYLE_ENUM_ALIGN_SELF_MAX: u32 = 8;
pub const OT_STYLE_ENUM_POSITION_TYPE_MAX: u32 = 2;
pub const OT_STYLE_ENUM_FLEX_WRAP_MAX: u32 = 2;
pub const OT_STYLE_ENUM_OVERFLOW_MAX: u32 = 2;
pub const OT_STYLE_ENUM_DISPLAY_MAX: u32 = 1;
pub const OT_STYLE_ENUM_BOX_SIZING_MAX: u32 = 1;
pub const OT_STYLE_ENUM_LAYOUT_MODE_MAX: u32 = 1;
pub const OT_MEASURE_UNDEFINED: u32 = 0;
pub const OT_MEASURE_EXACTLY: u32 = 1;
pub const OT_MEASURE_AT_MOST: u32 = 2;
pub const OT_LAYOUT_PUBLIC: u32 = 0;
pub const OT_LAYOUT_YOGA: u32 = 1;
pub const OT_LAYOUT_PAINT: u32 = 2;
pub const OT_LAYOUT_CONTENT: u32 = 3;
pub const OT_BORDER_NONE: u32 = 0;
pub const OT_BORDER_LEFT: u32 = 1;
pub const OT_BORDER_BOTTOM: u32 = 2;
pub const OT_BORDER_RIGHT: u32 = 4;
pub const OT_BORDER_TOP: u32 = 8;
pub const OT_BORDER_ALL: u32 = 15;
pub const OT_BORDER_SINGLE: u32 = 0;
pub const OT_BORDER_DOUBLE: u32 = 1;
pub const OT_BORDER_ROUNDED: u32 = 2;
pub const OT_BORDER_HEAVY: u32 = 3;
pub const OT_COLOR_RGB: u32 = 0;
pub const OT_COLOR_INDEXED: u32 = 1;
pub const OT_COLOR_DEFAULT: u32 = 2;
pub const OT_COLOR_CHANNEL_MASK: u32 = 255;
pub const OT_COLOR_META_SHIFT: u32 = 8;
pub const OT_COLOR_ANSI_0: u32 = 0;
pub const OT_COLOR_ANSI_1: u32 = 8388608;
pub const OT_COLOR_ANSI_2: u32 = 32768;
pub const OT_COLOR_ANSI_3: u32 = 8421376;
pub const OT_COLOR_ANSI_4: u32 = 128;
pub const OT_COLOR_ANSI_5: u32 = 8388736;
pub const OT_COLOR_ANSI_6: u32 = 32896;
pub const OT_COLOR_ANSI_7: u32 = 12632256;
pub const OT_COLOR_ANSI_8: u32 = 8421504;
pub const OT_COLOR_ANSI_9: u32 = 16711680;
pub const OT_COLOR_ANSI_10: u32 = 65280;
pub const OT_COLOR_ANSI_11: u32 = 16776960;
pub const OT_COLOR_ANSI_12: u32 = 255;
pub const OT_COLOR_ANSI_13: u32 = 16711935;
pub const OT_COLOR_ANSI_14: u32 = 65535;
pub const OT_COLOR_ANSI_15: u32 = 16777215;
pub const OT_COLOR_CUBE_BASE: u32 = 55;
pub const OT_COLOR_CUBE_STEP: u32 = 40;
pub const OT_COLOR_GRAY_BASE: u32 = 8;
pub const OT_COLOR_GRAY_STEP: u32 = 10;
pub const OT_ATTR_BOLD: u32 = 1;
pub const OT_ATTR_DIM: u32 = 2;
pub const OT_ATTR_ITALIC: u32 = 4;
pub const OT_ATTR_UNDERLINE: u32 = 8;
pub const OT_ATTR_BLINK: u32 = 16;
pub const OT_ATTR_INVERSE: u32 = 32;
pub const OT_ATTR_HIDDEN: u32 = 64;
pub const OT_ATTR_STRIKETHROUGH: u32 = 128;
pub const OT_ATTR_BASE_MASK: u32 = 255;
pub const OT_ATTR_LINK_SHIFT: u32 = 8;
pub const OT_ATTR_LINK_MASK: u32 = 16777215;
pub const OT_SCENE_TEXT_SELECTION_RESET: u32 = 0;
pub const OT_SCENE_TEXT_SELECTION_SET: u32 = 1;
pub const OT_SCENE_TEXT_SELECTION_UPDATE: u32 = 2;
pub const OT_SCENE_TEXT_SELECTION_CELL: u32 = 0;
pub const OT_SCENE_TEXT_SELECTION_WORD: u32 = 1;
pub const OT_SCENE_TEXT_SELECTION_LINE: u32 = 2;
pub const OT_SCENE_TEXT_SELECTION_BACKGROUND: u32 = 1;
pub const OT_SCENE_TEXT_SELECTION_FOREGROUND: u32 = 2;
pub const OT_SCENE_TEXT_FOREGROUND: u32 = 1;
pub const OT_SCENE_TEXT_BACKGROUND: u32 = 2;
pub const OT_SCENE_TEXT_LINK: u32 = 4;
pub const OT_SCENE_MUTATIONS_MAX: u32 = 4096;
pub const OT_SCENE_FULL_PATH_FORCED: u32 = 1;
pub const OT_SCENE_FULL_PATH_SCREEN: u32 = 2;
pub const OT_SCENE_FULL_PATH_IMAGES: u32 = 4;
pub const OT_SCENE_FULL_PATH_TAINTED: u32 = 8;
pub const OT_SCENE_FULL_PATH_UNRETAINED: u32 = 16;
pub const OT_SCENE_FULL_PATH_OPTIONS: u32 = 32;
pub const OT_SCENE_FULL_PATH_NON_LOCAL: u32 = 64;
pub const OT_CURSOR_STYLE_BLOCK: u32 = 0;
pub const OT_CURSOR_STYLE_LINE: u32 = 1;
pub const OT_CURSOR_STYLE_UNDERLINE: u32 = 2;
pub const OT_CURSOR_STYLE_DEFAULT: u32 = 3;
pub const OT_SCENE_HOOK_UPDATE: u32 = 1;
pub const OT_SCENE_HOOK_RESIZE: u32 = 2;
pub const OT_SCENE_HOOK_LAYOUT_CHANGED: u32 = 4;
pub const OT_SCENE_HOOK_RENDER_BEFORE: u32 = 8;
pub const OT_SCENE_HOOK_RENDER_AFTER: u32 = 16;
pub const OT_SCENE_HOOK_RENDER_SELF: u32 = 32;
pub const OT_SCENE_HOOK_IDLE_UPDATE: u32 = 64;
pub const OT_SCENE_HOOK_SCROLL: u32 = 128;
pub const OT_SCENE_FRAME_DONE: u32 = 0;
pub const OT_SCENE_FRAME_UPDATE: u32 = 1;
pub const OT_SCENE_FRAME_RESIZE: u32 = 2;
pub const OT_SCENE_FRAME_LAYOUT_CHANGED: u32 = 3;
pub const OT_SCENE_FRAME_RECORD: u32 = 4;
pub const OT_SCENE_FRAME_SCROLL: u32 = 5;
pub const OT_SCENE_GEOMETRY_PAINT: u32 = 1;
pub const OT_SCENE_GEOMETRY_PUBLIC: u32 = 2;
pub const OT_SCENE_PROPERTY_Z_INDEX: u32 = 1;
pub const OT_SCENE_PROPERTY_OPACITY: u32 = 2;
pub const OT_SCENE_PROPERTY_TRANSLATE_X: u32 = 4;
pub const OT_SCENE_PROPERTY_TRANSLATE_Y: u32 = 8;
pub const OT_SCENE_PROPERTY_BORDER: u32 = 16;
pub const OT_SCENE_PROPERTY_SHOULD_FILL: u32 = 32;
pub const OT_SCENE_PROPERTY_BACKGROUND: u32 = 64;
pub const OT_SCENE_PROPERTY_BORDER_COLOR: u32 = 128;
pub const OT_SCENE_PROPERTY_BORDER_STYLE: u32 = 256;
pub const OT_SCENE_PROPERTY_FOCUSABLE: u32 = 512;
pub const OT_SCENE_PROPERTY_FOCUSED_BORDER_COLOR: u32 = 1024;
pub const OT_SCENE_PROPERTY_STYLE: u32 = 2048;
pub const OT_SCENE_PROPERTY_RESET_BORDER_CHARACTERS: u32 = 4096;
pub const OT_SCENE_PROPERTY_RECORD_MAX: u32 = 88;
pub const OT_SCENE_PROPERTY_BYTES_MAX: u32 = 360448;
pub const OT_SCENE_SCROLL_X: u32 = 1;
pub const OT_SCENE_SCROLL_Y: u32 = 2;
pub const OT_SCENE_SCROLL_FOLLOW_NONE: u32 = 0;
pub const OT_SCENE_SCROLL_FOLLOW_TOP: u32 = 1;
pub const OT_SCENE_SCROLL_FOLLOW_BOTTOM: u32 = 2;
pub const OT_SCENE_SCROLL_FOLLOW_LEFT: u32 = 3;
pub const OT_SCENE_SCROLL_FOLLOW_RIGHT: u32 = 4;
pub const OT_SCENE_SCROLL_FILL_WRAPPER: u32 = 1;
pub const OT_SCENE_SCROLL_FILL_VIEWPORT: u32 = 2;
pub const OT_SCENE_SCROLL_FILL_CONTENT: u32 = 4;
pub const OT_SCENE_SCROLL_BAR_AUTO: u32 = 0;
pub const OT_SCENE_SCROLL_BAR_ALWAYS: u32 = 1;
pub const OT_SCENE_SCROLL_BAR_NEVER: u32 = 2;
pub const OT_SCENE_SCROLL_BAR_INSET: u32 = 0;
pub const OT_SCENE_SCROLL_BAR_OVERLAY: u32 = 1;
pub const OT_SCENE_SCROLL_RELATIVE_X: u32 = 1;
pub const OT_SCENE_SCROLL_RELATIVE_Y: u32 = 2;
pub const OT_SCENE_SCROLL_REAPPLY: u32 = 4;
pub const OT_SCENE_SCROLL_REQUEST_INTO_VIEW: u32 = 0;
pub const OT_SCENE_SCROLL_REQUEST_ANCHOR: u32 = 1;
pub const OT_SCENE_SCROLL_REQUEST_LAYOUT: u32 = 2;
pub const OT_SCENE_SCROLL_ALIGN_NEAREST: u32 = 0;
pub const OT_SCENE_SCROLL_ALIGN_START: u32 = 1;
pub const OT_SCENE_SCROLL_ALIGN_END: u32 = 2;
pub const OT_SCENE_SCROLL_PADDING_MAX: u32 = 65535;
pub const OT_SCENE_SCROLL_CHANGED_OFFSET_X: u32 = 1;
pub const OT_SCENE_SCROLL_CHANGED_OFFSET_Y: u32 = 2;
pub const OT_SCENE_SCROLL_CHANGED_CONTENT: u32 = 4;
pub const OT_SCENE_SCROLL_CHANGED_VIEWPORT: u32 = 8;
pub const OT_SCENE_SCROLL_CHANGED_LAYOUT: u32 = 16;
pub const OT_SCENE_DEBUG_FULL_FRAME: u32 = 1;
pub const OT_SCENE_DEBUG_VERIFY: u32 = 2;
pub const OT_SESSION_OPEN: u32 = 0;
pub const OT_SESSION_CLOSING: u32 = 1;
pub const OT_SESSION_CLOSED_STATE: u32 = 2;
pub const OT_SESSION_FAILED: u32 = 3;
pub const OT_SESSION_CANCELLED_STATE: u32 = 4;
pub const OT_SESSION_REMOTE_AUTO: u32 = 0;
pub const OT_SESSION_REMOTE_LOCAL: u32 = 1;
pub const OT_SESSION_REMOTE_REMOTE: u32 = 2;
pub const OT_SESSION_ENV_ENTRIES_MAX: u32 = 256;
pub const OT_SESSION_ENV_BYTES_MAX: u32 = 65536;
pub const OT_RENDER_PRESENTED: u32 = 0;
pub const OT_RENDER_PENDING: u32 = 1;
pub const OT_RENDER_SKIPPED: u32 = 2;
pub const OT_RENDER_FAILED: u32 = 3;
pub const OT_SPLIT_SNAPSHOTS_MAX: u32 = 64;
pub const OT_SESSION_BUFFER_CURRENT: u32 = 0;
pub const OT_SESSION_BUFFER_NEXT: u32 = 1;
pub const OT_WIDTH_METHOD_WCWIDTH: u32 = 0;
pub const OT_WIDTH_METHOD_UNICODE: u32 = 1;
pub const OT_WIDTH_METHOD_NO_ZWJ: u32 = 2;
pub const OT_WIDTH_METHOD_UNICODE_WIDE: u32 = 3;
pub const OT_BUFFER_RESPECT_ALPHA: u32 = 1;
pub const OT_EMBEDDED_TERMINAL_CURSOR_BAR: u32 = 0;
pub const OT_EMBEDDED_TERMINAL_CURSOR_BLOCK: u32 = 1;
pub const OT_EMBEDDED_TERMINAL_CURSOR_UNDERLINE: u32 = 2;
pub const OT_EMBEDDED_TERMINAL_CURSOR_BLOCK_HOLLOW: u32 = 3;
pub const OT_EMBEDDED_TERMINAL_MOD_SHIFT: u32 = 1;
pub const OT_EMBEDDED_TERMINAL_MOD_CTRL: u32 = 2;
pub const OT_EMBEDDED_TERMINAL_MOD_ALT: u32 = 4;
pub const OT_EMBEDDED_TERMINAL_MOD_SUPER: u32 = 8;
pub const OT_EMBEDDED_TERMINAL_MOD_CAPS_LOCK: u32 = 16;
pub const OT_EMBEDDED_TERMINAL_MOD_NUM_LOCK: u32 = 32;
pub const OT_EMBEDDED_TERMINAL_KEY_RELEASE: u32 = 0;
pub const OT_EMBEDDED_TERMINAL_KEY_PRESS: u32 = 1;
pub const OT_EMBEDDED_TERMINAL_KEY_REPEAT: u32 = 2;
pub const OT_EMBEDDED_TERMINAL_MOUSE_PRESS: u32 = 0;
pub const OT_EMBEDDED_TERMINAL_MOUSE_RELEASE: u32 = 1;
pub const OT_EMBEDDED_TERMINAL_MOUSE_MOTION: u32 = 2;
pub const OT_EMBEDDED_TERMINAL_BUTTON_NONE: i32 = -1;
pub const OT_EMBEDDED_TERMINAL_BUTTON_UNKNOWN: i32 = 0;
pub const OT_EMBEDDED_TERMINAL_BUTTON_LEFT: i32 = 1;
pub const OT_EMBEDDED_TERMINAL_BUTTON_RIGHT: i32 = 2;
pub const OT_EMBEDDED_TERMINAL_BUTTON_MIDDLE: i32 = 3;
pub const OT_EMBEDDED_TERMINAL_BUTTON_FOUR: i32 = 4;
pub const OT_EMBEDDED_TERMINAL_BUTTON_FIVE: i32 = 5;
pub const OT_EMBEDDED_TERMINAL_BUTTON_SIX: i32 = 6;
pub const OT_EMBEDDED_TERMINAL_BUTTON_SEVEN: i32 = 7;
pub const OT_EMBEDDED_TERMINAL_INPUT_BYTES_MAX: u32 = 1048576;
pub const OT_EMBEDDED_TERMINAL_INVALIDATE: u32 = 0;
pub const OT_EMBEDDED_TERMINAL_SCROLL: u32 = 1;
pub const OT_EMBEDDED_TERMINAL_CLEAR_SELECTION: u32 = 2;
pub const OT_EMBEDDED_TERMINAL_SET_TRANSPARENT_BACKGROUND: u32 = 3;
pub const OT_EMBEDDED_TERMINAL_RESPONSE_BYTES_MAX: u32 = 1048576;
pub const OT_EDIT_CURSOR_CHANGED: u32 = 1;
pub const OT_EDIT_CONTENT_CHANGED: u32 = 2;
pub const OT_EDIT_HISTORY_CURSOR_CHANGED: u32 = 4;
pub const OT_MOUSE_POINTER_AUTO: u32 = 0;
pub const OT_MOUSE_POINTER_DEFAULT: u32 = 1;
pub const OT_MOUSE_POINTER_NONE: u32 = 2;
pub const OT_MOUSE_POINTER_CONTEXT_MENU: u32 = 3;
pub const OT_MOUSE_POINTER_HELP: u32 = 4;
pub const OT_MOUSE_POINTER_POINTER: u32 = 5;
pub const OT_MOUSE_POINTER_PROGRESS: u32 = 6;
pub const OT_MOUSE_POINTER_WAIT: u32 = 7;
pub const OT_MOUSE_POINTER_CELL: u32 = 8;
pub const OT_MOUSE_POINTER_CROSSHAIR: u32 = 9;
pub const OT_MOUSE_POINTER_TEXT: u32 = 10;
pub const OT_MOUSE_POINTER_VERTICAL_TEXT: u32 = 11;
pub const OT_MOUSE_POINTER_ALIAS: u32 = 12;
pub const OT_MOUSE_POINTER_COPY: u32 = 13;
pub const OT_MOUSE_POINTER_MOVE: u32 = 14;
pub const OT_MOUSE_POINTER_NO_DROP: u32 = 15;
pub const OT_MOUSE_POINTER_NOT_ALLOWED: u32 = 16;
pub const OT_MOUSE_POINTER_GRAB: u32 = 17;
pub const OT_MOUSE_POINTER_GRABBING: u32 = 18;
pub const OT_MOUSE_POINTER_ALL_SCROLL: u32 = 19;
pub const OT_MOUSE_POINTER_COL_RESIZE: u32 = 20;
pub const OT_MOUSE_POINTER_ROW_RESIZE: u32 = 21;
pub const OT_MOUSE_POINTER_N_RESIZE: u32 = 22;
pub const OT_MOUSE_POINTER_E_RESIZE: u32 = 23;
pub const OT_MOUSE_POINTER_S_RESIZE: u32 = 24;
pub const OT_MOUSE_POINTER_W_RESIZE: u32 = 25;
pub const OT_MOUSE_POINTER_NE_RESIZE: u32 = 26;
pub const OT_MOUSE_POINTER_NW_RESIZE: u32 = 27;
pub const OT_MOUSE_POINTER_SE_RESIZE: u32 = 28;
pub const OT_MOUSE_POINTER_SW_RESIZE: u32 = 29;
pub const OT_MOUSE_POINTER_EW_RESIZE: u32 = 30;
pub const OT_MOUSE_POINTER_NS_RESIZE: u32 = 31;
pub const OT_MOUSE_POINTER_NESW_RESIZE: u32 = 32;
pub const OT_MOUSE_POINTER_NWSE_RESIZE: u32 = 33;
pub const OT_MOUSE_POINTER_ZOOM_IN: u32 = 34;
pub const OT_MOUSE_POINTER_ZOOM_OUT: u32 = 35;
pub const OT_MOUSE_POINTER_MAX: u32 = 35;
pub const OT_MOUSE_POINTER_UNCHANGED: u32 = 4294967295;
pub const OT_EDIT_DELETE_FORWARD: u32 = 0;
pub const OT_EDIT_BACKSPACE: u32 = 1;
pub const OT_EDIT_NEW_LINE: u32 = 2;
pub const OT_EDIT_DELETE_LINE: u32 = 3;
pub const OT_EDIT_MOVE_LEFT: u32 = 4;
pub const OT_EDIT_MOVE_RIGHT: u32 = 5;
pub const OT_EDIT_MOVE_UP: u32 = 6;
pub const OT_EDIT_MOVE_DOWN: u32 = 7;
pub const OT_EDIT_GOTO_LINE: u32 = 8;
pub const OT_EDIT_CURSOR_OFFSET: u32 = 9;
pub const OT_EDIT_CLEAR: u32 = 10;
pub const OT_EDIT_CLEAR_HISTORY: u32 = 11;
pub const OT_EDIT_DEBUG_ROPE: u32 = 12;
pub const OT_EDIT_POSITION_CURSOR: u32 = 0;
pub const OT_EDIT_POSITION_NEXT_WORD: u32 = 1;
pub const OT_EDIT_POSITION_PREV_WORD: u32 = 2;
pub const OT_EDIT_POSITION_EOL: u32 = 3;
pub const OT_EDIT_POSITION_OFFSET: u32 = 4;
pub const OT_EDIT_POSITION_COORDS: u32 = 5;
pub const OT_EDIT_POSITION_LINE_START: u32 = 6;
pub const OT_EDIT_POSITION_END: u32 = 7;
pub const OT_EDIT_POSITION_PREV_CHAR: u32 = 8;
pub const OT_EDITOR_STYLE_FOREGROUND: u32 = 1;
pub const OT_EDITOR_STYLE_BACKGROUND: u32 = 2;
pub const OT_EDITOR_STYLE_ATTRIBUTES: u32 = 4;
pub const OT_EDITOR_STYLE_ATTRIBUTE_MASK: u32 = 8;
pub const OT_EDIT_HIGHLIGHT_ADD_LINE: u32 = 0;
pub const OT_EDIT_HIGHLIGHT_ADD_RANGE: u32 = 1;
pub const OT_EDIT_HIGHLIGHT_REMOVE_REF: u32 = 2;
pub const OT_EDIT_HIGHLIGHT_CLEAR_LINE: u32 = 3;
pub const OT_EDIT_HIGHLIGHT_CLEAR_ALL: u32 = 4;
pub const OT_STYLE_RUN_FLAG: u32 = 2147483648;
pub const OT_GROUP_SET_NAME_COUNT_MAX: u32 = 16;
pub const OT_GROUP_SET_NAME_BYTE_COUNT_MAX: u32 = 64;
pub const OT_EDIT_MARK_ADD: u32 = 0;
pub const OT_EDIT_MARK_REMOVE: u32 = 1;
pub const OT_EDIT_MARK_CLEAR: u32 = 2;
pub const OT_EDIT_MARK_ATOMIC: u32 = 1;
pub const OT_EDIT_MARK_STYLE_VALUE: u32 = 2;
pub const OT_EDIT_MARK_ANY_KIND: u32 = 4294967295;
pub const OT_MD_CONCEAL: u32 = 1;
pub const OT_MD_HYPERLINKS: u32 = 2;
pub const OT_MD_MATH: u32 = 4;
pub const OT_MD_HOOK: u32 = 8;
pub const OT_MD_HOOK_FILTER_BYTE_COUNT_MAX: u32 = 256;
pub const OT_MD_PARAGRAPH: u32 = 0;
pub const OT_MD_HEADING: u32 = 1;
pub const OT_MD_CODE: u32 = 2;
pub const OT_MD_HTML: u32 = 3;
pub const OT_MD_RULE: u32 = 4;
pub const OT_MD_TABLE: u32 = 5;
pub const OT_MD_TABLE_ROW: u32 = 6;
pub const OT_MD_TABLE_CELL: u32 = 7;
pub const OT_MD_QUOTE: u32 = 8;
pub const OT_MD_LIST: u32 = 9;
pub const OT_MD_ITEM: u32 = 10;
pub const OT_MD_BLOCK_CLOSED: u32 = 1;
pub const OT_MD_BLOCK_SETEXT: u32 = 2;
pub const OT_MD_BLOCK_ORDERED: u32 = 4;
pub const OT_MD_BLOCK_TIGHT: u32 = 8;
pub const OT_MD_BLOCK_TASK: u32 = 16;
pub const OT_MD_BLOCK_CHECKED: u32 = 32;
pub const OT_MD_BLOCK_BLANK_AFTER: u32 = 64;
pub const OT_MD_BLOCK_FENCED: u32 = 128;
pub const OT_MD_BLOCK_HOOKED: u32 = 256;
pub const OT_MD_BLOCK_MATH: u32 = 512;
pub const OT_MD_BLOCK_HEADER: u32 = 1024;
pub const OT_MD_BLOCK_OPEN: u32 = 2048;
pub const OT_MD_SPAN_CODE: u32 = 1;
pub const OT_MD_SPAN_MATH: u32 = 2;
pub const OT_EDITOR_MOVE_UP: u32 = 0;
pub const OT_EDITOR_MOVE_DOWN: u32 = 1;
pub const OT_EDITOR_GOTO_LINE_END: u32 = 2;
pub const OT_EDITOR_DELETE_SELECTION: u32 = 3;
pub const OT_EDITOR_CURSOR_OFFSET: u32 = 4;
pub const OT_EDITOR_WRAP_MODE: u32 = 5;
pub const OT_EDITOR_TAB_INDICATOR: u32 = 6;
pub const OT_EDITOR_SELECT_SET: u32 = 0;
pub const OT_EDITOR_SELECT_UPDATE: u32 = 1;
pub const OT_EDITOR_SELECT_RESET: u32 = 2;
pub const OT_EDITOR_SELECT_LOCAL: u32 = 3;
pub const OT_EDITOR_SELECT_LOCAL_UPDATE: u32 = 4;
pub const OT_EDITOR_SELECT_LOCAL_RESET: u32 = 5;
pub const OT_EDITOR_SELECT_CELL: u32 = 6;
pub const OT_EDITOR_SELECT_OCCUPANCY: u32 = 7;
pub const OT_EDITOR_SELECT_INCLUSIVE: u32 = 8;
pub const OT_EDITOR_SELECT_COLORS: u32 = 9;
pub const OT_SELECT_DOCUMENT_SET: u32 = 0;
pub const OT_SELECT_DOCUMENT_UPDATE: u32 = 1;
pub const OT_SELECT_DOCUMENT_RESET: u32 = 2;
pub const OT_SELECT_VIEWPORT_SET: u32 = 3;
pub const OT_SELECT_VIEWPORT_UPDATE: u32 = 4;
pub const OT_SELECT_VIEWPORT_RESET: u32 = 5;
pub const OT_SELECTION_CELL: u32 = 0;
pub const OT_SELECTION_WORD: u32 = 1;
pub const OT_SELECTION_LINE: u32 = 2;
pub const OT_SELECTION_OCCUPANCY_CELL: u32 = 0;
pub const OT_SELECTION_OCCUPANCY_BOUNDARY: u32 = 1;
pub const OT_EDITOR_POSITION_CURSOR: u32 = 0;
pub const OT_EDITOR_POSITION_NEXT_WORD: u32 = 1;
pub const OT_EDITOR_POSITION_PREV_WORD: u32 = 2;
pub const OT_EDITOR_POSITION_EOL: u32 = 3;
pub const OT_EDITOR_POSITION_VISUAL_SOL: u32 = 4;
pub const OT_EDITOR_POSITION_VISUAL_EOL: u32 = 5;
pub const OT_IMAGE_FIT: u32 = 0;
pub const OT_IMAGE_COVER: u32 = 1;
pub const OT_IMAGE_FILL: u32 = 2;
pub const OT_IMAGE_PROTOCOL_AUTO: u32 = 0;
pub const OT_IMAGE_PROTOCOL_KITTY: u32 = 1;
pub const OT_IMAGE_PROTOCOL_SIXEL: u32 = 2;
pub const OT_IMAGE_PROTOCOL_BLOCKS: u32 = 3;
pub const OT_IMAGE_DRAW_SOURCE_WIDTH: u32 = 1;
pub const OT_IMAGE_DRAW_SOURCE_HEIGHT: u32 = 2;
pub const OT_IMAGE_ENCODED_BYTES_MAX: u32 = 67108864;
pub const OT_IMAGE_FORMAT_UNKNOWN: u32 = 0;
pub const OT_IMAGE_FORMAT_PNG: u32 = 1;
pub const OT_IMAGE_FORMAT_RGBA: u32 = 2;
pub const OT_IMAGE_FORMAT_JPEG: u32 = 3;
pub const OT_IMAGE_FORMAT_WEBP: u32 = 4;
pub const OT_IMAGE_FORMAT_GIF: u32 = 5;
pub const OT_IMAGE_ASSUMED_SRGB: u32 = 0;
pub const OT_IMAGE_EXPLICIT_SRGB: u32 = 1;
pub const OT_IMAGE_RGBA8: u32 = 0;
pub const OT_IMAGE_BGRA8: u32 = 1;
pub const OT_IMAGE_ALPHA_STRAIGHT: u32 = 0;
pub const OT_IMAGE_ALPHA_OPAQUE: u32 = 1;
pub const OT_IMAGE_FILTER_DEFAULT: u32 = 0;
pub const OT_IMAGE_FILTER_AREA: u32 = 1;
pub const OT_IMAGE_FILTER_TRIANGLE: u32 = 2;
pub const OT_IMAGE_FILTER_CUBIC_BSPLINE: u32 = 3;
pub const OT_IMAGE_FILTER_CATMULL_ROM: u32 = 4;
pub const OT_IMAGE_FILTER_MITCHELL: u32 = 5;
pub const OT_IMAGE_FILTER_NEAREST: u32 = 6;
pub const OT_IMAGE_ROTATE_90: u32 = 0;
pub const OT_IMAGE_ROTATE_180: u32 = 1;
pub const OT_IMAGE_ROTATE_270: u32 = 2;
pub const OT_IMAGE_FLIP: u32 = 3;
pub const OT_IMAGE_FLOP: u32 = 4;
pub const OT_IMAGE_BLEND_SOURCE_OVER: u32 = 0;
pub const OT_IMAGE_BLEND_SOURCE: u32 = 1;
pub const OT_IMAGE_BLEND_DESTINATION_OVER: u32 = 2;
pub const OT_VIDEO_OPEN_NO_AUDIO: u32 = 1;
pub const OT_VIDEO_PLAYING: u32 = 1;
pub const OT_VIDEO_ENDED: u32 = 2;
pub const OT_VIDEO_BUFFERING: u32 = 4;
pub const OT_VIDEO_AUDIO: u32 = 8;
pub const OT_VIDEO_HAS_FRAME: u32 = 16;
pub const OT_VIDEO_ERROR: u32 = 32;
pub const OT_AUDIO_START_NO_DEVICE: u32 = 1;
pub const OT_TEXT_VIEW_WRAP_WIDTH: u32 = 0;
pub const OT_TEXT_VIEW_WRAP_MODE: u32 = 1;
pub const OT_TEXT_VIEW_FIRST_LINE_OFFSET: u32 = 2;
pub const OT_TEXT_VIEW_TAB_INDICATOR: u32 = 3;
pub const OT_TEXT_VIEW_TRUNCATE: u32 = 4;
pub const OT_TEXT_VIEW_TEXT_ALIGN: u32 = 5;
pub const OT_TEXT_REPLACEMENT_COUNT_MAX: u32 = 256;
pub const OT_TEXT_REPLACEMENT_CHUNKS_MAX: u32 = 4096;
pub const OT_TEXT_REPLACEMENT_BYTES_MAX: u32 = 4194304;
pub const OT_TEXT_REPLACEMENT_URL_BYTES_MAX: u32 = 1048576;
pub const OT_BUFFER_TEXT_BYTES_MAX: u32 = 65536;
pub const OT_BUFFER_DRAW_CLEAR: u32 = 0;
pub const OT_BUFFER_DRAW_FILL: u32 = 1;
pub const OT_BUFFER_DRAW_TEXT: u32 = 2;
pub const OT_BUFFER_DRAW_CELL: u32 = 3;
pub const OT_BUFFER_DRAW_CELL_BLEND: u32 = 4;
pub const OT_BUFFER_DRAW_CHAR: u32 = 5;
pub const OT_BUFFER_DRAW_BOX: u32 = 6;
pub const OT_BUFFER_DRAW_COMPOSE: u32 = 7;
pub const OT_BUFFER_DRAW_RESPECT_ALPHA: u32 = 8;
pub const OT_BUFFER_DRAW_HAS_BACKGROUND: u32 = 1;
pub const OT_BUFFER_DRAW_HAS_SOURCE_WIDTH: u32 = 2;
pub const OT_BUFFER_DRAW_HAS_SOURCE_HEIGHT: u32 = 4;
pub const OT_BUFFER_DRAW_FIT_ELLIPSIS: u32 = 16;
pub const OT_BUFFER_STACK_DEPTH_MAX: u32 = 256;
pub const OT_BUFFER_STACK_GET_OPACITY: u32 = 0;
pub const OT_BUFFER_STACK_PUSH_SCISSOR: u32 = 1;
pub const OT_BUFFER_STACK_POP_SCISSOR: u32 = 2;
pub const OT_BUFFER_STACK_CLEAR_SCISSORS: u32 = 3;
pub const OT_BUFFER_STACK_PUSH_OPACITY: u32 = 4;
pub const OT_BUFFER_STACK_POP_OPACITY: u32 = 5;
pub const OT_BUFFER_STACK_CLEAR_OPACITY: u32 = 6;
pub const OT_BUFFER_GRID_INNER: u32 = 1;
pub const OT_BUFFER_GRID_OUTER: u32 = 2;
pub const OT_CELL_CHAR_KIND_MASK: u32 = 3221225472;
pub const OT_CELL_CHAR_IMAGE: u32 = 1073741824;
pub const OT_CELL_CHAR_GRAPHEME: u32 = 2147483648;
pub const OT_CELL_CHAR_CONTINUATION: u32 = 3221225472;
pub const OT_SESSION_CONTROL_PACKET_BYTES: u32 = 4096;
pub const OT_TERMINAL_ALTERNATE_SCREEN: u32 = 1;
pub const OT_TERMINAL_MOUSE: u32 = 2;
pub const OT_TERMINAL_MOUSE_MOVEMENT: u32 = 4;
pub const OT_TERMINAL_CLEAR_ON_CLOSE: u32 = 8;
pub const OT_TERMINAL_REPLY_SENTINEL: u32 = 16;
pub const OT_TERMINAL_SYNC_ALWAYS: u32 = 32;
pub const OT_TERMINAL_SYNC_NEVER: u32 = 64;
pub const OT_TERMINAL_HOST_MULTIPLEXER: u32 = 128;
pub const OT_KITTY_KEYBOARD_DISAMBIGUATE: u32 = 1;
pub const OT_KITTY_KEYBOARD_EVENT_TYPES: u32 = 2;
pub const OT_KITTY_KEYBOARD_ALTERNATE_KEYS: u32 = 4;
pub const OT_KITTY_KEYBOARD_ALL_KEYS_AS_ESCAPES: u32 = 8;
pub const OT_KITTY_KEYBOARD_REPORT_TEXT: u32 = 16;
pub const OT_KITTY_KEYBOARD_ALL: u32 = 31;
pub const OT_CONTROL_CAPABILITY_RESPONSE: u32 = 1;
pub const OT_CONTROL_TITLE: u32 = 2;
pub const OT_CONTROL_MOUSE: u32 = 3;
pub const OT_CONTROL_KITTY_KEYBOARD_FLAGS: u32 = 4;
pub const OT_CONTROL_RESTORE_MODES: u32 = 5;
pub const OT_CONTROL_QUERY_PIXEL_RESOLUTION: u32 = 6;
pub const OT_CONTROL_QUERY_THEME_COLORS: u32 = 7;
pub const OT_CONTROL_CURSOR: u32 = 8;
pub const OT_CONTROL_RESET_BACKGROUND: u32 = 9;
pub const OT_CONTROL_PALETTE_QUERY: u32 = 10;
pub const OT_CONTROL_PROGRAM_STATUS: u32 = 11;
pub const OT_CONTROL_END_REPLY_SENTINEL: u32 = 12;
pub const OT_CURSOR_POSITION: u32 = 1;
pub const OT_CURSOR_STYLE: u32 = 2;
pub const OT_CURSOR_BLINKING: u32 = 4;
pub const OT_CURSOR_COLOR: u32 = 8;
pub const OT_CURSOR_MOUSE_POINTER: u32 = 16;
pub const OT_PROGRAM_STATE_IDLE: u32 = 1;
pub const OT_PROGRAM_STATE_WORKING: u32 = 2;
pub const OT_PROGRAM_STATE_DONE: u32 = 3;
pub const OT_PROGRAM_STATE_BLOCKED: u32 = 4;
pub const OT_PROGRAM_STATE_ERROR: u32 = 5;
pub const OT_PROGRAM_STATE_CLEAR: u32 = 6;
pub const OT_PROGRAM_KIND_PERMISSION: u32 = 1;
pub const OT_PROGRAM_KIND_QUESTION: u32 = 2;
pub const OT_PROGRAM_KIND_AUTH: u32 = 3;
pub const OT_PROGRAM_STATUS_PROGRESS: u32 = 1;
pub const OT_CAP_KITTY_KEYBOARD: u32 = 1;
pub const OT_CAP_KITTY_GRAPHICS: u32 = 2;
pub const OT_CAP_RGB: u32 = 4;
pub const OT_CAP_ANSI256: u32 = 8;
pub const OT_CAP_SGR_PIXELS: u32 = 16;
pub const OT_CAP_COLOR_SCHEME_UPDATES: u32 = 32;
pub const OT_CAP_EXPLICIT_WIDTH: u32 = 64;
pub const OT_CAP_SCALED_TEXT: u32 = 128;
pub const OT_CAP_SIXEL: u32 = 256;
pub const OT_CAP_FOCUS_TRACKING: u32 = 512;
pub const OT_CAP_SYNC: u32 = 1024;
pub const OT_CAP_BRACKETED_PASTE: u32 = 2048;
pub const OT_CAP_HYPERLINKS: u32 = 4096;
pub const OT_CAP_OSC52: u32 = 8192;
pub const OT_CAP_NOTIFICATIONS: u32 = 16384;
pub const OT_CAP_EXPLICIT_CURSOR_POSITIONING: u32 = 32768;
pub const OT_CAP_REMOTE: u32 = 65536;
pub const OT_CAP_PROGRAM_STATUS: u32 = 131072;
pub const OT_TERMINAL_UNINITIALIZED: u32 = 0;
pub const OT_TERMINAL_SETTING_UP: u32 = 1;
pub const OT_TERMINAL_ACTIVE: u32 = 2;
pub const OT_TERMINAL_SUSPENDING: u32 = 3;
pub const OT_TERMINAL_SUSPENDED: u32 = 4;
pub const OT_TERMINAL_RESUMING: u32 = 5;
pub const OT_TERMINAL_CLOSING: u32 = 6;
pub const OT_TERMINAL_RESTORED: u32 = 7;
pub const OT_TERMINAL_FAILED: u32 = 8;
pub const OT_TERMINAL_CANCELLED: u32 = 9;
pub const OT_PUMP_IDLE: u32 = 0;
pub const OT_PUMP_AGAIN: u32 = 1;
pub const OT_PUMP_OUTPUT_PENDING: u32 = 2;
pub const OT_PUMP_WAIT_UNTIL: u32 = 3;
pub const OT_PUMP_CLOSED: u32 = 4;
pub const OT_STDOUT_IDLE: u32 = 0;
pub const OT_STDOUT_IN_FLIGHT: u32 = 1;
pub const OT_INPUT_KEY: u32 = 1;
pub const OT_INPUT_MOUSE: u32 = 2;
pub const OT_INPUT_PASTE: u32 = 3;
pub const OT_INPUT_FOCUS: u32 = 4;
pub const OT_INPUT_REPLY: u32 = 5;
pub const OT_INPUT_KEY_PRESS: u32 = 1;
pub const OT_INPUT_KEY_REPEAT: u32 = 2;
pub const OT_INPUT_KEY_RELEASE: u32 = 3;
pub const OT_INPUT_MOUSE_DOWN: u32 = 1;
pub const OT_INPUT_MOUSE_UP: u32 = 2;
pub const OT_INPUT_MOUSE_MOVE: u32 = 3;
pub const OT_INPUT_MOUSE_DRAG: u32 = 4;
pub const OT_INPUT_MOUSE_SCROLL: u32 = 5;
pub const OT_INPUT_MOUSE_BUTTON_NONE: u32 = 255;
pub const OT_INPUT_FOCUS_OUT: u32 = 0;
pub const OT_INPUT_FOCUS_IN: u32 = 1;
pub const OT_INPUT_MOD_SHIFT: u32 = 1;
pub const OT_INPUT_MOD_ALT: u32 = 2;
pub const OT_INPUT_MOD_CTRL: u32 = 4;
pub const OT_INPUT_MOD_SUPER: u32 = 8;
pub const OT_INPUT_MOD_HYPER: u32 = 16;
pub const OT_INPUT_MOD_META: u32 = 32;
pub const OT_INPUT_MOD_CAPS_LOCK: u32 = 64;
pub const OT_INPUT_MOD_NUM_LOCK: u32 = 128;
pub const OT_INPUT_KEY_KITTY: u32 = 1;
pub const OT_INPUT_KEY_TEXT_TRUNCATED: u32 = 2;
pub const OT_INPUT_KEY_TYPED: u32 = 4;
pub const OT_INPUT_PASTE_START: u32 = 1;
pub const OT_INPUT_PASTE_END: u32 = 2;
pub const OT_INPUT_REPLY_FRAGMENT: u32 = 1;
pub const OT_INPUT_REPLY_CURSOR_POSITION: u32 = 2;
pub const OT_INPUT_REPLY_CSI: u32 = 1;
pub const OT_INPUT_REPLY_SS3: u32 = 2;
pub const OT_INPUT_REPLY_OSC: u32 = 3;
pub const OT_INPUT_REPLY_DCS: u32 = 4;
pub const OT_INPUT_REPLY_APC: u32 = 5;
pub const OT_INPUT_KEY_ESCAPE: u32 = 27;
pub const OT_INPUT_KEY_ENTER: u32 = 13;
pub const OT_INPUT_KEY_TAB: u32 = 9;
pub const OT_INPUT_KEY_BACKSPACE: u32 = 127;
pub const OT_INPUT_KEY_INSERT: u32 = 57348;
pub const OT_INPUT_KEY_DELETE: u32 = 57349;
pub const OT_INPUT_KEY_LEFT: u32 = 57350;
pub const OT_INPUT_KEY_RIGHT: u32 = 57351;
pub const OT_INPUT_KEY_UP: u32 = 57352;
pub const OT_INPUT_KEY_DOWN: u32 = 57353;
pub const OT_INPUT_KEY_PAGE_UP: u32 = 57354;
pub const OT_INPUT_KEY_PAGE_DOWN: u32 = 57355;
pub const OT_INPUT_KEY_HOME: u32 = 57356;
pub const OT_INPUT_KEY_END: u32 = 57357;
pub const OT_INPUT_KEY_CAPS_LOCK: u32 = 57358;
pub const OT_INPUT_KEY_SCROLL_LOCK: u32 = 57359;
pub const OT_INPUT_KEY_NUM_LOCK: u32 = 57360;
pub const OT_INPUT_KEY_PRINT_SCREEN: u32 = 57361;
pub const OT_INPUT_KEY_PAUSE: u32 = 57362;
pub const OT_INPUT_KEY_MENU: u32 = 57363;
pub const OT_INPUT_KEY_F1: u32 = 57364;
pub const OT_INPUT_KEY_F35: u32 = 57398;
pub const OT_INPUT_KEY_KP_0: u32 = 57399;
pub const OT_INPUT_KEY_KP_9: u32 = 57408;
pub const OT_INPUT_KEY_KP_DECIMAL: u32 = 57409;
pub const OT_INPUT_KEY_KP_DIVIDE: u32 = 57410;
pub const OT_INPUT_KEY_KP_MULTIPLY: u32 = 57411;
pub const OT_INPUT_KEY_KP_SUBTRACT: u32 = 57412;
pub const OT_INPUT_KEY_KP_ADD: u32 = 57413;
pub const OT_INPUT_KEY_KP_ENTER: u32 = 57414;
pub const OT_INPUT_KEY_KP_EQUAL: u32 = 57415;
pub const OT_INPUT_KEY_KP_SEPARATOR: u32 = 57416;
pub const OT_INPUT_KEY_KP_LEFT: u32 = 57417;
pub const OT_INPUT_KEY_KP_RIGHT: u32 = 57418;
pub const OT_INPUT_KEY_KP_UP: u32 = 57419;
pub const OT_INPUT_KEY_KP_DOWN: u32 = 57420;
pub const OT_INPUT_KEY_KP_PAGE_UP: u32 = 57421;
pub const OT_INPUT_KEY_KP_PAGE_DOWN: u32 = 57422;
pub const OT_INPUT_KEY_KP_HOME: u32 = 57423;
pub const OT_INPUT_KEY_KP_END: u32 = 57424;
pub const OT_INPUT_KEY_KP_INSERT: u32 = 57425;
pub const OT_INPUT_KEY_KP_DELETE: u32 = 57426;
pub const OT_INPUT_KEY_KP_BEGIN: u32 = 57427;
pub const OT_INPUT_KEY_MEDIA_PLAY: u32 = 57428;
pub const OT_INPUT_KEY_MEDIA_PAUSE: u32 = 57429;
pub const OT_INPUT_KEY_MEDIA_PLAY_PAUSE: u32 = 57430;
pub const OT_INPUT_KEY_MEDIA_REVERSE: u32 = 57431;
pub const OT_INPUT_KEY_MEDIA_STOP: u32 = 57432;
pub const OT_INPUT_KEY_MEDIA_FAST_FORWARD: u32 = 57433;
pub const OT_INPUT_KEY_MEDIA_REWIND: u32 = 57434;
pub const OT_INPUT_KEY_MEDIA_TRACK_NEXT: u32 = 57435;
pub const OT_INPUT_KEY_MEDIA_TRACK_PREVIOUS: u32 = 57436;
pub const OT_INPUT_KEY_MEDIA_RECORD: u32 = 57437;
pub const OT_INPUT_KEY_LOWER_VOLUME: u32 = 57438;
pub const OT_INPUT_KEY_RAISE_VOLUME: u32 = 57439;
pub const OT_INPUT_KEY_MUTE_VOLUME: u32 = 57440;
pub const OT_INPUT_KEY_LEFT_SHIFT: u32 = 57441;
pub const OT_INPUT_KEY_LEFT_CONTROL: u32 = 57442;
pub const OT_INPUT_KEY_LEFT_ALT: u32 = 57443;
pub const OT_INPUT_KEY_LEFT_SUPER: u32 = 57444;
pub const OT_INPUT_KEY_LEFT_HYPER: u32 = 57445;
pub const OT_INPUT_KEY_LEFT_META: u32 = 57446;
pub const OT_INPUT_KEY_RIGHT_SHIFT: u32 = 57447;
pub const OT_INPUT_KEY_RIGHT_CONTROL: u32 = 57448;
pub const OT_INPUT_KEY_RIGHT_ALT: u32 = 57449;
pub const OT_INPUT_KEY_RIGHT_SUPER: u32 = 57450;
pub const OT_INPUT_KEY_RIGHT_HYPER: u32 = 57451;
pub const OT_INPUT_KEY_RIGHT_META: u32 = 57452;
pub const OT_INPUT_KEY_ISO_LEVEL3_SHIFT: u32 = 57453;
pub const OT_INPUT_KEY_ISO_LEVEL5_SHIFT: u32 = 57454;
pub const OT_INPUT_EXPECT_REPLIES: u32 = 1;
pub const OT_INPUT_EXPECT_KITTY_KEYBOARD: u32 = 2;
pub const OT_INPUT_EXPECT_CURSOR_POSITION: u32 = 4;
pub const OT_INPUT_EXPECT_SENTINEL: u32 = 8;
pub const OT_INPUT_EXPECT_ESCAPE_PREFIX: u32 = 16;
pub const OT_INPUT_EVENTS_MIN: u32 = 4;
pub const OT_INPUT_PAYLOAD_BYTES_MIN: u32 = 4384;
pub const OT_INPUT_TIMEOUT_NS: u64 = 20000000;
pub const OT_DIAGNOSTIC_MESSAGE_BYTES: u32 = 4096;
pub const OT_DIAGNOSTIC_TRUNCATED: u32 = 1;
pub const OT_DIAGNOSTIC_QUEUE_MAX: u32 = 64;
pub const OT_SCENE_RECORD_BYTES_MAX: u32 = 67108864;
pub const OT_SCENE_RECORD_PHASE_BEFORE: u32 = 0;
pub const OT_SCENE_RECORD_PHASE_SELF: u32 = 1;
pub const OT_SCENE_RECORD_PHASE_AFTER: u32 = 2;
pub const OT_SCENE_RECORD_SLOT: u32 = 0;
pub const OT_SCENE_RECORD_DRAW: u32 = 1;
pub const OT_SCENE_RECORD_STACK: u32 = 2;
pub const OT_SCENE_RECORD_GRID: u32 = 3;
pub const OT_SCENE_RECORD_PACKED: u32 = 4;
pub const OT_SCENE_RECORD_SUPERSAMPLE: u32 = 5;
pub const OT_SCENE_RECORD_GRAYSCALE: u32 = 6;
pub const OT_SCENE_RECORD_COLOR_MATRIX: u32 = 7;
pub const OT_SCENE_RECORD_TEXT_VIEW: u32 = 8;
pub const OT_SCENE_RECORD_EDITOR_VIEW: u32 = 9;
pub const OT_SCENE_RECORD_SCENE_BODY: u32 = 10;
pub const OT_SCENE_RECORD_IMAGE: u32 = 11;
pub const OT_SCENE_RECORD_UNICODE: u32 = 12;
pub const OT_SCENE_RECORD_GRAYSCALE_FOREGROUND: u32 = 1;
pub const OT_SCENE_RECORD_GRAYSCALE_BACKGROUND: u32 = 2;
pub const OT_SCENE_RECORD_GRAYSCALE_SUPERSAMPLED: u32 = 4;
pub const OT_INPUT_RESET_KEEP_REPLY: u32 = 1;
pub const OT_CLIPBOARD_OPERATION_PENDING: u32 = 0;
pub const OT_CLIPBOARD_OPERATION_READ: u32 = 1;
pub const OT_CLIPBOARD_OPERATION_EMPTY: u32 = 2;
pub const OT_CLIPBOARD_OPERATION_WRITTEN: u32 = 3;
pub const OT_CLIPBOARD_OPERATION_CLEARED: u32 = 4;
pub const OT_CLIPBOARD_OPERATION_UNSUPPORTED: u32 = 5;
pub const OT_CLIPBOARD_OPERATION_CANCELLED: u32 = 6;
pub const OT_CLIPBOARD_OPERATION_TIMED_OUT: u32 = 7;
pub const OT_CLIPBOARD_OPERATION_LIMIT_EXCEEDED: u32 = 8;
pub const OT_CLIPBOARD_OPERATION_FAILED: u32 = 9;
pub const OT_CLIPBOARD_OPERATION_INVALID_HANDLE: u32 = 10;
pub const OT_CLIPBOARD_START_OK: u32 = 0;
pub const OT_CLIPBOARD_START_INVALID_SERVICE: u32 = 1;
pub const OT_CLIPBOARD_START_SHUTTING_DOWN: u32 = 2;
pub const OT_CLIPBOARD_START_LIMIT_EXCEEDED: u32 = 3;
pub const OT_CLIPBOARD_START_INVALID_ARGUMENT: u32 = 4;
pub const OT_CLIPBOARD_START_OUT_OF_MEMORY: u32 = 5;
pub const OT_CLIPBOARD_CANCEL_REQUESTED: u32 = 0;
pub const OT_CLIPBOARD_CANCEL_ALREADY_TERMINAL: u32 = 1;
pub const OT_CLIPBOARD_CANCEL_INVALID_HANDLE: u32 = 2;
pub const OT_CLIPBOARD_COPY_OK: u32 = 0;
pub const OT_CLIPBOARD_COPY_BUFFER_TOO_SMALL: u32 = 1;
pub const OT_CLIPBOARD_COPY_INVALID_HANDLE: u32 = 2;
pub const OT_CLIPBOARD_COPY_INVALID_STATE: u32 = 3;
pub const OT_CLIPBOARD_COPY_INVALID_ARGUMENT: u32 = 4;
pub const OT_CLIPBOARD_DESTROY_DESTROYED: u32 = 0;
pub const OT_CLIPBOARD_DESTROY_NOT_READY: u32 = 1;
pub const OT_CLIPBOARD_DESTROY_INVALID_HANDLE: u32 = 2;
pub const OT_CLIPBOARD_SHUTDOWN_PENDING: u32 = 0;
pub const OT_CLIPBOARD_SHUTDOWN_READY: u32 = 1;
pub const OT_CLIPBOARD_SHUTDOWN_INVALID_HANDLE: u32 = 2;

pub type ot_scene_measure_callback = Option<unsafe extern "C" fn(context_id: u64, slot: u32, generation: u32, width: f32, width_mode: u32, height: f32, height_mode: u32, out_size: *mut f32)>;
pub type ot_edit_event_callback = Option<unsafe extern "C" fn(context_id: u64, slot: u32, generation: u32, event: u32)>;
pub type ot_output_write_callback = Option<unsafe extern "C" fn(user_data: *mut c_void, bytes: *const u8, byte_count: u32) -> i64>;

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_handle {
    pub context_id: u64,
    pub slot: u32,
    pub generation: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_handle {}

impl Default for ot_handle {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        unsafe { core::mem::zeroed() }
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_handle>() == 16);
    assert!(core::mem::align_of::<ot_handle>() == 8);
    assert!(core::mem::offset_of!(ot_handle, context_id) == 0);
    assert!(core::mem::offset_of!(ot_handle, slot) == 8);
    assert!(core::mem::offset_of!(ot_handle, generation) == 12);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ot_scene_slider_options {
    pub struct_size: u32,
    pub abi_version: u32,
    pub orientation: u32,
    pub reserved: u32,
    pub min: f64,
    pub max: f64,
    pub value: f64,
    pub viewport_size: f64,
    pub foreground: [u16; 4],
    pub background: [u16; 4],
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_scene_slider_options {}

impl Default for ot_scene_slider_options {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_scene_slider_options>() == 64);
    assert!(core::mem::align_of::<ot_scene_slider_options>() == 8);
    assert!(core::mem::offset_of!(ot_scene_slider_options, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_scene_slider_options, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_scene_slider_options, orientation) == 8);
    assert!(core::mem::offset_of!(ot_scene_slider_options, reserved) == 12);
    assert!(core::mem::offset_of!(ot_scene_slider_options, min) == 16);
    assert!(core::mem::offset_of!(ot_scene_slider_options, max) == 24);
    assert!(core::mem::offset_of!(ot_scene_slider_options, value) == 32);
    assert!(core::mem::offset_of!(ot_scene_slider_options, viewport_size) == 40);
    assert!(core::mem::offset_of!(ot_scene_slider_options, foreground) == 48);
    assert!(core::mem::offset_of!(ot_scene_slider_options, background) == 56);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ot_scene_slider_thumb {
    pub struct_size: u32,
    pub abi_version: u32,
    pub size: f64,
    pub start: f64,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_scene_slider_thumb {}

impl Default for ot_scene_slider_thumb {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_scene_slider_thumb>() == 24);
    assert!(core::mem::align_of::<ot_scene_slider_thumb>() == 8);
    assert!(core::mem::offset_of!(ot_scene_slider_thumb, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_scene_slider_thumb, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_scene_slider_thumb, size) == 8);
    assert!(core::mem::offset_of!(ot_scene_slider_thumb, start) == 16);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_scene_arrow_options {
    pub struct_size: u32,
    pub abi_version: u32,
    pub direction: u32,
    pub attributes: u32,
    pub foreground: [u16; 4],
    pub background: [u16; 4],
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_scene_arrow_options {}

impl Default for ot_scene_arrow_options {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_scene_arrow_options>() == 32);
    assert!(core::mem::align_of::<ot_scene_arrow_options>() == 4);
    assert!(core::mem::offset_of!(ot_scene_arrow_options, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_scene_arrow_options, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_scene_arrow_options, direction) == 8);
    assert!(core::mem::offset_of!(ot_scene_arrow_options, attributes) == 12);
    assert!(core::mem::offset_of!(ot_scene_arrow_options, foreground) == 16);
    assert!(core::mem::offset_of!(ot_scene_arrow_options, background) == 24);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ot_scene_text_options {
    pub struct_size: u32,
    pub abi_version: u32,
    pub foreground: [u16; 4],
    pub background: [u16; 4],
    pub attributes: u32,
    pub wrap_mode: u32,
    pub truncate: u32,
    pub first_line_offset: u32,
    pub scroll_x: f64,
    pub scroll_y: f64,
    pub tab_indicator: u32,
    pub tab_color_set: u32,
    pub tab_color: [u16; 4],
    pub text_align: u32,
}

impl Default for ot_scene_text_options {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_scene_text_options>() == 80);
    assert!(core::mem::align_of::<ot_scene_text_options>() == 8);
    assert!(core::mem::offset_of!(ot_scene_text_options, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_scene_text_options, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_scene_text_options, foreground) == 8);
    assert!(core::mem::offset_of!(ot_scene_text_options, background) == 16);
    assert!(core::mem::offset_of!(ot_scene_text_options, attributes) == 24);
    assert!(core::mem::offset_of!(ot_scene_text_options, wrap_mode) == 28);
    assert!(core::mem::offset_of!(ot_scene_text_options, truncate) == 32);
    assert!(core::mem::offset_of!(ot_scene_text_options, first_line_offset) == 36);
    assert!(core::mem::offset_of!(ot_scene_text_options, scroll_x) == 40);
    assert!(core::mem::offset_of!(ot_scene_text_options, scroll_y) == 48);
    assert!(core::mem::offset_of!(ot_scene_text_options, tab_indicator) == 56);
    assert!(core::mem::offset_of!(ot_scene_text_options, tab_color_set) == 60);
    assert!(core::mem::offset_of!(ot_scene_text_options, tab_color) == 64);
    assert!(core::mem::offset_of!(ot_scene_text_options, text_align) == 72);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_scene_text_selection_options {
    pub struct_size: u32,
    pub abi_version: u32,
    pub operation: u32,
    pub behavior: u32,
    pub anchor_x: i32,
    pub anchor_y: i32,
    pub focus_x: i32,
    pub focus_y: i32,
    pub flags: u32,
    pub reserved: u32,
    pub background: [u16; 4],
    pub foreground: [u16; 4],
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_scene_text_selection_options {}

impl Default for ot_scene_text_selection_options {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_scene_text_selection_options>() == 56);
    assert!(core::mem::align_of::<ot_scene_text_selection_options>() == 4);
    assert!(core::mem::offset_of!(ot_scene_text_selection_options, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_scene_text_selection_options, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_scene_text_selection_options, operation) == 8);
    assert!(core::mem::offset_of!(ot_scene_text_selection_options, behavior) == 12);
    assert!(core::mem::offset_of!(ot_scene_text_selection_options, anchor_x) == 16);
    assert!(core::mem::offset_of!(ot_scene_text_selection_options, anchor_y) == 20);
    assert!(core::mem::offset_of!(ot_scene_text_selection_options, focus_x) == 24);
    assert!(core::mem::offset_of!(ot_scene_text_selection_options, focus_y) == 28);
    assert!(core::mem::offset_of!(ot_scene_text_selection_options, flags) == 32);
    assert!(core::mem::offset_of!(ot_scene_text_selection_options, reserved) == 36);
    assert!(core::mem::offset_of!(ot_scene_text_selection_options, background) == 40);
    assert!(core::mem::offset_of!(ot_scene_text_selection_options, foreground) == 48);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_styled_text_chunk {
    pub struct_size: u32,
    pub abi_version: u32,
    pub byte_count: u32,
    pub flags: u32,
    pub foreground: [u16; 4],
    pub background: [u16; 4],
    pub attributes: u32,
    pub reserved: u32,
    pub link_offset: u32,
    pub link_byte_count: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_styled_text_chunk {}

impl Default for ot_styled_text_chunk {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_styled_text_chunk>() == 48);
    assert!(core::mem::align_of::<ot_styled_text_chunk>() == 4);
    assert!(core::mem::offset_of!(ot_styled_text_chunk, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_styled_text_chunk, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_styled_text_chunk, byte_count) == 8);
    assert!(core::mem::offset_of!(ot_styled_text_chunk, flags) == 12);
    assert!(core::mem::offset_of!(ot_styled_text_chunk, foreground) == 16);
    assert!(core::mem::offset_of!(ot_styled_text_chunk, background) == 24);
    assert!(core::mem::offset_of!(ot_styled_text_chunk, attributes) == 32);
    assert!(core::mem::offset_of!(ot_styled_text_chunk, reserved) == 36);
    assert!(core::mem::offset_of!(ot_styled_text_chunk, link_offset) == 40);
    assert!(core::mem::offset_of!(ot_styled_text_chunk, link_byte_count) == 44);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_scene_text_info {
    pub struct_size: u32,
    pub abi_version: u32,
    pub byte_count: u32,
    pub text_length: u32,
    pub line_count: u32,
    pub virtual_line_count: u32,
    pub width_cols_max: u32,
    pub reserved: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_scene_text_info {}

impl Default for ot_scene_text_info {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_scene_text_info>() == 32);
    assert!(core::mem::align_of::<ot_scene_text_info>() == 4);
    assert!(core::mem::offset_of!(ot_scene_text_info, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_scene_text_info, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_scene_text_info, byte_count) == 8);
    assert!(core::mem::offset_of!(ot_scene_text_info, text_length) == 12);
    assert!(core::mem::offset_of!(ot_scene_text_info, line_count) == 16);
    assert!(core::mem::offset_of!(ot_scene_text_info, virtual_line_count) == 20);
    assert!(core::mem::offset_of!(ot_scene_text_info, width_cols_max) == 24);
    assert!(core::mem::offset_of!(ot_scene_text_info, reserved) == 28);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_scene_text_line {
    pub start_cols: u32,
    pub width_cols: u32,
    pub source_line: u32,
    pub wrap_index: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_scene_text_line {}

impl Default for ot_scene_text_line {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        unsafe { core::mem::zeroed() }
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_scene_text_line>() == 16);
    assert!(core::mem::align_of::<ot_scene_text_line>() == 4);
    assert!(core::mem::offset_of!(ot_scene_text_line, start_cols) == 0);
    assert!(core::mem::offset_of!(ot_scene_text_line, width_cols) == 4);
    assert!(core::mem::offset_of!(ot_scene_text_line, source_line) == 8);
    assert!(core::mem::offset_of!(ot_scene_text_line, wrap_index) == 12);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ot_scene_paint_options {
    pub struct_size: u32,
    pub abi_version: u32,
    pub z_index: i32,
    pub opacity: f32,
    pub translate_x: f64,
    pub translate_y: f64,
    pub border_sides: u32,
    pub should_fill: u32,
    pub background: [u16; 4],
    pub border_color: [u16; 4],
    pub border_style: u32,
    pub focusable: u32,
    pub focused_border_color: [u16; 4],
    pub reserved: u32,
}

impl Default for ot_scene_paint_options {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_scene_paint_options>() == 80);
    assert!(core::mem::align_of::<ot_scene_paint_options>() == 8);
    assert!(core::mem::offset_of!(ot_scene_paint_options, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_scene_paint_options, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_scene_paint_options, z_index) == 8);
    assert!(core::mem::offset_of!(ot_scene_paint_options, opacity) == 12);
    assert!(core::mem::offset_of!(ot_scene_paint_options, translate_x) == 16);
    assert!(core::mem::offset_of!(ot_scene_paint_options, translate_y) == 24);
    assert!(core::mem::offset_of!(ot_scene_paint_options, border_sides) == 32);
    assert!(core::mem::offset_of!(ot_scene_paint_options, should_fill) == 36);
    assert!(core::mem::offset_of!(ot_scene_paint_options, background) == 40);
    assert!(core::mem::offset_of!(ot_scene_paint_options, border_color) == 48);
    assert!(core::mem::offset_of!(ot_scene_paint_options, border_style) == 56);
    assert!(core::mem::offset_of!(ot_scene_paint_options, focusable) == 60);
    assert!(core::mem::offset_of!(ot_scene_paint_options, focused_border_color) == 64);
    assert!(core::mem::offset_of!(ot_scene_paint_options, reserved) == 72);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_scene_box_details {
    pub struct_size: u32,
    pub abi_version: u32,
    pub title_alignment: u32,
    pub bottom_title_alignment: u32,
    pub flags: u32,
    pub reserved: u32,
    pub title_color: [u16; 4],
    pub border_characters: [u32; 11],
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_scene_box_details {}

impl Default for ot_scene_box_details {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_scene_box_details>() == 76);
    assert!(core::mem::align_of::<ot_scene_box_details>() == 4);
    assert!(core::mem::offset_of!(ot_scene_box_details, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_scene_box_details, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_scene_box_details, title_alignment) == 8);
    assert!(core::mem::offset_of!(ot_scene_box_details, bottom_title_alignment) == 12);
    assert!(core::mem::offset_of!(ot_scene_box_details, flags) == 16);
    assert!(core::mem::offset_of!(ot_scene_box_details, reserved) == 20);
    assert!(core::mem::offset_of!(ot_scene_box_details, title_color) == 24);
    assert!(core::mem::offset_of!(ot_scene_box_details, border_characters) == 32);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ot_scene_style_value {
    pub struct_size: u32,
    pub abi_version: u32,
    pub unit: u32,
    pub value: f32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_scene_style_value {}

impl Default for ot_scene_style_value {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_scene_style_value>() == 16);
    assert!(core::mem::align_of::<ot_scene_style_value>() == 4);
    assert!(core::mem::offset_of!(ot_scene_style_value, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_scene_style_value, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_scene_style_value, unit) == 8);
    assert!(core::mem::offset_of!(ot_scene_style_value, value) == 12);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ot_scene_layout {
    pub struct_size: u32,
    pub abi_version: u32,
    pub left: f32,
    pub top: f32,
    pub right: f32,
    pub bottom: f32,
    pub width: f32,
    pub height: f32,
    pub screen_x: f64,
    pub screen_y: f64,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_scene_layout {}

impl Default for ot_scene_layout {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_scene_layout>() == 48);
    assert!(core::mem::align_of::<ot_scene_layout>() == 8);
    assert!(core::mem::offset_of!(ot_scene_layout, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_scene_layout, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_scene_layout, left) == 8);
    assert!(core::mem::offset_of!(ot_scene_layout, top) == 12);
    assert!(core::mem::offset_of!(ot_scene_layout, right) == 16);
    assert!(core::mem::offset_of!(ot_scene_layout, bottom) == 20);
    assert!(core::mem::offset_of!(ot_scene_layout, width) == 24);
    assert!(core::mem::offset_of!(ot_scene_layout, height) == 28);
    assert!(core::mem::offset_of!(ot_scene_layout, screen_x) == 32);
    assert!(core::mem::offset_of!(ot_scene_layout, screen_y) == 40);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ot_scene_stats {
    pub struct_size: u32,
    pub abi_version: u32,
    pub last_frame_time: f64,
    pub average_frame_time: f64,
    pub render_time: f64,
    pub stdout_write_time: f64,
    pub frame_count: u64,
    pub cells_updated: u32,
    pub average_cells_updated: u32,
    pub render_time_valid: u32,
    pub stdout_write_time_valid: u32,
    pub work_frame_id: u64,
    pub candidate_visits: u64,
    pub paint_visits: u64,
    pub view_preparations: u64,
    pub geometry_reads: u64,
    pub yoga_solves: u64,
    pub feedback_operations: u64,
    pub visibility_steps: u64,
    pub viewport_child_refreshes: u64,
    pub overlap_tests: u64,
    pub members_painted: u64,
    pub member_cells: u64,
    pub cells_cleared: u64,
    pub hit_cells_written: u64,
    pub hit_cells_cleared: u64,
    pub hit_cells_compared: u64,
    pub rows_compared: u64,
    pub rows_diffed: u64,
    pub full_path_reasons: u32,
    pub host_requests: u32,
    pub layout_rounds: u32,
    pub damage_rows: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_scene_stats {}

impl Default for ot_scene_stats {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_scene_stats>() == 224);
    assert!(core::mem::align_of::<ot_scene_stats>() == 8);
    assert!(core::mem::offset_of!(ot_scene_stats, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_scene_stats, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_scene_stats, last_frame_time) == 8);
    assert!(core::mem::offset_of!(ot_scene_stats, average_frame_time) == 16);
    assert!(core::mem::offset_of!(ot_scene_stats, render_time) == 24);
    assert!(core::mem::offset_of!(ot_scene_stats, stdout_write_time) == 32);
    assert!(core::mem::offset_of!(ot_scene_stats, frame_count) == 40);
    assert!(core::mem::offset_of!(ot_scene_stats, cells_updated) == 48);
    assert!(core::mem::offset_of!(ot_scene_stats, average_cells_updated) == 52);
    assert!(core::mem::offset_of!(ot_scene_stats, render_time_valid) == 56);
    assert!(core::mem::offset_of!(ot_scene_stats, stdout_write_time_valid) == 60);
    assert!(core::mem::offset_of!(ot_scene_stats, work_frame_id) == 64);
    assert!(core::mem::offset_of!(ot_scene_stats, candidate_visits) == 72);
    assert!(core::mem::offset_of!(ot_scene_stats, paint_visits) == 80);
    assert!(core::mem::offset_of!(ot_scene_stats, view_preparations) == 88);
    assert!(core::mem::offset_of!(ot_scene_stats, geometry_reads) == 96);
    assert!(core::mem::offset_of!(ot_scene_stats, yoga_solves) == 104);
    assert!(core::mem::offset_of!(ot_scene_stats, feedback_operations) == 112);
    assert!(core::mem::offset_of!(ot_scene_stats, visibility_steps) == 120);
    assert!(core::mem::offset_of!(ot_scene_stats, viewport_child_refreshes) == 128);
    assert!(core::mem::offset_of!(ot_scene_stats, overlap_tests) == 136);
    assert!(core::mem::offset_of!(ot_scene_stats, members_painted) == 144);
    assert!(core::mem::offset_of!(ot_scene_stats, member_cells) == 152);
    assert!(core::mem::offset_of!(ot_scene_stats, cells_cleared) == 160);
    assert!(core::mem::offset_of!(ot_scene_stats, hit_cells_written) == 168);
    assert!(core::mem::offset_of!(ot_scene_stats, hit_cells_cleared) == 176);
    assert!(core::mem::offset_of!(ot_scene_stats, hit_cells_compared) == 184);
    assert!(core::mem::offset_of!(ot_scene_stats, rows_compared) == 192);
    assert!(core::mem::offset_of!(ot_scene_stats, rows_diffed) == 200);
    assert!(core::mem::offset_of!(ot_scene_stats, full_path_reasons) == 208);
    assert!(core::mem::offset_of!(ot_scene_stats, host_requests) == 212);
    assert!(core::mem::offset_of!(ot_scene_stats, layout_rounds) == 216);
    assert!(core::mem::offset_of!(ot_scene_stats, damage_rows) == 220);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ot_scene_cursor_state {
    pub struct_size: u32,
    pub abi_version: u32,
    pub x: u32,
    pub y: u32,
    pub visible: u32,
    pub style: u32,
    pub blinking: u32,
    pub reserved: u32,
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_scene_cursor_state {}

impl Default for ot_scene_cursor_state {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_scene_cursor_state>() == 48);
    assert!(core::mem::align_of::<ot_scene_cursor_state>() == 4);
    assert!(core::mem::offset_of!(ot_scene_cursor_state, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_scene_cursor_state, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_scene_cursor_state, x) == 8);
    assert!(core::mem::offset_of!(ot_scene_cursor_state, y) == 12);
    assert!(core::mem::offset_of!(ot_scene_cursor_state, visible) == 16);
    assert!(core::mem::offset_of!(ot_scene_cursor_state, style) == 20);
    assert!(core::mem::offset_of!(ot_scene_cursor_state, blinking) == 24);
    assert!(core::mem::offset_of!(ot_scene_cursor_state, reserved) == 28);
    assert!(core::mem::offset_of!(ot_scene_cursor_state, r) == 32);
    assert!(core::mem::offset_of!(ot_scene_cursor_state, g) == 36);
    assert!(core::mem::offset_of!(ot_scene_cursor_state, b) == 40);
    assert!(core::mem::offset_of!(ot_scene_cursor_state, a) == 44);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ot_scene_hooks {
    pub struct_size: u32,
    pub abi_version: u32,
    pub flags: u32,
    pub reserved: u32,
    pub generation: u64,
    pub initial_width: f64,
    pub initial_height: f64,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_scene_hooks {}

impl Default for ot_scene_hooks {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_scene_hooks>() == 40);
    assert!(core::mem::align_of::<ot_scene_hooks>() == 8);
    assert!(core::mem::offset_of!(ot_scene_hooks, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_scene_hooks, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_scene_hooks, flags) == 8);
    assert!(core::mem::offset_of!(ot_scene_hooks, reserved) == 12);
    assert!(core::mem::offset_of!(ot_scene_hooks, generation) == 16);
    assert!(core::mem::offset_of!(ot_scene_hooks, initial_width) == 24);
    assert!(core::mem::offset_of!(ot_scene_hooks, initial_height) == 32);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_scene_frame_options {
    pub struct_size: u32,
    pub abi_version: u32,
    pub background: [u16; 4],
    pub use_mouse: u32,
    pub excluded_hit_num: u32,
    pub max_layout_rounds: u32,
    pub max_host_requests: u32,
    pub preserve_unwritten: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_scene_frame_options {}

impl Default for ot_scene_frame_options {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_scene_frame_options>() == 36);
    assert!(core::mem::align_of::<ot_scene_frame_options>() == 4);
    assert!(core::mem::offset_of!(ot_scene_frame_options, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_scene_frame_options, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_scene_frame_options, background) == 8);
    assert!(core::mem::offset_of!(ot_scene_frame_options, use_mouse) == 16);
    assert!(core::mem::offset_of!(ot_scene_frame_options, excluded_hit_num) == 20);
    assert!(core::mem::offset_of!(ot_scene_frame_options, max_layout_rounds) == 24);
    assert!(core::mem::offset_of!(ot_scene_frame_options, max_host_requests) == 28);
    assert!(core::mem::offset_of!(ot_scene_frame_options, preserve_unwritten) == 32);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_scene_frame_request {
    pub struct_size: u32,
    pub abi_version: u32,
    pub session: ot_handle,
    pub root: ot_handle,
    pub node: ot_handle,
    pub frame_id: u64,
    pub request_id: u64,
    pub layout_epoch: u64,
    pub hook_generation: u64,
    pub kind: u32,
    pub num: u32,
    pub width: u32,
    pub height: u32,
    pub reserved: [u32; 2],
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_scene_frame_request {}

impl Default for ot_scene_frame_request {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_scene_frame_request>() == 112);
    assert!(core::mem::align_of::<ot_scene_frame_request>() == 8);
    assert!(core::mem::offset_of!(ot_scene_frame_request, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_scene_frame_request, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_scene_frame_request, session) == 8);
    assert!(core::mem::offset_of!(ot_scene_frame_request, root) == 24);
    assert!(core::mem::offset_of!(ot_scene_frame_request, node) == 40);
    assert!(core::mem::offset_of!(ot_scene_frame_request, frame_id) == 56);
    assert!(core::mem::offset_of!(ot_scene_frame_request, request_id) == 64);
    assert!(core::mem::offset_of!(ot_scene_frame_request, layout_epoch) == 72);
    assert!(core::mem::offset_of!(ot_scene_frame_request, hook_generation) == 80);
    assert!(core::mem::offset_of!(ot_scene_frame_request, kind) == 88);
    assert!(core::mem::offset_of!(ot_scene_frame_request, num) == 92);
    assert!(core::mem::offset_of!(ot_scene_frame_request, width) == 96);
    assert!(core::mem::offset_of!(ot_scene_frame_request, height) == 100);
    assert!(core::mem::offset_of!(ot_scene_frame_request, reserved) == 104);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ot_scene_frame_geometry {
    pub struct_size: u32,
    pub abi_version: u32,
    pub flags: u32,
    pub reserved: u32,
    pub paint: ot_scene_layout,
    pub public_layout: ot_scene_layout,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_scene_frame_geometry {}

impl Default for ot_scene_frame_geometry {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_scene_frame_geometry>() == 112);
    assert!(core::mem::align_of::<ot_scene_frame_geometry>() == 8);
    assert!(core::mem::offset_of!(ot_scene_frame_geometry, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_scene_frame_geometry, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_scene_frame_geometry, flags) == 8);
    assert!(core::mem::offset_of!(ot_scene_frame_geometry, reserved) == 12);
    assert!(core::mem::offset_of!(ot_scene_frame_geometry, paint) == 16);
    assert!(core::mem::offset_of!(ot_scene_frame_geometry, public_layout) == 64);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ot_scene_paint_slot {
    pub node: ot_handle,
    pub hook_generation: u64,
    pub num: u32,
    pub hooks: u32,
    pub clip_x: i32,
    pub clip_y: i32,
    pub clip_width: u32,
    pub clip_height: u32,
    pub opacity: f32,
    pub flags: u32,
    pub paint: ot_scene_layout,
    pub public_layout: ot_scene_layout,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_scene_paint_slot {}

impl Default for ot_scene_paint_slot {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        unsafe { core::mem::zeroed() }
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_scene_paint_slot>() == 152);
    assert!(core::mem::align_of::<ot_scene_paint_slot>() == 8);
    assert!(core::mem::offset_of!(ot_scene_paint_slot, node) == 0);
    assert!(core::mem::offset_of!(ot_scene_paint_slot, hook_generation) == 16);
    assert!(core::mem::offset_of!(ot_scene_paint_slot, num) == 24);
    assert!(core::mem::offset_of!(ot_scene_paint_slot, hooks) == 28);
    assert!(core::mem::offset_of!(ot_scene_paint_slot, clip_x) == 32);
    assert!(core::mem::offset_of!(ot_scene_paint_slot, clip_y) == 36);
    assert!(core::mem::offset_of!(ot_scene_paint_slot, clip_width) == 40);
    assert!(core::mem::offset_of!(ot_scene_paint_slot, clip_height) == 44);
    assert!(core::mem::offset_of!(ot_scene_paint_slot, opacity) == 48);
    assert!(core::mem::offset_of!(ot_scene_paint_slot, flags) == 52);
    assert!(core::mem::offset_of!(ot_scene_paint_slot, paint) == 56);
    assert!(core::mem::offset_of!(ot_scene_paint_slot, public_layout) == 104);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_scene_property_update {
    pub node: ot_handle,
    pub fields: u32,
    pub size_bytes: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_scene_property_update {}

impl Default for ot_scene_property_update {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        unsafe { core::mem::zeroed() }
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_scene_property_update>() == 24);
    assert!(core::mem::align_of::<ot_scene_property_update>() == 8);
    assert!(core::mem::offset_of!(ot_scene_property_update, node) == 0);
    assert!(core::mem::offset_of!(ot_scene_property_update, fields) == 16);
    assert!(core::mem::offset_of!(ot_scene_property_update, size_bytes) == 20);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ot_scene_style_property {
    pub group: u8,
    pub kind: u8,
    pub edge: u8,
    pub unit: u8,
    pub flags: u32,
    pub value: f32,
    pub reserved: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_scene_style_property {}

impl Default for ot_scene_style_property {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        unsafe { core::mem::zeroed() }
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_scene_style_property>() == 16);
    assert!(core::mem::align_of::<ot_scene_style_property>() == 4);
    assert!(core::mem::offset_of!(ot_scene_style_property, group) == 0);
    assert!(core::mem::offset_of!(ot_scene_style_property, kind) == 1);
    assert!(core::mem::offset_of!(ot_scene_style_property, edge) == 2);
    assert!(core::mem::offset_of!(ot_scene_style_property, unit) == 3);
    assert!(core::mem::offset_of!(ot_scene_style_property, flags) == 4);
    assert!(core::mem::offset_of!(ot_scene_style_property, value) == 8);
    assert!(core::mem::offset_of!(ot_scene_style_property, reserved) == 12);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_scene_scroll_bar_options {
    pub policy: u32,
    pub placement: u32,
    pub thickness: u32,
    pub gap: u32,
    pub arrows: u32,
    pub reserved: u32,
    pub track_foreground: [u16; 4],
    pub track_background: [u16; 4],
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_scene_scroll_bar_options {}

impl Default for ot_scene_scroll_bar_options {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        unsafe { core::mem::zeroed() }
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_scene_scroll_bar_options>() == 40);
    assert!(core::mem::align_of::<ot_scene_scroll_bar_options>() == 4);
    assert!(core::mem::offset_of!(ot_scene_scroll_bar_options, policy) == 0);
    assert!(core::mem::offset_of!(ot_scene_scroll_bar_options, placement) == 4);
    assert!(core::mem::offset_of!(ot_scene_scroll_bar_options, thickness) == 8);
    assert!(core::mem::offset_of!(ot_scene_scroll_bar_options, gap) == 12);
    assert!(core::mem::offset_of!(ot_scene_scroll_bar_options, arrows) == 16);
    assert!(core::mem::offset_of!(ot_scene_scroll_bar_options, reserved) == 20);
    assert!(core::mem::offset_of!(ot_scene_scroll_bar_options, track_foreground) == 24);
    assert!(core::mem::offset_of!(ot_scene_scroll_bar_options, track_background) == 32);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ot_scene_scroll_options {
    pub struct_size: u32,
    pub abi_version: u32,
    pub axes: u32,
    pub follow: u32,
    pub culling: u32,
    pub fills: u32,
    pub padding: [f32; 4],
    pub wrapper_background: [u16; 4],
    pub viewport_background: [u16; 4],
    pub content_background: [u16; 4],
    pub bars: [ot_scene_scroll_bar_options; 2],
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_scene_scroll_options {}

impl Default for ot_scene_scroll_options {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_scene_scroll_options>() == 144);
    assert!(core::mem::align_of::<ot_scene_scroll_options>() == 4);
    assert!(core::mem::offset_of!(ot_scene_scroll_options, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_scene_scroll_options, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_scene_scroll_options, axes) == 8);
    assert!(core::mem::offset_of!(ot_scene_scroll_options, follow) == 12);
    assert!(core::mem::offset_of!(ot_scene_scroll_options, culling) == 16);
    assert!(core::mem::offset_of!(ot_scene_scroll_options, fills) == 20);
    assert!(core::mem::offset_of!(ot_scene_scroll_options, padding) == 24);
    assert!(core::mem::offset_of!(ot_scene_scroll_options, wrapper_background) == 40);
    assert!(core::mem::offset_of!(ot_scene_scroll_options, viewport_background) == 48);
    assert!(core::mem::offset_of!(ot_scene_scroll_options, content_background) == 56);
    assert!(core::mem::offset_of!(ot_scene_scroll_options, bars) == 64);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ot_scene_scroll_bar_state {
    pub visible: u32,
    pub reserved: u32,
    pub track: [f64; 4],
    pub start_arrow: [f64; 4],
    pub end_arrow: [f64; 4],
    pub thumb_start: f64,
    pub thumb_size: f64,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_scene_scroll_bar_state {}

impl Default for ot_scene_scroll_bar_state {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        unsafe { core::mem::zeroed() }
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_scene_scroll_bar_state>() == 120);
    assert!(core::mem::align_of::<ot_scene_scroll_bar_state>() == 8);
    assert!(core::mem::offset_of!(ot_scene_scroll_bar_state, visible) == 0);
    assert!(core::mem::offset_of!(ot_scene_scroll_bar_state, reserved) == 4);
    assert!(core::mem::offset_of!(ot_scene_scroll_bar_state, track) == 8);
    assert!(core::mem::offset_of!(ot_scene_scroll_bar_state, start_arrow) == 40);
    assert!(core::mem::offset_of!(ot_scene_scroll_bar_state, end_arrow) == 72);
    assert!(core::mem::offset_of!(ot_scene_scroll_bar_state, thumb_start) == 104);
    assert!(core::mem::offset_of!(ot_scene_scroll_bar_state, thumb_size) == 112);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ot_scene_scroll_state {
    pub struct_size: u32,
    pub abi_version: u32,
    pub stuck: u32,
    pub changes: u32,
    pub generation: u64,
    pub offset: [f64; 2],
    pub max: [f64; 2],
    pub content: [f64; 4],
    pub viewport: [f64; 4],
    pub bars: [ot_scene_scroll_bar_state; 2],
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_scene_scroll_state {}

impl Default for ot_scene_scroll_state {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_scene_scroll_state>() == 360);
    assert!(core::mem::align_of::<ot_scene_scroll_state>() == 8);
    assert!(core::mem::offset_of!(ot_scene_scroll_state, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_scene_scroll_state, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_scene_scroll_state, stuck) == 8);
    assert!(core::mem::offset_of!(ot_scene_scroll_state, changes) == 12);
    assert!(core::mem::offset_of!(ot_scene_scroll_state, generation) == 16);
    assert!(core::mem::offset_of!(ot_scene_scroll_state, offset) == 24);
    assert!(core::mem::offset_of!(ot_scene_scroll_state, max) == 40);
    assert!(core::mem::offset_of!(ot_scene_scroll_state, content) == 56);
    assert!(core::mem::offset_of!(ot_scene_scroll_state, viewport) == 88);
    assert!(core::mem::offset_of!(ot_scene_scroll_state, bars) == 120);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_session_options {
    pub struct_size: u32,
    pub abi_version: u32,
    pub chunk_size: u32,
    pub span_capacity: u32,
    pub max_bytes: u64,
    pub control_capacity: u32,
    pub reserved: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_session_options {}

impl Default for ot_session_options {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_session_options>() == 32);
    assert!(core::mem::align_of::<ot_session_options>() == 8);
    assert!(core::mem::offset_of!(ot_session_options, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_session_options, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_session_options, chunk_size) == 8);
    assert!(core::mem::offset_of!(ot_session_options, span_capacity) == 12);
    assert!(core::mem::offset_of!(ot_session_options, max_bytes) == 16);
    assert!(core::mem::offset_of!(ot_session_options, control_capacity) == 24);
    assert!(core::mem::offset_of!(ot_session_options, reserved) == 28);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_output_ticket {
    pub session: ot_handle,
    pub request_id: u64,
    pub byte_count: u32,
    pub reserved: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_output_ticket {}

impl Default for ot_output_ticket {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        unsafe { core::mem::zeroed() }
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_output_ticket>() == 32);
    assert!(core::mem::align_of::<ot_output_ticket>() == 8);
    assert!(core::mem::offset_of!(ot_output_ticket, session) == 0);
    assert!(core::mem::offset_of!(ot_output_ticket, request_id) == 16);
    assert!(core::mem::offset_of!(ot_output_ticket, byte_count) == 24);
    assert!(core::mem::offset_of!(ot_output_ticket, reserved) == 28);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_session_renderer_options {
    pub struct_size: u32,
    pub abi_version: u32,
    pub width: u32,
    pub height: u32,
    pub remote: u32,
    pub reserved: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_session_renderer_options {}

impl Default for ot_session_renderer_options {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_session_renderer_options>() == 24);
    assert!(core::mem::align_of::<ot_session_renderer_options>() == 4);
    assert!(core::mem::offset_of!(ot_session_renderer_options, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_session_renderer_options, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_session_renderer_options, width) == 8);
    assert!(core::mem::offset_of!(ot_session_renderer_options, height) == 12);
    assert!(core::mem::offset_of!(ot_session_renderer_options, remote) == 16);
    assert!(core::mem::offset_of!(ot_session_renderer_options, reserved) == 20);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_session_renderer_env_options {
    pub struct_size: u32,
    pub abi_version: u32,
    pub width: u32,
    pub height: u32,
    pub remote_mode: u32,
    pub entry_count: u32,
    pub byte_count: u32,
    pub reserved: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_session_renderer_env_options {}

impl Default for ot_session_renderer_env_options {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_session_renderer_env_options>() == 32);
    assert!(core::mem::align_of::<ot_session_renderer_env_options>() == 4);
    assert!(core::mem::offset_of!(ot_session_renderer_env_options, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_session_renderer_env_options, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_session_renderer_env_options, width) == 8);
    assert!(core::mem::offset_of!(ot_session_renderer_env_options, height) == 12);
    assert!(core::mem::offset_of!(ot_session_renderer_env_options, remote_mode) == 16);
    assert!(core::mem::offset_of!(ot_session_renderer_env_options, entry_count) == 20);
    assert!(core::mem::offset_of!(ot_session_renderer_env_options, byte_count) == 24);
    assert!(core::mem::offset_of!(ot_session_renderer_env_options, reserved) == 28);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_split_snapshot {
    pub buffer: ot_handle,
    pub row_columns: u32,
    pub flags: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_split_snapshot {}

impl Default for ot_split_snapshot {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        unsafe { core::mem::zeroed() }
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_split_snapshot>() == 24);
    assert!(core::mem::align_of::<ot_split_snapshot>() == 8);
    assert!(core::mem::offset_of!(ot_split_snapshot, buffer) == 0);
    assert!(core::mem::offset_of!(ot_split_snapshot, row_columns) == 16);
    assert!(core::mem::offset_of!(ot_split_snapshot, flags) == 20);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_split_control {
    pub struct_size: u32,
    pub abi_version: u32,
    pub command: u32,
    pub arguments: [u32; 6],
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_split_control {}

impl Default for ot_split_control {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_split_control>() == 36);
    assert!(core::mem::align_of::<ot_split_control>() == 4);
    assert!(core::mem::offset_of!(ot_split_control, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_split_control, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_split_control, command) == 8);
    assert!(core::mem::offset_of!(ot_split_control, arguments) == 12);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_session_renderer_state {
    pub struct_size: u32,
    pub abi_version: u32,
    pub width: u32,
    pub height: u32,
    pub frame_count: u64,
    pub frame_pending: u32,
    pub image_uploads_pending: u32,
    pub dropped_frames: u32,
    pub dropped_frame_bytes: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_session_renderer_state {}

impl Default for ot_session_renderer_state {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_session_renderer_state>() == 40);
    assert!(core::mem::align_of::<ot_session_renderer_state>() == 8);
    assert!(core::mem::offset_of!(ot_session_renderer_state, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_session_renderer_state, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_session_renderer_state, width) == 8);
    assert!(core::mem::offset_of!(ot_session_renderer_state, height) == 12);
    assert!(core::mem::offset_of!(ot_session_renderer_state, frame_count) == 16);
    assert!(core::mem::offset_of!(ot_session_renderer_state, frame_pending) == 24);
    assert!(core::mem::offset_of!(ot_session_renderer_state, image_uploads_pending) == 28);
    assert!(core::mem::offset_of!(ot_session_renderer_state, dropped_frames) == 32);
    assert!(core::mem::offset_of!(ot_session_renderer_state, dropped_frame_bytes) == 36);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_buffer_options {
    pub struct_size: u32,
    pub abi_version: u32,
    pub width: u32,
    pub height: u32,
    pub width_method: u32,
    pub flags: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_buffer_options {}

impl Default for ot_buffer_options {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_buffer_options>() == 24);
    assert!(core::mem::align_of::<ot_buffer_options>() == 4);
    assert!(core::mem::offset_of!(ot_buffer_options, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_buffer_options, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_buffer_options, width) == 8);
    assert!(core::mem::offset_of!(ot_buffer_options, height) == 12);
    assert!(core::mem::offset_of!(ot_buffer_options, width_method) == 16);
    assert!(core::mem::offset_of!(ot_buffer_options, flags) == 20);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_unicode_char {
    pub width: u32,
    pub character: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_unicode_char {}

impl Default for ot_unicode_char {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        unsafe { core::mem::zeroed() }
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_unicode_char>() == 8);
    assert!(core::mem::align_of::<ot_unicode_char>() == 4);
    assert!(core::mem::offset_of!(ot_unicode_char, width) == 0);
    assert!(core::mem::offset_of!(ot_unicode_char, character) == 4);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_embedded_terminal_options {
    pub struct_size: u32,
    pub abi_version: u32,
    pub cols: u32,
    pub rows: u32,
    pub max_scrollback: u32,
    pub reserved: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_embedded_terminal_options {}

impl Default for ot_embedded_terminal_options {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_embedded_terminal_options>() == 24);
    assert!(core::mem::align_of::<ot_embedded_terminal_options>() == 4);
    assert!(core::mem::offset_of!(ot_embedded_terminal_options, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_embedded_terminal_options, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_embedded_terminal_options, cols) == 8);
    assert!(core::mem::offset_of!(ot_embedded_terminal_options, rows) == 12);
    assert!(core::mem::offset_of!(ot_embedded_terminal_options, max_scrollback) == 16);
    assert!(core::mem::offset_of!(ot_embedded_terminal_options, reserved) == 20);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_embedded_terminal_cursor {
    pub struct_size: u32,
    pub abi_version: u32,
    pub x: u32,
    pub y: u32,
    pub has_value: u32,
    pub visible: u32,
    pub blinking: u32,
    pub wide_tail: u32,
    pub style: u32,
    pub color_has_value: u32,
    pub color_r: u32,
    pub color_g: u32,
    pub color_b: u32,
    pub reserved: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_embedded_terminal_cursor {}

impl Default for ot_embedded_terminal_cursor {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_embedded_terminal_cursor>() == 56);
    assert!(core::mem::align_of::<ot_embedded_terminal_cursor>() == 4);
    assert!(core::mem::offset_of!(ot_embedded_terminal_cursor, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_embedded_terminal_cursor, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_embedded_terminal_cursor, x) == 8);
    assert!(core::mem::offset_of!(ot_embedded_terminal_cursor, y) == 12);
    assert!(core::mem::offset_of!(ot_embedded_terminal_cursor, has_value) == 16);
    assert!(core::mem::offset_of!(ot_embedded_terminal_cursor, visible) == 20);
    assert!(core::mem::offset_of!(ot_embedded_terminal_cursor, blinking) == 24);
    assert!(core::mem::offset_of!(ot_embedded_terminal_cursor, wide_tail) == 28);
    assert!(core::mem::offset_of!(ot_embedded_terminal_cursor, style) == 32);
    assert!(core::mem::offset_of!(ot_embedded_terminal_cursor, color_has_value) == 36);
    assert!(core::mem::offset_of!(ot_embedded_terminal_cursor, color_r) == 40);
    assert!(core::mem::offset_of!(ot_embedded_terminal_cursor, color_g) == 44);
    assert!(core::mem::offset_of!(ot_embedded_terminal_cursor, color_b) == 48);
    assert!(core::mem::offset_of!(ot_embedded_terminal_cursor, reserved) == 52);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_embedded_terminal_scrollbar {
    pub struct_size: u32,
    pub abi_version: u32,
    pub offset: u32,
    pub total: u32,
    pub visible: u32,
    pub reserved: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_embedded_terminal_scrollbar {}

impl Default for ot_embedded_terminal_scrollbar {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_embedded_terminal_scrollbar>() == 24);
    assert!(core::mem::align_of::<ot_embedded_terminal_scrollbar>() == 4);
    assert!(core::mem::offset_of!(ot_embedded_terminal_scrollbar, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_embedded_terminal_scrollbar, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_embedded_terminal_scrollbar, offset) == 8);
    assert!(core::mem::offset_of!(ot_embedded_terminal_scrollbar, total) == 12);
    assert!(core::mem::offset_of!(ot_embedded_terminal_scrollbar, visible) == 16);
    assert!(core::mem::offset_of!(ot_embedded_terminal_scrollbar, reserved) == 20);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_embedded_terminal_key {
    pub struct_size: u32,
    pub abi_version: u32,
    pub action: u32,
    pub composing: u32,
    pub mods: u32,
    pub consumed_mods: u32,
    pub unshifted_codepoint: u32,
    pub reserved: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_embedded_terminal_key {}

impl Default for ot_embedded_terminal_key {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_embedded_terminal_key>() == 32);
    assert!(core::mem::align_of::<ot_embedded_terminal_key>() == 4);
    assert!(core::mem::offset_of!(ot_embedded_terminal_key, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_embedded_terminal_key, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_embedded_terminal_key, action) == 8);
    assert!(core::mem::offset_of!(ot_embedded_terminal_key, composing) == 12);
    assert!(core::mem::offset_of!(ot_embedded_terminal_key, mods) == 16);
    assert!(core::mem::offset_of!(ot_embedded_terminal_key, consumed_mods) == 20);
    assert!(core::mem::offset_of!(ot_embedded_terminal_key, unshifted_codepoint) == 24);
    assert!(core::mem::offset_of!(ot_embedded_terminal_key, reserved) == 28);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ot_embedded_terminal_mouse {
    pub struct_size: u32,
    pub abi_version: u32,
    pub action: u32,
    pub button: i32,
    pub mods: u32,
    pub any_button_pressed: u32,
    pub x: f32,
    pub y: f32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_embedded_terminal_mouse {}

impl Default for ot_embedded_terminal_mouse {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_embedded_terminal_mouse>() == 32);
    assert!(core::mem::align_of::<ot_embedded_terminal_mouse>() == 4);
    assert!(core::mem::offset_of!(ot_embedded_terminal_mouse, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_embedded_terminal_mouse, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_embedded_terminal_mouse, action) == 8);
    assert!(core::mem::offset_of!(ot_embedded_terminal_mouse, button) == 12);
    assert!(core::mem::offset_of!(ot_embedded_terminal_mouse, mods) == 16);
    assert!(core::mem::offset_of!(ot_embedded_terminal_mouse, any_button_pressed) == 20);
    assert!(core::mem::offset_of!(ot_embedded_terminal_mouse, x) == 24);
    assert!(core::mem::offset_of!(ot_embedded_terminal_mouse, y) == 28);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_edit_buffer_options {
    pub struct_size: u32,
    pub abi_version: u32,
    pub width_method: u32,
    pub reserved: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_edit_buffer_options {}

impl Default for ot_edit_buffer_options {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_edit_buffer_options>() == 16);
    assert!(core::mem::align_of::<ot_edit_buffer_options>() == 4);
    assert!(core::mem::offset_of!(ot_edit_buffer_options, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_edit_buffer_options, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_edit_buffer_options, width_method) == 8);
    assert!(core::mem::offset_of!(ot_edit_buffer_options, reserved) == 12);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_edit_buffer_info {
    pub struct_size: u32,
    pub abi_version: u32,
    pub content_epoch: u64,
    pub byte_count: u32,
    pub line_count: u32,
    pub cursor_row: u32,
    pub cursor_col: u32,
    pub cursor_offset: u32,
    pub can_undo: u32,
    pub can_redo: u32,
    pub tab_width: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_edit_buffer_info {}

impl Default for ot_edit_buffer_info {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_edit_buffer_info>() == 48);
    assert!(core::mem::align_of::<ot_edit_buffer_info>() == 8);
    assert!(core::mem::offset_of!(ot_edit_buffer_info, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_edit_buffer_info, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_edit_buffer_info, content_epoch) == 8);
    assert!(core::mem::offset_of!(ot_edit_buffer_info, byte_count) == 16);
    assert!(core::mem::offset_of!(ot_edit_buffer_info, line_count) == 20);
    assert!(core::mem::offset_of!(ot_edit_buffer_info, cursor_row) == 24);
    assert!(core::mem::offset_of!(ot_edit_buffer_info, cursor_col) == 28);
    assert!(core::mem::offset_of!(ot_edit_buffer_info, cursor_offset) == 32);
    assert!(core::mem::offset_of!(ot_edit_buffer_info, can_undo) == 36);
    assert!(core::mem::offset_of!(ot_edit_buffer_info, can_redo) == 40);
    assert!(core::mem::offset_of!(ot_edit_buffer_info, tab_width) == 44);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_scene_editor_options {
    pub struct_size: u32,
    pub abi_version: u32,
    pub show_cursor: u32,
    pub style: u32,
    pub blinking: u32,
    pub reserved: u32,
    pub color: [u16; 4],
    pub mouse_pointer: u32,
    pub reserved2: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_scene_editor_options {}

impl Default for ot_scene_editor_options {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_scene_editor_options>() == 40);
    assert!(core::mem::align_of::<ot_scene_editor_options>() == 4);
    assert!(core::mem::offset_of!(ot_scene_editor_options, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_scene_editor_options, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_scene_editor_options, show_cursor) == 8);
    assert!(core::mem::offset_of!(ot_scene_editor_options, style) == 12);
    assert!(core::mem::offset_of!(ot_scene_editor_options, blinking) == 16);
    assert!(core::mem::offset_of!(ot_scene_editor_options, reserved) == 20);
    assert!(core::mem::offset_of!(ot_scene_editor_options, color) == 24);
    assert!(core::mem::offset_of!(ot_scene_editor_options, mouse_pointer) == 32);
    assert!(core::mem::offset_of!(ot_scene_editor_options, reserved2) == 36);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_edit_position {
    pub struct_size: u32,
    pub abi_version: u32,
    pub valid: u32,
    pub row: u32,
    pub col: u32,
    pub offset: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_edit_position {}

impl Default for ot_edit_position {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_edit_position>() == 24);
    assert!(core::mem::align_of::<ot_edit_position>() == 4);
    assert!(core::mem::offset_of!(ot_edit_position, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_edit_position, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_edit_position, valid) == 8);
    assert!(core::mem::offset_of!(ot_edit_position, row) == 12);
    assert!(core::mem::offset_of!(ot_edit_position, col) == 16);
    assert!(core::mem::offset_of!(ot_edit_position, offset) == 20);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_editor_style {
    pub struct_size: u32,
    pub abi_version: u32,
    pub flags: u32,
    pub attributes: u32,
    pub foreground: [u16; 4],
    pub background: [u16; 4],
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_editor_style {}

impl Default for ot_editor_style {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_editor_style>() == 32);
    assert!(core::mem::align_of::<ot_editor_style>() == 4);
    assert!(core::mem::offset_of!(ot_editor_style, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_editor_style, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_editor_style, flags) == 8);
    assert!(core::mem::offset_of!(ot_editor_style, attributes) == 12);
    assert!(core::mem::offset_of!(ot_editor_style, foreground) == 16);
    assert!(core::mem::offset_of!(ot_editor_style, background) == 24);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_edit_highlight {
    pub start: u32,
    pub end: u32,
    pub style_id: u32,
    pub priority: u32,
    pub r#ref: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_edit_highlight {}

impl Default for ot_edit_highlight {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        unsafe { core::mem::zeroed() }
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_edit_highlight>() == 20);
    assert!(core::mem::align_of::<ot_edit_highlight>() == 4);
    assert!(core::mem::offset_of!(ot_edit_highlight, start) == 0);
    assert!(core::mem::offset_of!(ot_edit_highlight, end) == 4);
    assert!(core::mem::offset_of!(ot_edit_highlight, style_id) == 8);
    assert!(core::mem::offset_of!(ot_edit_highlight, priority) == 12);
    assert!(core::mem::offset_of!(ot_edit_highlight, r#ref) == 16);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_highlight_run {
    pub start_byte: u32,
    pub end_byte: u32,
    pub group_set: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_highlight_run {}

impl Default for ot_highlight_run {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        unsafe { core::mem::zeroed() }
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_highlight_run>() == 12);
    assert!(core::mem::align_of::<ot_highlight_run>() == 4);
    assert!(core::mem::offset_of!(ot_highlight_run, start_byte) == 0);
    assert!(core::mem::offset_of!(ot_highlight_run, end_byte) == 4);
    assert!(core::mem::offset_of!(ot_highlight_run, group_set) == 8);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_edit_mark {
    pub struct_size: u32,
    pub abi_version: u32,
    pub id: u32,
    pub kind: u32,
    pub flags: u32,
    pub style: u32,
    pub value: ot_editor_style,
    pub priority: u32,
    pub start: u32,
    pub end: u32,
    pub start_byte: u32,
    pub end_byte: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_edit_mark {}

impl Default for ot_edit_mark {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_edit_mark>() == 76);
    assert!(core::mem::align_of::<ot_edit_mark>() == 4);
    assert!(core::mem::offset_of!(ot_edit_mark, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_edit_mark, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_edit_mark, id) == 8);
    assert!(core::mem::offset_of!(ot_edit_mark, kind) == 12);
    assert!(core::mem::offset_of!(ot_edit_mark, flags) == 16);
    assert!(core::mem::offset_of!(ot_edit_mark, style) == 20);
    assert!(core::mem::offset_of!(ot_edit_mark, value) == 24);
    assert!(core::mem::offset_of!(ot_edit_mark, priority) == 56);
    assert!(core::mem::offset_of!(ot_edit_mark, start) == 60);
    assert!(core::mem::offset_of!(ot_edit_mark, end) == 64);
    assert!(core::mem::offset_of!(ot_edit_mark, start_byte) == 68);
    assert!(core::mem::offset_of!(ot_edit_mark, end_byte) == 72);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_markdown_options {
    pub struct_size: u32,
    pub abi_version: u32,
    pub flags: u32,
    pub source_byte_limit: u32,
    pub syntax_style: ot_handle,
    pub hook_filter_byte_count: u32,
    pub reserved: u32,
    pub hook_filter: [u8; 256],
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_markdown_options {}

impl Default for ot_markdown_options {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_markdown_options>() == 296);
    assert!(core::mem::align_of::<ot_markdown_options>() == 8);
    assert!(core::mem::offset_of!(ot_markdown_options, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_markdown_options, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_markdown_options, flags) == 8);
    assert!(core::mem::offset_of!(ot_markdown_options, source_byte_limit) == 12);
    assert!(core::mem::offset_of!(ot_markdown_options, syntax_style) == 16);
    assert!(core::mem::offset_of!(ot_markdown_options, hook_filter_byte_count) == 32);
    assert!(core::mem::offset_of!(ot_markdown_options, reserved) == 36);
    assert!(core::mem::offset_of!(ot_markdown_options, hook_filter) == 40);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_markdown_result {
    pub changed_block_count: u32,
    pub committed_top_level_count: u32,
    pub removed_from_index: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_markdown_result {}

impl Default for ot_markdown_result {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        unsafe { core::mem::zeroed() }
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_markdown_result>() == 12);
    assert!(core::mem::align_of::<ot_markdown_result>() == 4);
    assert!(core::mem::offset_of!(ot_markdown_result, changed_block_count) == 0);
    assert!(core::mem::offset_of!(ot_markdown_result, committed_top_level_count) == 4);
    assert!(core::mem::offset_of!(ot_markdown_result, removed_from_index) == 8);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_markdown_block {
    pub index: u32,
    pub parent_index: u32,
    pub kind: u16,
    pub flags: u16,
    pub source_start_byte: u32,
    pub source_end_byte: u32,
    pub info_start_byte: u32,
    pub info_end_byte: u32,
    pub number: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_markdown_block {}

impl Default for ot_markdown_block {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        unsafe { core::mem::zeroed() }
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_markdown_block>() == 32);
    assert!(core::mem::align_of::<ot_markdown_block>() == 4);
    assert!(core::mem::offset_of!(ot_markdown_block, index) == 0);
    assert!(core::mem::offset_of!(ot_markdown_block, parent_index) == 4);
    assert!(core::mem::offset_of!(ot_markdown_block, kind) == 8);
    assert!(core::mem::offset_of!(ot_markdown_block, flags) == 10);
    assert!(core::mem::offset_of!(ot_markdown_block, source_start_byte) == 12);
    assert!(core::mem::offset_of!(ot_markdown_block, source_end_byte) == 16);
    assert!(core::mem::offset_of!(ot_markdown_block, info_start_byte) == 20);
    assert!(core::mem::offset_of!(ot_markdown_block, info_end_byte) == 24);
    assert!(core::mem::offset_of!(ot_markdown_block, number) == 28);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_editor_viewport {
    pub struct_size: u32,
    pub abi_version: u32,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_editor_viewport {}

impl Default for ot_editor_viewport {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_editor_viewport>() == 24);
    assert!(core::mem::align_of::<ot_editor_viewport>() == 4);
    assert!(core::mem::offset_of!(ot_editor_viewport, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_editor_viewport, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_editor_viewport, x) == 8);
    assert!(core::mem::offset_of!(ot_editor_viewport, y) == 12);
    assert!(core::mem::offset_of!(ot_editor_viewport, width) == 16);
    assert!(core::mem::offset_of!(ot_editor_viewport, height) == 20);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_editor_selection {
    pub struct_size: u32,
    pub abi_version: u32,
    pub operation: u32,
    pub behavior: u32,
    pub start: u32,
    pub end: u32,
    pub anchor_x: i32,
    pub anchor_y: i32,
    pub focus_x: i32,
    pub focus_y: i32,
    pub update_cursor: u32,
    pub follow_cursor: u32,
    pub flags: u32,
    pub reserved: u32,
    pub foreground: [u16; 4],
    pub background: [u16; 4],
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_editor_selection {}

impl Default for ot_editor_selection {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_editor_selection>() == 72);
    assert!(core::mem::align_of::<ot_editor_selection>() == 4);
    assert!(core::mem::offset_of!(ot_editor_selection, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_editor_selection, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_editor_selection, operation) == 8);
    assert!(core::mem::offset_of!(ot_editor_selection, behavior) == 12);
    assert!(core::mem::offset_of!(ot_editor_selection, start) == 16);
    assert!(core::mem::offset_of!(ot_editor_selection, end) == 20);
    assert!(core::mem::offset_of!(ot_editor_selection, anchor_x) == 24);
    assert!(core::mem::offset_of!(ot_editor_selection, anchor_y) == 28);
    assert!(core::mem::offset_of!(ot_editor_selection, focus_x) == 32);
    assert!(core::mem::offset_of!(ot_editor_selection, focus_y) == 36);
    assert!(core::mem::offset_of!(ot_editor_selection, update_cursor) == 40);
    assert!(core::mem::offset_of!(ot_editor_selection, follow_cursor) == 44);
    assert!(core::mem::offset_of!(ot_editor_selection, flags) == 48);
    assert!(core::mem::offset_of!(ot_editor_selection, reserved) == 52);
    assert!(core::mem::offset_of!(ot_editor_selection, foreground) == 56);
    assert!(core::mem::offset_of!(ot_editor_selection, background) == 64);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_editor_view_info {
    pub struct_size: u32,
    pub abi_version: u32,
    pub virtual_line_count: u32,
    pub total_virtual_line_count: u32,
    pub selection_present: u32,
    pub selection_start: u32,
    pub selection_end: u32,
    pub selection_occupancy: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_editor_view_info {}

impl Default for ot_editor_view_info {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_editor_view_info>() == 32);
    assert!(core::mem::align_of::<ot_editor_view_info>() == 4);
    assert!(core::mem::offset_of!(ot_editor_view_info, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_editor_view_info, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_editor_view_info, virtual_line_count) == 8);
    assert!(core::mem::offset_of!(ot_editor_view_info, total_virtual_line_count) == 12);
    assert!(core::mem::offset_of!(ot_editor_view_info, selection_present) == 16);
    assert!(core::mem::offset_of!(ot_editor_view_info, selection_start) == 20);
    assert!(core::mem::offset_of!(ot_editor_view_info, selection_end) == 24);
    assert!(core::mem::offset_of!(ot_editor_view_info, selection_occupancy) == 28);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_editor_position {
    pub struct_size: u32,
    pub abi_version: u32,
    pub visual_row: u32,
    pub visual_col: u32,
    pub logical_row: u32,
    pub logical_col: u32,
    pub offset: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_editor_position {}

impl Default for ot_editor_position {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_editor_position>() == 28);
    assert!(core::mem::align_of::<ot_editor_position>() == 4);
    assert!(core::mem::offset_of!(ot_editor_position, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_editor_position, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_editor_position, visual_row) == 8);
    assert!(core::mem::offset_of!(ot_editor_position, visual_col) == 12);
    assert!(core::mem::offset_of!(ot_editor_position, logical_row) == 16);
    assert!(core::mem::offset_of!(ot_editor_position, logical_col) == 20);
    assert!(core::mem::offset_of!(ot_editor_position, offset) == 24);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_editor_measure {
    pub struct_size: u32,
    pub abi_version: u32,
    pub line_count: u32,
    pub width_cols_max: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_editor_measure {}

impl Default for ot_editor_measure {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_editor_measure>() == 16);
    assert!(core::mem::align_of::<ot_editor_measure>() == 4);
    assert!(core::mem::offset_of!(ot_editor_measure, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_editor_measure, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_editor_measure, line_count) == 8);
    assert!(core::mem::offset_of!(ot_editor_measure, width_cols_max) == 12);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_image_info {
    pub width: u32,
    pub height: u32,
    pub source_width: u32,
    pub source_height: u32,
    pub format: u32,
    pub color_status: u32,
    pub orientation: u32,
    pub has_alpha: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_image_info {}

impl Default for ot_image_info {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        unsafe { core::mem::zeroed() }
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_image_info>() == 32);
    assert!(core::mem::align_of::<ot_image_info>() == 4);
    assert!(core::mem::offset_of!(ot_image_info, width) == 0);
    assert!(core::mem::offset_of!(ot_image_info, height) == 4);
    assert!(core::mem::offset_of!(ot_image_info, source_width) == 8);
    assert!(core::mem::offset_of!(ot_image_info, source_height) == 12);
    assert!(core::mem::offset_of!(ot_image_info, format) == 16);
    assert!(core::mem::offset_of!(ot_image_info, color_status) == 20);
    assert!(core::mem::offset_of!(ot_image_info, orientation) == 24);
    assert!(core::mem::offset_of!(ot_image_info, has_alpha) == 28);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_image_pixels {
    pub lease: ot_handle,
    pub pixels: u64,
    pub byte_count: u64,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_image_pixels {}

impl Default for ot_image_pixels {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        unsafe { core::mem::zeroed() }
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_image_pixels>() == 32);
    assert!(core::mem::align_of::<ot_image_pixels>() == 8);
    assert!(core::mem::offset_of!(ot_image_pixels, lease) == 0);
    assert!(core::mem::offset_of!(ot_image_pixels, pixels) == 16);
    assert!(core::mem::offset_of!(ot_image_pixels, byte_count) == 24);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_video_info {
    pub duration_us: i64,
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    pub has_audio: u32,
    pub reserved: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_video_info {}

impl Default for ot_video_info {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        unsafe { core::mem::zeroed() }
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_video_info>() == 32);
    assert!(core::mem::align_of::<ot_video_info>() == 8);
    assert!(core::mem::offset_of!(ot_video_info, duration_us) == 0);
    assert!(core::mem::offset_of!(ot_video_info, width) == 8);
    assert!(core::mem::offset_of!(ot_video_info, height) == 12);
    assert!(core::mem::offset_of!(ot_video_info, fps_num) == 16);
    assert!(core::mem::offset_of!(ot_video_info, fps_den) == 20);
    assert!(core::mem::offset_of!(ot_video_info, has_audio) == 24);
    assert!(core::mem::offset_of!(ot_video_info, reserved) == 28);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_video_state {
    pub current_time_us: i64,
    pub frame_pts_us: i64,
    pub flags: u32,
    pub quality_tier: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_video_state {}

impl Default for ot_video_state {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        unsafe { core::mem::zeroed() }
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_video_state>() == 24);
    assert!(core::mem::align_of::<ot_video_state>() == 8);
    assert!(core::mem::offset_of!(ot_video_state, current_time_us) == 0);
    assert!(core::mem::offset_of!(ot_video_state, frame_pts_us) == 8);
    assert!(core::mem::offset_of!(ot_video_state, flags) == 16);
    assert!(core::mem::offset_of!(ot_video_state, quality_tier) == 20);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_image_draw_options {
    pub struct_size: u32,
    pub abi_version: u32,
    pub flags: u32,
    pub protocol: u32,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub pixel_width: u32,
    pub pixel_height: u32,
    pub source_x: u32,
    pub source_y: u32,
    pub source_width: u32,
    pub source_height: u32,
    pub reserved: [u32; 2],
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_image_draw_options {}

impl Default for ot_image_draw_options {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_image_draw_options>() == 64);
    assert!(core::mem::align_of::<ot_image_draw_options>() == 4);
    assert!(core::mem::offset_of!(ot_image_draw_options, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_image_draw_options, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_image_draw_options, flags) == 8);
    assert!(core::mem::offset_of!(ot_image_draw_options, protocol) == 12);
    assert!(core::mem::offset_of!(ot_image_draw_options, x) == 16);
    assert!(core::mem::offset_of!(ot_image_draw_options, y) == 20);
    assert!(core::mem::offset_of!(ot_image_draw_options, width) == 24);
    assert!(core::mem::offset_of!(ot_image_draw_options, height) == 28);
    assert!(core::mem::offset_of!(ot_image_draw_options, pixel_width) == 32);
    assert!(core::mem::offset_of!(ot_image_draw_options, pixel_height) == 36);
    assert!(core::mem::offset_of!(ot_image_draw_options, source_x) == 40);
    assert!(core::mem::offset_of!(ot_image_draw_options, source_y) == 44);
    assert!(core::mem::offset_of!(ot_image_draw_options, source_width) == 48);
    assert!(core::mem::offset_of!(ot_image_draw_options, source_height) == 52);
    assert!(core::mem::offset_of!(ot_image_draw_options, reserved) == 56);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_session_kitty_image_transport {
    pub struct_size: u32,
    pub abi_version: u32,
    pub requested: u32,
    pub effective: u32,
    pub file_state: u32,
    pub fallback: u32,
    pub pending_files: u32,
    pub pending_bytes: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_session_kitty_image_transport {}

impl Default for ot_session_kitty_image_transport {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_session_kitty_image_transport>() == 32);
    assert!(core::mem::align_of::<ot_session_kitty_image_transport>() == 4);
    assert!(core::mem::offset_of!(ot_session_kitty_image_transport, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_session_kitty_image_transport, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_session_kitty_image_transport, requested) == 8);
    assert!(core::mem::offset_of!(ot_session_kitty_image_transport, effective) == 12);
    assert!(core::mem::offset_of!(ot_session_kitty_image_transport, file_state) == 16);
    assert!(core::mem::offset_of!(ot_session_kitty_image_transport, fallback) == 20);
    assert!(core::mem::offset_of!(ot_session_kitty_image_transport, pending_files) == 24);
    assert!(core::mem::offset_of!(ot_session_kitty_image_transport, pending_bytes) == 28);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_text_buffer_info {
    pub struct_size: u32,
    pub abi_version: u32,
    pub content_epoch: u64,
    pub byte_count: u32,
    pub text_length: u32,
    pub line_count: u32,
    pub highlight_count: u32,
    pub tab_width: u32,
    pub reserved: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_text_buffer_info {}

impl Default for ot_text_buffer_info {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_text_buffer_info>() == 40);
    assert!(core::mem::align_of::<ot_text_buffer_info>() == 8);
    assert!(core::mem::offset_of!(ot_text_buffer_info, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_text_buffer_info, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_text_buffer_info, content_epoch) == 8);
    assert!(core::mem::offset_of!(ot_text_buffer_info, byte_count) == 16);
    assert!(core::mem::offset_of!(ot_text_buffer_info, text_length) == 20);
    assert!(core::mem::offset_of!(ot_text_buffer_info, line_count) == 24);
    assert!(core::mem::offset_of!(ot_text_buffer_info, highlight_count) == 28);
    assert!(core::mem::offset_of!(ot_text_buffer_info, tab_width) == 32);
    assert!(core::mem::offset_of!(ot_text_buffer_info, reserved) == 36);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_text_buffer_replacement {
    pub struct_size: u32,
    pub abi_version: u32,
    pub buffer: ot_handle,
    pub view: ot_handle,
    pub byte_offset: u32,
    pub byte_count: u32,
    pub chunk_offset: u32,
    pub chunk_count: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_text_buffer_replacement {}

impl Default for ot_text_buffer_replacement {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_text_buffer_replacement>() == 56);
    assert!(core::mem::align_of::<ot_text_buffer_replacement>() == 8);
    assert!(core::mem::offset_of!(ot_text_buffer_replacement, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_text_buffer_replacement, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_text_buffer_replacement, buffer) == 8);
    assert!(core::mem::offset_of!(ot_text_buffer_replacement, view) == 24);
    assert!(core::mem::offset_of!(ot_text_buffer_replacement, byte_offset) == 40);
    assert!(core::mem::offset_of!(ot_text_buffer_replacement, byte_count) == 44);
    assert!(core::mem::offset_of!(ot_text_buffer_replacement, chunk_offset) == 48);
    assert!(core::mem::offset_of!(ot_text_buffer_replacement, chunk_count) == 52);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_text_buffer_replacement_info {
    pub text_length: u32,
    pub byte_count: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_text_buffer_replacement_info {}

impl Default for ot_text_buffer_replacement_info {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        unsafe { core::mem::zeroed() }
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_text_buffer_replacement_info>() == 8);
    assert!(core::mem::align_of::<ot_text_buffer_replacement_info>() == 4);
    assert!(core::mem::offset_of!(ot_text_buffer_replacement_info, text_length) == 0);
    assert!(core::mem::offset_of!(ot_text_buffer_replacement_info, byte_count) == 4);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_buffer_draw_header {
    pub struct_size: u32,
    pub abi_version: u32,
    pub operation: u32,
    pub flags: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_buffer_draw_header {}

impl Default for ot_buffer_draw_header {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_buffer_draw_header>() == 16);
    assert!(core::mem::align_of::<ot_buffer_draw_header>() == 4);
    assert!(core::mem::offset_of!(ot_buffer_draw_header, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_buffer_draw_header, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_buffer_draw_header, operation) == 8);
    assert!(core::mem::offset_of!(ot_buffer_draw_header, flags) == 12);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_buffer_draw_clear {
    pub header: ot_buffer_draw_header,
    pub background: [u16; 4],
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_buffer_draw_clear {}

impl Default for ot_buffer_draw_clear {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.header.struct_size = core::mem::size_of::<Self>() as u32;
        value.header.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_buffer_draw_clear>() == 24);
    assert!(core::mem::align_of::<ot_buffer_draw_clear>() == 4);
    assert!(core::mem::offset_of!(ot_buffer_draw_clear, header) == 0);
    assert!(core::mem::offset_of!(ot_buffer_draw_clear, background) == 16);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_buffer_draw_fill {
    pub header: ot_buffer_draw_header,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub background: [u16; 4],
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_buffer_draw_fill {}

impl Default for ot_buffer_draw_fill {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.header.struct_size = core::mem::size_of::<Self>() as u32;
        value.header.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_buffer_draw_fill>() == 40);
    assert!(core::mem::align_of::<ot_buffer_draw_fill>() == 4);
    assert!(core::mem::offset_of!(ot_buffer_draw_fill, header) == 0);
    assert!(core::mem::offset_of!(ot_buffer_draw_fill, x) == 16);
    assert!(core::mem::offset_of!(ot_buffer_draw_fill, y) == 20);
    assert!(core::mem::offset_of!(ot_buffer_draw_fill, width) == 24);
    assert!(core::mem::offset_of!(ot_buffer_draw_fill, height) == 28);
    assert!(core::mem::offset_of!(ot_buffer_draw_fill, background) == 32);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_buffer_draw_text_record {
    pub header: ot_buffer_draw_header,
    pub x: i32,
    pub y: i32,
    pub attributes: u32,
    pub foreground: [u16; 4],
    pub background: [u16; 4],
    pub max_width: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_buffer_draw_text_record {}

impl Default for ot_buffer_draw_text_record {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.header.struct_size = core::mem::size_of::<Self>() as u32;
        value.header.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_buffer_draw_text_record>() == 48);
    assert!(core::mem::align_of::<ot_buffer_draw_text_record>() == 4);
    assert!(core::mem::offset_of!(ot_buffer_draw_text_record, header) == 0);
    assert!(core::mem::offset_of!(ot_buffer_draw_text_record, x) == 16);
    assert!(core::mem::offset_of!(ot_buffer_draw_text_record, y) == 20);
    assert!(core::mem::offset_of!(ot_buffer_draw_text_record, attributes) == 24);
    assert!(core::mem::offset_of!(ot_buffer_draw_text_record, foreground) == 28);
    assert!(core::mem::offset_of!(ot_buffer_draw_text_record, background) == 36);
    assert!(core::mem::offset_of!(ot_buffer_draw_text_record, max_width) == 44);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_buffer_draw_cell {
    pub header: ot_buffer_draw_header,
    pub x: i32,
    pub y: i32,
    pub character: u32,
    pub attributes: u32,
    pub foreground: [u16; 4],
    pub background: [u16; 4],
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_buffer_draw_cell {}

impl Default for ot_buffer_draw_cell {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.header.struct_size = core::mem::size_of::<Self>() as u32;
        value.header.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_buffer_draw_cell>() == 48);
    assert!(core::mem::align_of::<ot_buffer_draw_cell>() == 4);
    assert!(core::mem::offset_of!(ot_buffer_draw_cell, header) == 0);
    assert!(core::mem::offset_of!(ot_buffer_draw_cell, x) == 16);
    assert!(core::mem::offset_of!(ot_buffer_draw_cell, y) == 20);
    assert!(core::mem::offset_of!(ot_buffer_draw_cell, character) == 24);
    assert!(core::mem::offset_of!(ot_buffer_draw_cell, attributes) == 28);
    assert!(core::mem::offset_of!(ot_buffer_draw_cell, foreground) == 32);
    assert!(core::mem::offset_of!(ot_buffer_draw_cell, background) == 40);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_buffer_draw_box {
    pub header: ot_buffer_draw_header,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub packed_options: u32,
    pub foreground: [u16; 4],
    pub background: [u16; 4],
    pub title_color: [u16; 4],
    pub border_chars: [u32; 11],
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_buffer_draw_box {}

impl Default for ot_buffer_draw_box {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.header.struct_size = core::mem::size_of::<Self>() as u32;
        value.header.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_buffer_draw_box>() == 104);
    assert!(core::mem::align_of::<ot_buffer_draw_box>() == 4);
    assert!(core::mem::offset_of!(ot_buffer_draw_box, header) == 0);
    assert!(core::mem::offset_of!(ot_buffer_draw_box, x) == 16);
    assert!(core::mem::offset_of!(ot_buffer_draw_box, y) == 20);
    assert!(core::mem::offset_of!(ot_buffer_draw_box, width) == 24);
    assert!(core::mem::offset_of!(ot_buffer_draw_box, height) == 28);
    assert!(core::mem::offset_of!(ot_buffer_draw_box, packed_options) == 32);
    assert!(core::mem::offset_of!(ot_buffer_draw_box, foreground) == 36);
    assert!(core::mem::offset_of!(ot_buffer_draw_box, background) == 44);
    assert!(core::mem::offset_of!(ot_buffer_draw_box, title_color) == 52);
    assert!(core::mem::offset_of!(ot_buffer_draw_box, border_chars) == 60);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_buffer_draw_compose {
    pub header: ot_buffer_draw_header,
    pub x: i32,
    pub y: i32,
    pub source_x: u32,
    pub source_y: u32,
    pub source_width: u32,
    pub source_height: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_buffer_draw_compose {}

impl Default for ot_buffer_draw_compose {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.header.struct_size = core::mem::size_of::<Self>() as u32;
        value.header.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_buffer_draw_compose>() == 40);
    assert!(core::mem::align_of::<ot_buffer_draw_compose>() == 4);
    assert!(core::mem::offset_of!(ot_buffer_draw_compose, header) == 0);
    assert!(core::mem::offset_of!(ot_buffer_draw_compose, x) == 16);
    assert!(core::mem::offset_of!(ot_buffer_draw_compose, y) == 20);
    assert!(core::mem::offset_of!(ot_buffer_draw_compose, source_x) == 24);
    assert!(core::mem::offset_of!(ot_buffer_draw_compose, source_y) == 28);
    assert!(core::mem::offset_of!(ot_buffer_draw_compose, source_width) == 32);
    assert!(core::mem::offset_of!(ot_buffer_draw_compose, source_height) == 36);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_buffer_draw_alpha {
    pub header: ot_buffer_draw_header,
    pub enabled: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_buffer_draw_alpha {}

impl Default for ot_buffer_draw_alpha {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.header.struct_size = core::mem::size_of::<Self>() as u32;
        value.header.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_buffer_draw_alpha>() == 20);
    assert!(core::mem::align_of::<ot_buffer_draw_alpha>() == 4);
    assert!(core::mem::offset_of!(ot_buffer_draw_alpha, header) == 0);
    assert!(core::mem::offset_of!(ot_buffer_draw_alpha, enabled) == 16);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_buffer_grid_options {
    pub struct_size: u32,
    pub abi_version: u32,
    pub flags: u32,
    pub reserved: u32,
    pub foreground: [u16; 4],
    pub background: [u16; 4],
    pub border_chars: [u32; 11],
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_buffer_grid_options {}

impl Default for ot_buffer_grid_options {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_buffer_grid_options>() == 76);
    assert!(core::mem::align_of::<ot_buffer_grid_options>() == 4);
    assert!(core::mem::offset_of!(ot_buffer_grid_options, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_buffer_grid_options, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_buffer_grid_options, flags) == 8);
    assert!(core::mem::offset_of!(ot_buffer_grid_options, reserved) == 12);
    assert!(core::mem::offset_of!(ot_buffer_grid_options, foreground) == 16);
    assert!(core::mem::offset_of!(ot_buffer_grid_options, background) == 24);
    assert!(core::mem::offset_of!(ot_buffer_grid_options, border_chars) == 32);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_buffer_lease_snapshot {
    pub struct_size: u32,
    pub abi_version: u32,
    pub lease: ot_handle,
    pub width: u32,
    pub height: u32,
    pub generation: u64,
    pub char_ptr: u64,
    pub fg_ptr: u64,
    pub bg_ptr: u64,
    pub attributes_ptr: u64,
    pub reserved: u64,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_buffer_lease_snapshot {}

impl Default for ot_buffer_lease_snapshot {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_buffer_lease_snapshot>() == 80);
    assert!(core::mem::align_of::<ot_buffer_lease_snapshot>() == 8);
    assert!(core::mem::offset_of!(ot_buffer_lease_snapshot, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_buffer_lease_snapshot, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_buffer_lease_snapshot, lease) == 8);
    assert!(core::mem::offset_of!(ot_buffer_lease_snapshot, width) == 24);
    assert!(core::mem::offset_of!(ot_buffer_lease_snapshot, height) == 28);
    assert!(core::mem::offset_of!(ot_buffer_lease_snapshot, generation) == 32);
    assert!(core::mem::offset_of!(ot_buffer_lease_snapshot, char_ptr) == 40);
    assert!(core::mem::offset_of!(ot_buffer_lease_snapshot, fg_ptr) == 48);
    assert!(core::mem::offset_of!(ot_buffer_lease_snapshot, bg_ptr) == 56);
    assert!(core::mem::offset_of!(ot_buffer_lease_snapshot, attributes_ptr) == 64);
    assert!(core::mem::offset_of!(ot_buffer_lease_snapshot, reserved) == 72);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_session_terminal_options {
    pub struct_size: u32,
    pub abi_version: u32,
    pub flags: u32,
    pub kitty_keyboard_flags: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_session_terminal_options {}

impl Default for ot_session_terminal_options {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_session_terminal_options>() == 16);
    assert!(core::mem::align_of::<ot_session_terminal_options>() == 4);
    assert!(core::mem::offset_of!(ot_session_terminal_options, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_session_terminal_options, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_session_terminal_options, flags) == 8);
    assert!(core::mem::offset_of!(ot_session_terminal_options, kitty_keyboard_flags) == 12);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_session_control_options {
    pub struct_size: u32,
    pub abi_version: u32,
    pub kind: u32,
    pub argument: u32,
    pub reserved: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_session_control_options {}

impl Default for ot_session_control_options {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_session_control_options>() == 20);
    assert!(core::mem::align_of::<ot_session_control_options>() == 4);
    assert!(core::mem::offset_of!(ot_session_control_options, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_session_control_options, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_session_control_options, kind) == 8);
    assert!(core::mem::offset_of!(ot_session_control_options, argument) == 12);
    assert!(core::mem::offset_of!(ot_session_control_options, reserved) == 16);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_session_cursor_update {
    pub fields: u32,
    pub x: i32,
    pub y: i32,
    pub visible: u8,
    pub style: u8,
    pub blinking: u8,
    pub mouse_pointer: u8,
    pub color: [u16; 4],
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_session_cursor_update {}

impl Default for ot_session_cursor_update {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        unsafe { core::mem::zeroed() }
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_session_cursor_update>() == 24);
    assert!(core::mem::align_of::<ot_session_cursor_update>() == 4);
    assert!(core::mem::offset_of!(ot_session_cursor_update, fields) == 0);
    assert!(core::mem::offset_of!(ot_session_cursor_update, x) == 4);
    assert!(core::mem::offset_of!(ot_session_cursor_update, y) == 8);
    assert!(core::mem::offset_of!(ot_session_cursor_update, visible) == 12);
    assert!(core::mem::offset_of!(ot_session_cursor_update, style) == 13);
    assert!(core::mem::offset_of!(ot_session_cursor_update, blinking) == 14);
    assert!(core::mem::offset_of!(ot_session_cursor_update, mouse_pointer) == 15);
    assert!(core::mem::offset_of!(ot_session_cursor_update, color) == 16);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_session_program_status {
    pub state: u32,
    pub kind: u32,
    pub fields: u32,
    pub progress: u32,
    pub id_len: u32,
    pub app_len: u32,
    pub title_len: u32,
    pub message_len: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_session_program_status {}

impl Default for ot_session_program_status {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        unsafe { core::mem::zeroed() }
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_session_program_status>() == 32);
    assert!(core::mem::align_of::<ot_session_program_status>() == 4);
    assert!(core::mem::offset_of!(ot_session_program_status, state) == 0);
    assert!(core::mem::offset_of!(ot_session_program_status, kind) == 4);
    assert!(core::mem::offset_of!(ot_session_program_status, fields) == 8);
    assert!(core::mem::offset_of!(ot_session_program_status, progress) == 12);
    assert!(core::mem::offset_of!(ot_session_program_status, id_len) == 16);
    assert!(core::mem::offset_of!(ot_session_program_status, app_len) == 20);
    assert!(core::mem::offset_of!(ot_session_program_status, title_len) == 24);
    assert!(core::mem::offset_of!(ot_session_program_status, message_len) == 28);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_session_capabilities {
    pub struct_size: u32,
    pub abi_version: u32,
    pub flags: u32,
    pub width_method: u32,
    pub multiplexer: u32,
    pub image_protocol: u32,
    pub osc52_support: u32,
    pub kitty_keyboard_flags: u32,
    pub term_name_len: u32,
    pub term_version_len: u32,
    pub term_from_xtversion: u32,
    pub reserved: u32,
    pub term_name: [u8; 64],
    pub term_version: [u8; 32],
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_session_capabilities {}

impl Default for ot_session_capabilities {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_session_capabilities>() == 144);
    assert!(core::mem::align_of::<ot_session_capabilities>() == 4);
    assert!(core::mem::offset_of!(ot_session_capabilities, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_session_capabilities, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_session_capabilities, flags) == 8);
    assert!(core::mem::offset_of!(ot_session_capabilities, width_method) == 12);
    assert!(core::mem::offset_of!(ot_session_capabilities, multiplexer) == 16);
    assert!(core::mem::offset_of!(ot_session_capabilities, image_protocol) == 20);
    assert!(core::mem::offset_of!(ot_session_capabilities, osc52_support) == 24);
    assert!(core::mem::offset_of!(ot_session_capabilities, kitty_keyboard_flags) == 28);
    assert!(core::mem::offset_of!(ot_session_capabilities, term_name_len) == 32);
    assert!(core::mem::offset_of!(ot_session_capabilities, term_version_len) == 36);
    assert!(core::mem::offset_of!(ot_session_capabilities, term_from_xtversion) == 40);
    assert!(core::mem::offset_of!(ot_session_capabilities, reserved) == 44);
    assert!(core::mem::offset_of!(ot_session_capabilities, term_name) == 48);
    assert!(core::mem::offset_of!(ot_session_capabilities, term_version) == 112);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_session_pump_result {
    pub struct_size: u32,
    pub abi_version: u32,
    pub status: u32,
    pub reserved: u32,
    pub deadline_ns: u64,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_session_pump_result {}

impl Default for ot_session_pump_result {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_session_pump_result>() == 24);
    assert!(core::mem::align_of::<ot_session_pump_result>() == 8);
    assert!(core::mem::offset_of!(ot_session_pump_result, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_session_pump_result, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_session_pump_result, status) == 8);
    assert!(core::mem::offset_of!(ot_session_pump_result, reserved) == 12);
    assert!(core::mem::offset_of!(ot_session_pump_result, deadline_ns) == 16);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_input_event {
    pub kind: u8,
    pub action: u8,
    pub modifiers: u8,
    pub flags: u8,
    pub code: u32,
    pub base_code: u32,
    pub x: u16,
    pub y: u16,
    pub raw_offset: u32,
    pub raw_len: u32,
    pub text_offset: u32,
    pub text_len: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_input_event {}

impl Default for ot_input_event {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        unsafe { core::mem::zeroed() }
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_input_event>() == 32);
    assert!(core::mem::align_of::<ot_input_event>() == 4);
    assert!(core::mem::offset_of!(ot_input_event, kind) == 0);
    assert!(core::mem::offset_of!(ot_input_event, action) == 1);
    assert!(core::mem::offset_of!(ot_input_event, modifiers) == 2);
    assert!(core::mem::offset_of!(ot_input_event, flags) == 3);
    assert!(core::mem::offset_of!(ot_input_event, code) == 4);
    assert!(core::mem::offset_of!(ot_input_event, base_code) == 8);
    assert!(core::mem::offset_of!(ot_input_event, x) == 12);
    assert!(core::mem::offset_of!(ot_input_event, y) == 14);
    assert!(core::mem::offset_of!(ot_input_event, raw_offset) == 16);
    assert!(core::mem::offset_of!(ot_input_event, raw_len) == 20);
    assert!(core::mem::offset_of!(ot_input_event, text_offset) == 24);
    assert!(core::mem::offset_of!(ot_input_event, text_len) == 28);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_input_drain {
    pub struct_size: u32,
    pub abi_version: u32,
    pub consumed: u32,
    pub count: u32,
    pub payload_len: u32,
    pub discarded: u32,
    pub deadline_ns: u64,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_input_drain {}

impl Default for ot_input_drain {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_input_drain>() == 32);
    assert!(core::mem::align_of::<ot_input_drain>() == 8);
    assert!(core::mem::offset_of!(ot_input_drain, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_input_drain, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_input_drain, consumed) == 8);
    assert!(core::mem::offset_of!(ot_input_drain, count) == 12);
    assert!(core::mem::offset_of!(ot_input_drain, payload_len) == 16);
    assert!(core::mem::offset_of!(ot_input_drain, discarded) == 20);
    assert!(core::mem::offset_of!(ot_input_drain, deadline_ns) == 24);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_context_options {
    pub struct_size: u32,
    pub abi_version: u32,
    pub flags: u32,
    pub object_capacity: u32,
    pub render_cells_max: u32,
    pub reserved: [u32; 3],
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_context_options {}

impl Default for ot_context_options {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_context_options>() == 32);
    assert!(core::mem::align_of::<ot_context_options>() == 4);
    assert!(core::mem::offset_of!(ot_context_options, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_context_options, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_context_options, flags) == 8);
    assert!(core::mem::offset_of!(ot_context_options, object_capacity) == 12);
    assert!(core::mem::offset_of!(ot_context_options, render_cells_max) == 16);
    assert!(core::mem::offset_of!(ot_context_options, reserved) == 20);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_context_error {
    pub struct_size: u32,
    pub abi_version: u32,
    pub status: i32,
    pub reserved: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_context_error {}

impl Default for ot_context_error {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_context_error>() == 16);
    assert!(core::mem::align_of::<ot_context_error>() == 4);
    assert!(core::mem::offset_of!(ot_context_error, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_context_error, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_context_error, status) == 8);
    assert!(core::mem::offset_of!(ot_context_error, reserved) == 12);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_diagnostic {
    pub level: u32,
    pub message_len: u32,
    pub flags: u32,
    pub reserved: u32,
    pub message: [u8; 4096],
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_diagnostic {}

impl Default for ot_diagnostic {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        unsafe { core::mem::zeroed() }
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_diagnostic>() == 4112);
    assert!(core::mem::align_of::<ot_diagnostic>() == 4);
    assert!(core::mem::offset_of!(ot_diagnostic, level) == 0);
    assert!(core::mem::offset_of!(ot_diagnostic, message_len) == 4);
    assert!(core::mem::offset_of!(ot_diagnostic, flags) == 8);
    assert!(core::mem::offset_of!(ot_diagnostic, reserved) == 12);
    assert!(core::mem::offset_of!(ot_diagnostic, message) == 16);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_diagnostic_drain {
    pub struct_size: u32,
    pub abi_version: u32,
    pub count: u32,
    pub remaining: u32,
    pub dropped: u64,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_diagnostic_drain {}

impl Default for ot_diagnostic_drain {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        let mut value: Self = unsafe { core::mem::zeroed() };
        value.struct_size = core::mem::size_of::<Self>() as u32;
        value.abi_version = OT_CONTEXT_ABI_VERSION;
        value
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_diagnostic_drain>() == 24);
    assert!(core::mem::align_of::<ot_diagnostic_drain>() == 8);
    assert!(core::mem::offset_of!(ot_diagnostic_drain, struct_size) == 0);
    assert!(core::mem::offset_of!(ot_diagnostic_drain, abi_version) == 4);
    assert!(core::mem::offset_of!(ot_diagnostic_drain, count) == 8);
    assert!(core::mem::offset_of!(ot_diagnostic_drain, remaining) == 12);
    assert!(core::mem::offset_of!(ot_diagnostic_drain, dropped) == 16);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_scene_record_header {
    pub size: u32,
    pub operation: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_scene_record_header {}

impl Default for ot_scene_record_header {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        unsafe { core::mem::zeroed() }
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_scene_record_header>() == 8);
    assert!(core::mem::align_of::<ot_scene_record_header>() == 4);
    assert!(core::mem::offset_of!(ot_scene_record_header, size) == 0);
    assert!(core::mem::offset_of!(ot_scene_record_header, operation) == 4);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_scene_record_slot {
    pub header: ot_scene_record_header,
    pub slot: u32,
    pub phase: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_scene_record_slot {}

impl Default for ot_scene_record_slot {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        unsafe { core::mem::zeroed() }
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_scene_record_slot>() == 16);
    assert!(core::mem::align_of::<ot_scene_record_slot>() == 4);
    assert!(core::mem::offset_of!(ot_scene_record_slot, header) == 0);
    assert!(core::mem::offset_of!(ot_scene_record_slot, slot) == 8);
    assert!(core::mem::offset_of!(ot_scene_record_slot, phase) == 12);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_scene_record_draw {
    pub header: ot_scene_record_header,
    pub source: ot_handle,
    pub text_length: u32,
    pub bottom_length: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_scene_record_draw {}

impl Default for ot_scene_record_draw {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        unsafe { core::mem::zeroed() }
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_scene_record_draw>() == 32);
    assert!(core::mem::align_of::<ot_scene_record_draw>() == 8);
    assert!(core::mem::offset_of!(ot_scene_record_draw, header) == 0);
    assert!(core::mem::offset_of!(ot_scene_record_draw, source) == 8);
    assert!(core::mem::offset_of!(ot_scene_record_draw, text_length) == 24);
    assert!(core::mem::offset_of!(ot_scene_record_draw, bottom_length) == 28);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ot_scene_record_stack {
    pub header: ot_scene_record_header,
    pub operation: u32,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub opacity: f32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_scene_record_stack {}

impl Default for ot_scene_record_stack {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        unsafe { core::mem::zeroed() }
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_scene_record_stack>() == 32);
    assert!(core::mem::align_of::<ot_scene_record_stack>() == 4);
    assert!(core::mem::offset_of!(ot_scene_record_stack, header) == 0);
    assert!(core::mem::offset_of!(ot_scene_record_stack, operation) == 8);
    assert!(core::mem::offset_of!(ot_scene_record_stack, x) == 12);
    assert!(core::mem::offset_of!(ot_scene_record_stack, y) == 16);
    assert!(core::mem::offset_of!(ot_scene_record_stack, width) == 20);
    assert!(core::mem::offset_of!(ot_scene_record_stack, height) == 24);
    assert!(core::mem::offset_of!(ot_scene_record_stack, opacity) == 28);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_scene_record_grid {
    pub header: ot_scene_record_header,
    pub options: ot_buffer_grid_options,
    pub column_count: u32,
    pub row_count: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_scene_record_grid {}

impl Default for ot_scene_record_grid {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        unsafe { core::mem::zeroed() }
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_scene_record_grid>() == 92);
    assert!(core::mem::align_of::<ot_scene_record_grid>() == 4);
    assert!(core::mem::offset_of!(ot_scene_record_grid, header) == 0);
    assert!(core::mem::offset_of!(ot_scene_record_grid, options) == 8);
    assert!(core::mem::offset_of!(ot_scene_record_grid, column_count) == 84);
    assert!(core::mem::offset_of!(ot_scene_record_grid, row_count) == 88);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_scene_record_packed {
    pub header: ot_scene_record_header,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub byte_count: u32,
    pub reserved: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_scene_record_packed {}

impl Default for ot_scene_record_packed {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        unsafe { core::mem::zeroed() }
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_scene_record_packed>() == 32);
    assert!(core::mem::align_of::<ot_scene_record_packed>() == 4);
    assert!(core::mem::offset_of!(ot_scene_record_packed, header) == 0);
    assert!(core::mem::offset_of!(ot_scene_record_packed, x) == 8);
    assert!(core::mem::offset_of!(ot_scene_record_packed, y) == 12);
    assert!(core::mem::offset_of!(ot_scene_record_packed, width) == 16);
    assert!(core::mem::offset_of!(ot_scene_record_packed, height) == 20);
    assert!(core::mem::offset_of!(ot_scene_record_packed, byte_count) == 24);
    assert!(core::mem::offset_of!(ot_scene_record_packed, reserved) == 28);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_scene_record_supersample {
    pub header: ot_scene_record_header,
    pub x: i32,
    pub y: i32,
    pub format: u32,
    pub stride: u32,
    pub byte_count: u32,
    pub reserved: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_scene_record_supersample {}

impl Default for ot_scene_record_supersample {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        unsafe { core::mem::zeroed() }
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_scene_record_supersample>() == 32);
    assert!(core::mem::align_of::<ot_scene_record_supersample>() == 4);
    assert!(core::mem::offset_of!(ot_scene_record_supersample, header) == 0);
    assert!(core::mem::offset_of!(ot_scene_record_supersample, x) == 8);
    assert!(core::mem::offset_of!(ot_scene_record_supersample, y) == 12);
    assert!(core::mem::offset_of!(ot_scene_record_supersample, format) == 16);
    assert!(core::mem::offset_of!(ot_scene_record_supersample, stride) == 20);
    assert!(core::mem::offset_of!(ot_scene_record_supersample, byte_count) == 24);
    assert!(core::mem::offset_of!(ot_scene_record_supersample, reserved) == 28);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_scene_record_grayscale {
    pub header: ot_scene_record_header,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub flags: u32,
    pub sample_count: u32,
    pub foreground: [u16; 4],
    pub background: [u16; 4],
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_scene_record_grayscale {}

impl Default for ot_scene_record_grayscale {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        unsafe { core::mem::zeroed() }
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_scene_record_grayscale>() == 48);
    assert!(core::mem::align_of::<ot_scene_record_grayscale>() == 4);
    assert!(core::mem::offset_of!(ot_scene_record_grayscale, header) == 0);
    assert!(core::mem::offset_of!(ot_scene_record_grayscale, x) == 8);
    assert!(core::mem::offset_of!(ot_scene_record_grayscale, y) == 12);
    assert!(core::mem::offset_of!(ot_scene_record_grayscale, width) == 16);
    assert!(core::mem::offset_of!(ot_scene_record_grayscale, height) == 20);
    assert!(core::mem::offset_of!(ot_scene_record_grayscale, flags) == 24);
    assert!(core::mem::offset_of!(ot_scene_record_grayscale, sample_count) == 28);
    assert!(core::mem::offset_of!(ot_scene_record_grayscale, foreground) == 32);
    assert!(core::mem::offset_of!(ot_scene_record_grayscale, background) == 40);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ot_scene_record_color_matrix {
    pub header: ot_scene_record_header,
    pub matrix: [f32; 16],
    pub strength: f32,
    pub channel: u32,
    pub has_mask: u32,
    pub mask_count: u32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_scene_record_color_matrix {}

impl Default for ot_scene_record_color_matrix {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        unsafe { core::mem::zeroed() }
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_scene_record_color_matrix>() == 88);
    assert!(core::mem::align_of::<ot_scene_record_color_matrix>() == 4);
    assert!(core::mem::offset_of!(ot_scene_record_color_matrix, header) == 0);
    assert!(core::mem::offset_of!(ot_scene_record_color_matrix, matrix) == 8);
    assert!(core::mem::offset_of!(ot_scene_record_color_matrix, strength) == 72);
    assert!(core::mem::offset_of!(ot_scene_record_color_matrix, channel) == 76);
    assert!(core::mem::offset_of!(ot_scene_record_color_matrix, has_mask) == 80);
    assert!(core::mem::offset_of!(ot_scene_record_color_matrix, mask_count) == 84);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_scene_record_view {
    pub header: ot_scene_record_header,
    pub source: ot_handle,
    pub x: i32,
    pub y: i32,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_scene_record_view {}

impl Default for ot_scene_record_view {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        unsafe { core::mem::zeroed() }
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_scene_record_view>() == 32);
    assert!(core::mem::align_of::<ot_scene_record_view>() == 8);
    assert!(core::mem::offset_of!(ot_scene_record_view, header) == 0);
    assert!(core::mem::offset_of!(ot_scene_record_view, source) == 8);
    assert!(core::mem::offset_of!(ot_scene_record_view, x) == 24);
    assert!(core::mem::offset_of!(ot_scene_record_view, y) == 28);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_scene_record_image {
    pub header: ot_scene_record_header,
    pub image: ot_handle,
    pub options: ot_image_draw_options,
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_scene_record_image {}

impl Default for ot_scene_record_image {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        unsafe { core::mem::zeroed() }
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_scene_record_image>() == 88);
    assert!(core::mem::align_of::<ot_scene_record_image>() == 8);
    assert!(core::mem::offset_of!(ot_scene_record_image, header) == 0);
    assert!(core::mem::offset_of!(ot_scene_record_image, image) == 8);
    assert!(core::mem::offset_of!(ot_scene_record_image, options) == 24);
};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ot_scene_record_unicode {
    pub header: ot_scene_record_header,
    pub unicode: ot_handle,
    pub index: u32,
    pub x: i32,
    pub y: i32,
    pub attributes: u32,
    pub foreground: [u16; 4],
    pub background: [u16; 4],
}

// SAFETY: the record has no padding and only integer or float fields.
unsafe impl Pod for ot_scene_record_unicode {}

impl Default for ot_scene_record_unicode {
    fn default() -> Self {
        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.
        unsafe { core::mem::zeroed() }
    }
}

const _: () = {
    assert!(core::mem::size_of::<ot_scene_record_unicode>() == 56);
    assert!(core::mem::align_of::<ot_scene_record_unicode>() == 8);
    assert!(core::mem::offset_of!(ot_scene_record_unicode, header) == 0);
    assert!(core::mem::offset_of!(ot_scene_record_unicode, unicode) == 8);
    assert!(core::mem::offset_of!(ot_scene_record_unicode, index) == 24);
    assert!(core::mem::offset_of!(ot_scene_record_unicode, x) == 28);
    assert!(core::mem::offset_of!(ot_scene_record_unicode, y) == 32);
    assert!(core::mem::offset_of!(ot_scene_record_unicode, attributes) == 36);
    assert!(core::mem::offset_of!(ot_scene_record_unicode, foreground) == 40);
    assert!(core::mem::offset_of!(ot_scene_record_unicode, background) == 48);
};

unsafe extern "C" {
    pub fn ot_scene_set_hooks(context: *mut ot_context, node: *const ot_handle, scene_hooks: *const ot_scene_hooks) -> ot_status;
    pub fn ot_scene_frame_step_with_geometry(context: *mut ot_context, session: *const ot_handle, previous: *const ot_scene_frame_request, scene_frame_options: *const ot_scene_frame_options, recording: *const u8, recording_length: u32, out_request: *mut ot_scene_frame_request, out_geometry: *mut ot_scene_frame_geometry) -> ot_status;
    pub fn ot_scene_frame_get_paint_slots(context: *mut ot_context, session: *const ot_handle, record_request: *const ot_scene_frame_request, out_slots: *mut ot_scene_paint_slot, capacity: u32, out_count: *mut u32) -> ot_status;
    pub fn ot_scene_frame_cancel(context: *mut ot_context, session: *const ot_handle, frame_id: u64) -> ot_status;
    pub fn ot_scene_create_node(context: *mut ot_context, session: *const ot_handle, kind: u32, num: u32, out_node: *mut ot_handle) -> ot_status;
    pub fn ot_scene_destroy_node(context: *mut ot_context, node: *const ot_handle) -> ot_status;
    pub fn ot_scene_move_node(context: *mut ot_context, node: *const ot_handle, parent: *const ot_handle, index: u32) -> ot_status;
    pub fn ot_scene_clear_children(context: *mut ot_context, node: *const ot_handle) -> ot_status;
    pub fn ot_scene_set_measure(context: *mut ot_context, node: *const ot_handle, callback: ot_scene_measure_callback) -> ot_status;
    pub fn ot_scene_has_measure(context: *mut ot_context, node: *const ot_handle, out_enabled: *mut u32) -> ot_status;
    pub fn ot_scene_reaches_hooks(context: *mut ot_context, node: *const ot_handle, out_reached: *mut u32) -> ot_status;
    pub fn ot_scene_painted(context: *mut ot_context, node: *const ot_handle, out_painted: *mut u32) -> ot_status;
    pub fn ot_scene_mark_dirty(context: *mut ot_context, node: *const ot_handle) -> ot_status;
    pub fn ot_scene_set_style(context: *mut ot_context, node: *const ot_handle, group: u32, kind: u32, edge: u32, unit: u32, value: f32, flags: u32) -> ot_status;
    pub fn ot_scene_get_style(context: *mut ot_context, node: *const ot_handle, group: u32, kind: u32, edge: u32, out_value: *mut ot_scene_style_value) -> ot_status;
    pub fn ot_scene_set_paint(context: *mut ot_context, node: *const ot_handle, scene_paint_options: *const ot_scene_paint_options) -> ot_status;
    pub fn ot_scene_flush(context: *mut ot_context, updates: *const u8, byte_count: u32, out_applied: *mut u32) -> ot_status;
    pub fn ot_scene_set_surface(context: *mut ot_context, node: *const ot_handle, buffer: *const ot_handle) -> ot_status;
    pub fn ot_scene_set_box_details(context: *mut ot_context, node: *const ot_handle, scene_box_details: *const ot_scene_box_details, title: *const u8, title_bytes: u32, bottom_title: *const u8, bottom_title_bytes: u32) -> ot_status;
    pub fn ot_scene_set_viewport(context: *mut ot_context, node: *const ot_handle, viewport: *const ot_handle) -> ot_status;
    pub fn ot_scene_set_scroll(context: *mut ot_context, node: *const ot_handle, scene_scroll_options: *const ot_scene_scroll_options) -> ot_status;
    pub fn ot_scene_set_scroll_arrow(context: *mut ot_context, node: *const ot_handle, axis: u32, end: u32, scene_arrow_options: *const ot_scene_arrow_options, text: *const u8, byte_count: u32) -> ot_status;
    pub fn ot_scene_scroll_to(context: *mut ot_context, node: *const ot_handle, x: f64, y: f64, flags: u32, out_state: *mut ot_scene_scroll_state) -> ot_status;
    pub fn ot_scene_scroll_request(context: *mut ot_context, node: *const ot_handle, kind: u32, target: *const ot_handle, align: u32, inset: u32, out_state: *mut ot_scene_scroll_state) -> ot_status;
    pub fn ot_scene_get_scroll(context: *mut ot_context, node: *const ot_handle, out_state: *mut ot_scene_scroll_state) -> ot_status;
    pub fn ot_scene_set_focus(context: *mut ot_context, node: *const ot_handle, focused: u32) -> ot_status;
    pub fn ot_scene_set_slider(context: *mut ot_context, node: *const ot_handle, scene_slider_options: *const ot_scene_slider_options) -> ot_status;
    pub fn ot_scene_set_arrow(context: *mut ot_context, node: *const ot_handle, scene_arrow_options: *const ot_scene_arrow_options, text: *const u8, byte_count: u32) -> ot_status;
    pub fn ot_scene_get_slider_thumb(context: *mut ot_context, node: *const ot_handle, out_thumb: *mut ot_scene_slider_thumb) -> ot_status;
    pub fn ot_scene_set_text(context: *mut ot_context, node: *const ot_handle, bytes: *const u8, byte_count: u32) -> ot_status;
    pub fn ot_scene_set_styled_text(context: *mut ot_context, node: *const ot_handle, bytes: *const u8, byte_count: u32, chunks: *const ot_styled_text_chunk, chunk_count: u32, urls: *const u8, url_byte_count: u32) -> ot_status;
    pub fn ot_scene_set_text_options(context: *mut ot_context, node: *const ot_handle, scene_text_options: *const ot_scene_text_options) -> ot_status;
    pub fn ot_scene_set_text_selection(context: *mut ot_context, node: *const ot_handle, scene_text_selection_options: *const ot_scene_text_selection_options, out_changed: *mut u32) -> ot_status;
    pub fn ot_scene_get_text_selection(context: *mut ot_context, node: *const ot_handle, out_packed: *mut u64) -> ot_status;
    pub fn ot_scene_get_selected_text(context: *mut ot_context, node: *const ot_handle, bytes: *mut u8, capacity: u32, out_count: *mut u32) -> ot_status;
    pub fn ot_scene_get_text(context: *mut ot_context, node: *const ot_handle, bytes: *mut u8, capacity: u32, out_count: *mut u32) -> ot_status;
    pub fn ot_scene_get_text_info(context: *mut ot_context, node: *const ot_handle, out_info: *mut ot_scene_text_info) -> ot_status;
    pub fn ot_scene_get_text_lines(context: *mut ot_context, node: *const ot_handle, first_line: u32, lines: *mut ot_scene_text_line, capacity: u32, out_count: *mut u32) -> ot_status;
    pub fn ot_scene_get_text_byte_at(context: *mut ot_context, node: *const ot_handle, x: i32, y: i32, out_byte: *mut u32) -> ot_status;
    pub fn ot_scene_get_layout(context: *mut ot_context, node: *const ot_handle, observation: u32, out_layout: *mut ot_scene_layout) -> ot_status;
    pub fn ot_scene_paint(context: *mut ot_context, session: *const ot_handle, background: *const u16, use_mouse: u32, excluded_hit_num: u32, out_frame: *mut ot_scene_frame_request) -> ot_status;
    pub fn ot_scene_hit_test(context: *mut ot_context, session: *const ot_handle, x: i32, y: i32, out_num: *mut u32) -> ot_status;
    pub fn ot_scene_hit_test_excluding(context: *mut ot_context, session: *const ot_handle, x: i32, y: i32, excluded_num: u32, out_num: *mut u32) -> ot_status;
    pub fn ot_scene_get_stats(context: *mut ot_context, session: *const ot_handle, out_stats: *mut ot_scene_stats) -> ot_status;
    pub fn ot_scene_set_debug_flags(context: *mut ot_context, session: *const ot_handle, flags: u32) -> ot_status;
    pub fn ot_scene_get_cursor_state(context: *mut ot_context, session: *const ot_handle, out_state: *mut ot_scene_cursor_state) -> ot_status;
    pub fn ot_scene_frame_copy_buffer(context: *mut ot_context, session: *const ot_handle, scene_frame_request: *const ot_scene_frame_request, target: *const ot_handle) -> ot_status;
    pub fn ot_scene_measure_layout(context: *mut ot_context, session: *const ot_handle, root: *const ot_handle) -> ot_status;
    pub fn ot_session_render_split(context: *mut ot_context, session: *const ot_handle, scene_frame_request: *const ot_scene_frame_request, split_snapshot: *const ot_split_snapshot, count: u32, pinned_render_offset: u32, force: u32, out_status: *mut u32) -> ot_status;
    pub fn ot_session_split_control(context: *mut ot_context, session: *const ot_handle, split_control: *const ot_split_control, out_offset: *mut u32) -> ot_status;
    pub fn ot_session_set_screen(context: *mut ot_context, session: *const ot_handle, alternate: u32, width: u32, height: u32, trailing_output: *const u8, byte_count: u32) -> ot_status;
    pub fn ot_session_sync_detached(context: *mut ot_context, session: *const ot_handle, parent: *const ot_handle) -> ot_status;
    pub fn ot_unicode_create(context: *mut ot_context, bytes: *const u8, byte_count: u32, width_method: u32, out_unicode: *mut ot_handle) -> ot_status;
    pub fn ot_unicode_destroy(context: *mut ot_context, unicode: *const ot_handle) -> ot_status;
    pub fn ot_unicode_get(context: *mut ot_context, unicode: *const ot_handle, characters: *mut ot_unicode_char, capacity: u32, out_count: *mut u32) -> ot_status;
    pub fn ot_buffer_draw_unicode(context: *mut ot_context, target: *const ot_handle, frame: *const ot_scene_frame_request, unicode: *const ot_handle, index: u32, x: i32, y: i32, foreground: *const u16, background: *const u16, attributes: u32) -> ot_status;
    pub fn ot_embedded_terminal_create(context: *mut ot_context, embedded_terminal_options: *const ot_embedded_terminal_options, out_terminal: *mut ot_handle) -> ot_status;
    pub fn ot_embedded_terminal_destroy(context: *mut ot_context, terminal: *const ot_handle) -> ot_status;
    pub fn ot_embedded_terminal_write(context: *mut ot_context, terminal: *const ot_handle, bytes: *const u8, byte_count: u32) -> ot_status;
    pub fn ot_embedded_terminal_resize(context: *mut ot_context, terminal: *const ot_handle, cols: u32, rows: u32) -> ot_status;
    pub fn ot_embedded_terminal_command(context: *mut ot_context, terminal: *const ot_handle, command: u32, argument: i32) -> ot_status;
    pub fn ot_embedded_terminal_set_selection(context: *mut ot_context, terminal: *const ot_handle, start_x: u32, start_y: u32, end_x: u32, end_y: u32) -> ot_status;
    pub fn ot_embedded_terminal_get_selected_text(context: *mut ot_context, terminal: *const ot_handle, bytes: *mut u8, capacity: u32, out_count: *mut u32) -> ot_status;
    pub fn ot_embedded_terminal_compose(context: *mut ot_context, terminal: *const ot_handle, target: *const ot_handle, frame: *const ot_scene_frame_request, x: i32, y: i32) -> ot_status;
    pub fn ot_embedded_terminal_cursor_get(context: *mut ot_context, terminal: *const ot_handle, out_cursor: *mut ot_embedded_terminal_cursor) -> ot_status;
    pub fn ot_embedded_terminal_scrollbar_get(context: *mut ot_context, terminal: *const ot_handle, out_scrollbar: *mut ot_embedded_terminal_scrollbar) -> ot_status;
    pub fn ot_embedded_terminal_encode_key(context: *mut ot_context, terminal: *const ot_handle, embedded_terminal_key: *const ot_embedded_terminal_key, key: *const u8, key_count: u32, text: *const u8, text_count: u32, bytes: *mut u8, capacity: u32, out_count: *mut u32) -> ot_status;
    pub fn ot_embedded_terminal_encode_mouse(context: *mut ot_context, terminal: *const ot_handle, embedded_terminal_mouse: *const ot_embedded_terminal_mouse, bytes: *mut u8, capacity: u32, out_count: *mut u32) -> ot_status;
    pub fn ot_embedded_terminal_encode_paste(context: *mut ot_context, terminal: *const ot_handle, input: *const u8, input_count: u32, bytes: *mut u8, capacity: u32, out_count: *mut u32) -> ot_status;
    pub fn ot_embedded_terminal_encode_focus(context: *mut ot_context, terminal: *const ot_handle, focused: u32, bytes: *mut u8, capacity: u32, out_count: *mut u32) -> ot_status;
    pub fn ot_embedded_terminal_drain_responses(context: *mut ot_context, terminal: *const ot_handle, bytes: *mut u8, capacity: u32, out_count: *mut u32) -> ot_status;
    pub fn ot_edit_buffer_create(context: *mut ot_context, edit_buffer_options: *const ot_edit_buffer_options, out_edit_buffer: *mut ot_handle) -> ot_status;
    pub fn ot_edit_buffer_destroy(context: *mut ot_context, edit_buffer: *const ot_handle) -> ot_status;
    pub fn ot_editor_view_create(context: *mut ot_context, edit_buffer: *const ot_handle, width: u32, height: u32, out_view: *mut ot_handle) -> ot_status;
    pub fn ot_editor_view_destroy(context: *mut ot_context, view: *const ot_handle) -> ot_status;
    pub fn ot_syntax_style_create(context: *mut ot_context, out_style: *mut ot_handle) -> ot_status;
    pub fn ot_syntax_style_destroy(context: *mut ot_context, style: *const ot_handle) -> ot_status;
    pub fn ot_edit_buffer_set_syntax_style(context: *mut ot_context, edit_buffer: *const ot_handle, style: *const ot_handle) -> ot_status;
    pub fn ot_edit_buffer_set_text(context: *mut ot_context, edit_buffer: *const ot_handle, bytes: *const u8, byte_count: u32, preserve_history: u32) -> ot_status;
    pub fn ot_edit_buffer_insert_text(context: *mut ot_context, edit_buffer: *const ot_handle, bytes: *const u8, byte_count: u32) -> ot_status;
    pub fn ot_edit_buffer_delete_range(context: *mut ot_context, edit_buffer: *const ot_handle, start_row: u32, start_col: u32, end_row: u32, end_col: u32) -> ot_status;
    pub fn ot_edit_buffer_set_cursor(context: *mut ot_context, edit_buffer: *const ot_handle, row: u32, col: u32) -> ot_status;
    pub fn ot_edit_buffer_get_text(context: *mut ot_context, edit_buffer: *const ot_handle, bytes: *mut u8, capacity: u32, out_count: *mut u32) -> ot_status;
    pub fn ot_edit_buffer_get_info(context: *mut ot_context, edit_buffer: *const ot_handle, out_info: *mut ot_edit_buffer_info) -> ot_status;
    pub fn ot_edit_buffer_set_tab_width(context: *mut ot_context, edit_buffer: *const ot_handle, width: u32) -> ot_status;
    pub fn ot_edit_buffer_command(context: *mut ot_context, handle: *const ot_handle, command: u32, argument: u32) -> ot_status;
    pub fn ot_edit_buffer_history(context: *mut ot_context, handle: *const ot_handle, redo: u32, bytes: *mut u8, capacity: u32, out_count: *mut u32) -> ot_status;
    pub fn ot_edit_buffer_get_position(context: *mut ot_context, handle: *const ot_handle, query: u32, a: u32, b: u32, out_position: *mut ot_edit_position) -> ot_status;
    pub fn ot_edit_buffer_get_range(context: *mut ot_context, handle: *const ot_handle, by_coords: u32, start_row: u32, start_col: u32, end_row: u32, end_col: u32, bytes: *mut u8, capacity: u32, out_count: *mut u32) -> ot_status;
    pub fn ot_edit_buffer_measure_text(context: *mut ot_context, edit_buffer: *const ot_handle, bytes: *const u8, byte_count: u32, out_width: *mut u32) -> ot_status;
    pub fn ot_edit_measure_text(context: *mut ot_context, bytes: *const u8, byte_count: u32, width_method: u32, tab_width: u32, out_width: *mut u32) -> ot_status;
    pub fn ot_edit_buffer_set_defaults(context: *mut ot_context, handle: *const ot_handle, mask: u32, editor_style: *const ot_editor_style) -> ot_status;
    pub fn ot_syntax_style_register(context: *mut ot_context, handle: *const ot_handle, name: *const u8, byte_count: u32, editor_style: *const ot_editor_style, out_id: *mut u32) -> ot_status;
    pub fn ot_syntax_style_resolve(context: *mut ot_context, handle: *const ot_handle, name: *const u8, byte_count: u32, out_id: *mut u32) -> ot_status;
    pub fn ot_syntax_style_get_count(context: *mut ot_context, handle: *const ot_handle, out_count: *mut u32) -> ot_status;
    pub fn ot_edit_buffer_highlight(context: *mut ot_context, handle: *const ot_handle, operation: u32, argument: u32, highlight: *const ot_edit_highlight) -> ot_status;
    pub fn ot_edit_buffer_get_highlights(context: *mut ot_context, handle: *const ot_handle, line: u32, highlights: *mut ot_edit_highlight, capacity: u32, out_count: *mut u32) -> ot_status;
    pub fn ot_context_group_set(context: *mut ot_context, names: *const u8, name_byte_count: u32, name_end_bytes: *const u32, name_count: u32, out_group_set: *mut u32) -> ot_status;
    pub fn ot_edit_buffer_set_layer(context: *mut ot_context, handle: *const ot_handle, layer_id: u32, start_byte: u32, end_byte: u32, runs: *const ot_highlight_run, run_count: u32) -> ot_status;
    pub fn ot_edit_buffer_mark(context: *mut ot_context, handle: *const ot_handle, operation: u32, mark: *const ot_edit_mark, out_id: *mut u32) -> ot_status;
    pub fn ot_edit_buffer_get_marks(context: *mut ot_context, handle: *const ot_handle, id: u32, kind: u32, marks: *mut ot_edit_mark, capacity: u32, out_count: *mut u32) -> ot_status;
    pub fn ot_markdown_create(context: *mut ot_context, markdown_options: *const ot_markdown_options, out_doc: *mut ot_handle) -> ot_status;
    pub fn ot_markdown_destroy(context: *mut ot_context, doc: *const ot_handle) -> ot_status;
    pub fn ot_markdown_set_options(context: *mut ot_context, doc: *const ot_handle, markdown_options: *const ot_markdown_options, out: *mut ot_markdown_result) -> ot_status;
    pub fn ot_markdown_append(context: *mut ot_context, doc: *const ot_handle, bytes: *const u8, byte_count: u32, out: *mut ot_markdown_result) -> ot_status;
    pub fn ot_markdown_set(context: *mut ot_context, doc: *const ot_handle, bytes: *const u8, byte_count: u32, out: *mut ot_markdown_result) -> ot_status;
    pub fn ot_markdown_finish(context: *mut ot_context, doc: *const ot_handle, out: *mut ot_markdown_result) -> ot_status;
    pub fn ot_markdown_get_source(context: *mut ot_context, doc: *const ot_handle, out_bytes: *mut *const u8, out_byte_count: *mut u32) -> ot_status;
    pub fn ot_markdown_read_changes(context: *mut ot_context, doc: *const ot_handle, blocks: *mut ot_markdown_block, block_capacity: u32, out_block_count: *mut u32) -> ot_status;
    pub fn ot_markdown_read_source(context: *mut ot_context, doc: *const ot_handle, block_index: u32, bytes: *mut u8, byte_capacity: u32, out_byte_count: *mut u32) -> ot_status;
    pub fn ot_markdown_read_leaf(context: *mut ot_context, doc: *const ot_handle, block_index: u32, bytes: *mut u8, byte_capacity: u32, out_byte_count: *mut u32, chunks: *mut ot_styled_text_chunk, spans: *mut u32, chunk_capacity: u32, out_chunk_count: *mut u32, urls: *mut u8, url_byte_capacity: u32, out_url_byte_count: *mut u32) -> ot_status;
    pub fn ot_markdown_bind(context: *mut ot_context, doc: *const ot_handle, block_index: u32, text_node: *const ot_handle) -> ot_status;
    pub fn ot_editor_view_set_viewport(context: *mut ot_context, handle: *const ot_handle, editor_viewport: *const ot_editor_viewport, size_only: u32, move_cursor: u32) -> ot_status;
    pub fn ot_editor_view_get_viewport(context: *mut ot_context, handle: *const ot_handle, out_viewport: *mut ot_editor_viewport) -> ot_status;
    pub fn ot_editor_view_set_scroll_margin(context: *mut ot_context, handle: *const ot_handle, margin: f32) -> ot_status;
    pub fn ot_editor_view_command(context: *mut ot_context, handle: *const ot_handle, command: u32, argument: u32) -> ot_status;
    pub fn ot_editor_view_replace_selection(context: *mut ot_context, handle: *const ot_handle, bytes: *const u8, byte_count: u32, out_steps: *mut u32) -> ot_status;
    pub fn ot_editor_view_set_tab_color(context: *mut ot_context, handle: *const ot_handle, color: *const u16) -> ot_status;
    pub fn ot_editor_view_select(context: *mut ot_context, handle: *const ot_handle, editor_selection: *const ot_editor_selection, out_changed: *mut u32) -> ot_status;
    pub fn ot_editor_view_get_info(context: *mut ot_context, handle: *const ot_handle, follow_cursor: u32, out_info: *mut ot_editor_view_info) -> ot_status;
    pub fn ot_editor_view_get_selection(context: *mut ot_context, handle: *const ot_handle, out_info: *mut ot_editor_view_info) -> ot_status;
    pub fn ot_editor_view_get_selected_text(context: *mut ot_context, handle: *const ot_handle, bytes: *mut u8, capacity: u32, out_count: *mut u32) -> ot_status;
    pub fn ot_editor_view_get_position(context: *mut ot_context, handle: *const ot_handle, query: u32, out_position: *mut ot_editor_position) -> ot_status;
    pub fn ot_editor_view_get_lines(context: *mut ot_context, handle: *const ot_handle, logical: u32, lines: *mut ot_scene_text_line, capacity: u32, out_info: *mut ot_editor_measure) -> ot_status;
    pub fn ot_editor_view_measure(context: *mut ot_context, handle: *const ot_handle, width: u32, height: u32, out_info: *mut ot_editor_measure) -> ot_status;
    pub fn ot_editor_view_set_placeholder(context: *mut ot_context, handle: *const ot_handle, bytes: *const u8, byte_count: u32, chunks: *const ot_styled_text_chunk, chunk_count: u32) -> ot_status;
    pub fn ot_context_set_edit_event_callback(context: *mut ot_context, callback: ot_edit_event_callback) -> ot_status;
    pub fn ot_scene_set_editor_view(context: *mut ot_context, node: *const ot_handle, view: *const ot_handle) -> ot_status;
    pub fn ot_scene_set_editor_options(context: *mut ot_context, node: *const ot_handle, scene_editor_options: *const ot_scene_editor_options) -> ot_status;
    pub fn ot_image_destroy(context: *mut ot_context, image: *const ot_handle) -> ot_status;
    pub fn ot_image_inspect(context: *mut ot_context, bytes: *const u8, byte_count: u64, out_info: *mut ot_image_info) -> ot_status;
    pub fn ot_image_decode(context: *mut ot_context, bytes: *const u8, byte_count: u64, out_image: *mut ot_handle) -> ot_status;
    pub fn ot_image_create_pixels(context: *mut ot_context, pixels: *const u8, byte_count: u64, width: u32, height: u32, stride: u32, format: u32, alpha: u32, out_image: *mut ot_handle) -> ot_status;
    pub fn ot_image_update_pixels(context: *mut ot_context, image: *const ot_handle, pixels: *const u8, byte_count: u64, stride: u32, format: u32, alpha: u32) -> ot_status;
    pub fn ot_image_clone(destination: *mut ot_context, source: *mut ot_context, image: *const ot_handle, out_image: *mut ot_handle) -> ot_status;
    pub fn ot_image_retain(context: *mut ot_context, image: *const ot_handle, out_image: *mut ot_handle) -> ot_status;
    pub fn ot_image_get_info(context: *mut ot_context, image: *const ot_handle, out_info: *mut ot_image_info) -> ot_status;
    pub fn ot_image_resize(context: *mut ot_context, image: *const ot_handle, width: u32, height: u32, filter: u32, out_image: *mut ot_handle) -> ot_status;
    pub fn ot_image_extract(context: *mut ot_context, image: *const ot_handle, left: u32, top: u32, width: u32, height: u32, out_image: *mut ot_handle) -> ot_status;
    pub fn ot_image_extend(context: *mut ot_context, image: *const ot_handle, top: u32, right: u32, bottom: u32, left: u32, background_rgba: *const u8, out_image: *mut ot_handle) -> ot_status;
    pub fn ot_image_transform(context: *mut ot_context, image: *const ot_handle, operation: u32, out_image: *mut ot_handle) -> ot_status;
    pub fn ot_image_composite(context: *mut ot_context, base: *const ot_handle, overlay: *const ot_handle, left: i32, top: i32, blend: u32, opacity: u8, out_image: *mut ot_handle) -> ot_status;
    pub fn ot_image_copy_pixels(context: *mut ot_context, image: *const ot_handle, destination: *mut u8, byte_count: u64, stride: u32, format: u32) -> ot_status;
    pub fn ot_image_copy_png(context: *mut ot_context, image: *const ot_handle, destination: *mut u8, capacity: u64, out_byte_count: *mut u64) -> ot_status;
    pub fn ot_image_take_pixels(context: *mut ot_context, image: *const ot_handle, out_pixels: *mut ot_image_pixels) -> ot_status;
    pub fn ot_image_pixels_release(context: *mut ot_context, lease: *const ot_handle) -> ot_status;
    pub fn ot_scene_set_image(context: *mut ot_context, node: *const ot_handle, image: *const ot_handle, fit: u32, protocol: u32, buffer: *const ot_handle) -> ot_status;
    pub fn ot_scene_set_crop(context: *mut ot_context, node: *const ot_handle, left: u32, top: u32, width: u32, height: u32) -> ot_status;
    pub fn ot_scene_set_video(context: *mut ot_context, node: *const ot_handle, fit: u32, buffer: *const ot_handle) -> ot_status;
    pub fn ot_video_open(context: *mut ot_context, node: *const ot_handle, path: *const u8, path_length: u32, flags: u32, out_info: *mut ot_video_info) -> ot_status;
    pub fn ot_video_play(context: *mut ot_context, node: *const ot_handle) -> ot_status;
    pub fn ot_video_pause(context: *mut ot_context, node: *const ot_handle) -> ot_status;
    pub fn ot_video_seek(context: *mut ot_context, node: *const ot_handle, time_us: i64) -> ot_status;
    pub fn ot_video_set_loop(context: *mut ot_context, node: *const ot_handle, r#loop: u32) -> ot_status;
    pub fn ot_video_set_muted(context: *mut ot_context, node: *const ot_handle, muted: u32) -> ot_status;
    pub fn ot_video_set_volume(context: *mut ot_context, node: *const ot_handle, volume: f32) -> ot_status;
    pub fn ot_video_set_av_sync_offset(context: *mut ot_context, node: *const ot_handle, offset_us: i64) -> ot_status;
    pub fn ot_video_set_max_fps(context: *mut ot_context, node: *const ot_handle, fps: u32) -> ot_status;
    pub fn ot_video_get_state(context: *mut ot_context, node: *const ot_handle, out_state: *mut ot_video_state) -> ot_status;
    pub fn ot_video_get_error(context: *mut ot_context, node: *const ot_handle, bytes: *mut u8, capacity: u32, out_count: *mut u32) -> ot_status;
    pub fn ot_audio_create(context: *mut ot_context, out_engine: *mut ot_handle) -> ot_status;
    pub fn ot_audio_destroy(context: *mut ot_context, engine: *const ot_handle) -> ot_status;
    pub fn ot_audio_start(context: *mut ot_context, engine: *const ot_handle, flags: u32) -> ot_status;
    pub fn ot_audio_stop(context: *mut ot_context, engine: *const ot_handle) -> ot_status;
    pub fn ot_audio_load(context: *mut ot_context, engine: *const ot_handle, bytes: *const u8, byte_count: u64, out_sound: *mut u32) -> ot_status;
    pub fn ot_audio_play(context: *mut ot_context, engine: *const ot_handle, sound: u32, volume: f32, out_voice: *mut u32) -> ot_status;
    pub fn ot_audio_stop_voice(context: *mut ot_context, engine: *const ot_handle, voice: u32) -> ot_status;
    pub fn ot_audio_set_volume(context: *mut ot_context, engine: *const ot_handle, volume: f32) -> ot_status;
    pub fn ot_audio_mix(context: *mut ot_context, engine: *const ot_handle, samples: *mut f32, frame_count: u32, channels: u32) -> ot_status;
    pub fn ot_buffer_draw_image(context: *mut ot_context, target: *const ot_handle, frame: *const ot_scene_frame_request, image: *const ot_handle, image_draw_options: *const ot_image_draw_options, out_drawn: *mut u32) -> ot_status;
    pub fn ot_session_set_image_resolution(context: *mut ot_context, session: *const ot_handle, terminal_width: u32, terminal_height: u32, pixel_width: u32, pixel_height: u32) -> ot_status;
    pub fn ot_session_set_kitty_image_transport(context: *mut ot_context, session: *const ot_handle, mode: u32) -> ot_status;
    pub fn ot_session_get_kitty_image_transport(context: *mut ot_context, session: *const ot_handle, out_status: *mut ot_session_kitty_image_transport) -> ot_status;
    pub fn ot_session_poll_kitty_image_transport(context: *mut ot_context, session: *const ot_handle, now_ns: u64, out_retry: *mut u32) -> ot_status;
    pub fn ot_session_cancel_kitty_image_transport(context: *mut ot_context, session: *const ot_handle, failed: u32) -> ot_status;
    pub fn ot_session_process_kitty_image_reply(context: *mut ot_context, session: *const ot_handle, bytes: *const u8, byte_count: u32, out_result: *mut u32) -> ot_status;
    pub fn ot_session_start_kitty_file_probe(context: *mut ot_context, session: *const ot_handle) -> ot_status;
    pub fn ot_text_buffer_create(context: *mut ot_context, edit_buffer_options: *const ot_edit_buffer_options, out_buffer: *mut ot_handle) -> ot_status;
    pub fn ot_text_buffer_destroy(context: *mut ot_context, handle: *const ot_handle) -> ot_status;
    pub fn ot_text_buffer_view_create(context: *mut ot_context, buffer: *const ot_handle, out_view: *mut ot_handle) -> ot_status;
    pub fn ot_text_buffer_view_destroy(context: *mut ot_context, handle: *const ot_handle) -> ot_status;
    pub fn ot_text_buffer_set_text(context: *mut ot_context, handle: *const ot_handle, bytes: *const u8, byte_count: u32) -> ot_status;
    pub fn ot_text_buffer_append(context: *mut ot_context, handle: *const ot_handle, bytes: *const u8, byte_count: u32) -> ot_status;
    pub fn ot_text_buffer_clear(context: *mut ot_context, handle: *const ot_handle, reset: u32) -> ot_status;
    pub fn ot_text_buffer_set_styled_text(context: *mut ot_context, handle: *const ot_handle, bytes: *const u8, byte_count: u32, styled_text_chunk: *const ot_styled_text_chunk, chunk_count: u32, urls: *const u8, url_byte_count: u32) -> ot_status;
    pub fn ot_text_buffer_replace_styled_batch(context: *mut ot_context, text_buffer_replacement: *const ot_text_buffer_replacement, count: u32, bytes: *const u8, byte_count: u32, styled_text_chunk: *const ot_styled_text_chunk, chunk_count: u32, urls: *const u8, url_byte_count: u32, out: *mut ot_text_buffer_replacement_info) -> ot_status;
    pub fn ot_text_buffer_set_syntax_style(context: *mut ot_context, handle: *const ot_handle, style: *const ot_handle) -> ot_status;
    pub fn ot_text_buffer_get_info(context: *mut ot_context, handle: *const ot_handle, out_text_buffer_info: *mut ot_text_buffer_info) -> ot_status;
    pub fn ot_text_buffer_get_text(context: *mut ot_context, handle: *const ot_handle, out_bytes: *mut u8, capacity: u32, out_count: *mut u32) -> ot_status;
    pub fn ot_text_buffer_get_range(context: *mut ot_context, handle: *const ot_handle, start: u32, end: u32, out_bytes: *mut u8, capacity: u32, out_count: *mut u32) -> ot_status;
    pub fn ot_text_buffer_set_defaults(context: *mut ot_context, handle: *const ot_handle, mask: u32, editor_style: *const ot_editor_style) -> ot_status;
    pub fn ot_text_buffer_set_tab_width(context: *mut ot_context, handle: *const ot_handle, width: u32) -> ot_status;
    pub fn ot_text_buffer_highlight(context: *mut ot_context, handle: *const ot_handle, operation: u32, argument: u32, edit_highlight: *const ot_edit_highlight) -> ot_status;
    pub fn ot_text_buffer_get_highlights(context: *mut ot_context, handle: *const ot_handle, line: u32, out_edit_highlight: *mut ot_edit_highlight, capacity: u32, out_count: *mut u32) -> ot_status;
    pub fn ot_text_buffer_view_set_viewport(context: *mut ot_context, handle: *const ot_handle, editor_viewport: *const ot_editor_viewport, size_only: u32) -> ot_status;
    pub fn ot_text_buffer_view_command(context: *mut ot_context, handle: *const ot_handle, command: u32, argument: u32) -> ot_status;
    pub fn ot_text_buffer_view_set_tab_color(context: *mut ot_context, handle: *const ot_handle, color: *const u16) -> ot_status;
    pub fn ot_text_buffer_view_select(context: *mut ot_context, handle: *const ot_handle, editor_selection: *const ot_editor_selection, out_changed: *mut u32) -> ot_status;
    pub fn ot_text_buffer_view_get_info(context: *mut ot_context, handle: *const ot_handle, out_editor_view_info: *mut ot_editor_view_info) -> ot_status;
    pub fn ot_text_buffer_view_get_selected_text(context: *mut ot_context, handle: *const ot_handle, out_bytes: *mut u8, capacity: u32, out_count: *mut u32) -> ot_status;
    pub fn ot_text_buffer_view_get_lines(context: *mut ot_context, handle: *const ot_handle, logical: u32, first_line: u32, out_scene_text_line: *mut ot_scene_text_line, capacity: u32, out_editor_measure: *mut ot_editor_measure) -> ot_status;
    pub fn ot_text_buffer_view_measure(context: *mut ot_context, handle: *const ot_handle, width: u32, height: u32, out_editor_measure: *mut ot_editor_measure) -> ot_status;
    pub fn ot_scene_set_text_view(context: *mut ot_context, node: *const ot_handle, view: *const ot_handle) -> ot_status;
    pub fn ot_scene_set_text_view_paint(context: *mut ot_context, node: *const ot_handle, enabled: u32) -> ot_status;
    pub fn ot_buffer_draw_text_view(context: *mut ot_context, target: *const ot_handle, scene_frame_request: *const ot_scene_frame_request, view: *const ot_handle, x: i32, y: i32) -> ot_status;
    pub fn ot_buffer_draw_editor_view(context: *mut ot_context, target: *const ot_handle, scene_frame_request: *const ot_scene_frame_request, view: *const ot_handle, x: i32, y: i32) -> ot_status;
    pub fn ot_buffer_draw_scene_body(context: *mut ot_context, target: *const ot_handle, scene_frame_request: *const ot_scene_frame_request, node: *const ot_handle, x: i32, y: i32) -> ot_status;
    pub fn ot_scene_frame_acquire_buffer_lease(context: *mut ot_context, session: *const ot_handle, frame_request: *const ot_scene_frame_request, which: u32, out_snapshot: *mut ot_buffer_lease_snapshot) -> ot_status;
    pub fn ot_scene_frame_commit(context: *mut ot_context, session: *const ot_handle, frame_request: *const ot_scene_frame_request, force: u32, out_status: *mut u32) -> ot_status;
    pub fn ot_context_abi_version() -> u32;
    pub fn ot_context_create(options: *const ot_context_options, out_context: *mut *mut ot_context) -> ot_status;
    pub fn ot_context_destroy(context: *mut ot_context) -> ot_status;
    pub fn ot_context_get_last_error(context: *mut ot_context, out_error: *mut ot_context_error) -> ot_status;
    pub fn ot_context_drain_diagnostics(context: *mut ot_context, records: *mut ot_diagnostic, capacity: u32, out_drain: *mut ot_diagnostic_drain) -> ot_status;
    pub fn ot_context_get_link_url(context: *mut ot_context, link_id: u32, bytes: *mut u8, capacity: u32, out_count: *mut u32) -> ot_status;
    pub fn ot_buffer_create(context: *mut ot_context, options: *const ot_buffer_options, out_buffer: *mut ot_handle) -> ot_status;
    pub fn ot_buffer_destroy(context: *mut ot_context, buffer: *const ot_handle) -> ot_status;
    pub fn ot_buffer_resize(context: *mut ot_context, buffer: *const ot_handle, width: u32, height: u32) -> ot_status;
    pub fn ot_buffer_draw(context: *mut ot_context, target: *const ot_handle, frame: *const ot_scene_frame_request, options: *const ot_buffer_draw_header, source: *const ot_handle, text: *const u8, text_len: u32, bottom_title: *const u8, bottom_title_len: u32) -> ot_status;
    pub fn ot_buffer_stack(context: *mut ot_context, target: *const ot_handle, frame: *const ot_scene_frame_request, operation: u32, x: i32, y: i32, width: u32, height: u32, opacity: *const f32, out_opacity: *mut f32) -> ot_status;
    pub fn ot_buffer_draw_grid(context: *mut ot_context, target: *const ot_handle, frame: *const ot_scene_frame_request, options: *const ot_buffer_grid_options, columns: *const i32, column_count: u32, rows: *const i32, row_count: u32) -> ot_status;
    pub fn ot_buffer_draw_packed(context: *mut ot_context, handle: *const ot_handle, scene_frame_request: *const ot_scene_frame_request, data: *const u8, byte_count: u32, x: i32, y: i32, width: u32, height: u32) -> ot_status;
    pub fn ot_buffer_draw_supersample(context: *mut ot_context, handle: *const ot_handle, scene_frame_request: *const ot_scene_frame_request, data: *const u8, byte_count: u32, x: i32, y: i32, format: u32, stride: u32) -> ot_status;
    pub fn ot_buffer_draw_grayscale(context: *mut ot_context, handle: *const ot_handle, scene_frame_request: *const ot_scene_frame_request, data: *const f32, sample_count: u32, x: i32, y: i32, width: u32, height: u32, foreground: *const u16, background: *const u16, supersampled: u32) -> ot_status;
    pub fn ot_buffer_color_matrix(context: *mut ot_context, handle: *const ot_handle, scene_frame_request: *const ot_scene_frame_request, matrix: *const f32, matrix_count: u32, mask: *const f32, mask_count: u32, strength: *const f32, channel: u32) -> ot_status;
    pub fn ot_buffer_acquire_lease(context: *mut ot_context, buffer: *const ot_handle, out_snapshot: *mut ot_buffer_lease_snapshot) -> ot_status;
    pub fn ot_session_create(context: *mut ot_context, options: *const ot_session_options, out_session: *mut ot_handle) -> ot_status;
    pub fn ot_session_attach_renderer(context: *mut ot_context, session: *const ot_handle, options: *const ot_session_renderer_options) -> ot_status;
    pub fn ot_session_attach_renderer_with_env(context: *mut ot_context, session: *const ot_handle, options: *const ot_session_renderer_env_options, environment: *const u8) -> ot_status;
    pub fn ot_session_render(context: *mut ot_context, session: *const ot_handle, force: u32, out_result: *mut u32) -> ot_status;
    pub fn ot_session_resize_renderer(context: *mut ot_context, session: *const ot_handle, width: u32, height: u32) -> ot_status;
    pub fn ot_session_draw_buffer(context: *mut ot_context, session: *const ot_handle, source: *const ot_handle, x: i32, y: i32) -> ot_status;
    pub fn ot_scene_frame_draw_buffer(context: *mut ot_context, session: *const ot_handle, frame_request: *const ot_scene_frame_request, source: *const ot_handle, x: i32, y: i32) -> ot_status;
    pub fn ot_session_set_debug_overlay(context: *mut ot_context, session: *const ot_handle, enabled: u32, corner: u32) -> ot_status;
    pub fn ot_session_update_stats(context: *mut ot_context, session: *const ot_handle, overall_ms: f64, fps: u32, callback_ms: f64) -> ot_status;
    pub fn ot_session_update_memory_stats(context: *mut ot_context, session: *const ot_handle, heap_used: u32, heap_total: u32, array_buffers: u32) -> ot_status;
    pub fn ot_session_dump_hit_grid(context: *mut ot_context, session: *const ot_handle) -> ot_status;
    pub fn ot_session_get_renderer_state(context: *mut ot_context, session: *const ot_handle, out_state: *mut ot_session_renderer_state) -> ot_status;
    pub fn ot_session_acquire_buffer_lease(context: *mut ot_context, session: *const ot_handle, which: u32, out_snapshot: *mut ot_buffer_lease_snapshot) -> ot_status;
    pub fn ot_session_get_link_id(context: *mut ot_context, session: *const ot_handle, x: i32, y: i32, out_link_id: *mut u32) -> ot_status;
    pub fn ot_buffer_lease_validate(context: *mut ot_context, lease: *const ot_handle) -> ot_status;
    pub fn ot_buffer_lease_release(context: *mut ot_context, lease: *const ot_handle) -> ot_status;
    pub fn ot_buffer_lease_get_real_char_size(context: *mut ot_context, lease: *const ot_handle, add_line_breaks: u32, out_size: *mut u32) -> ot_status;
    pub fn ot_buffer_lease_write_resolved_chars(context: *mut ot_context, lease: *const ot_handle, bytes: *mut u8, capacity: u32, add_line_breaks: u32, cell_lengths: *mut u8, cell_capacity: u32, out_written: *mut u32) -> ot_status;
    pub fn ot_session_setup_terminal(context: *mut ot_context, session: *const ot_handle, options: *const ot_session_terminal_options) -> ot_status;
    pub fn ot_session_suspend(context: *mut ot_context, session: *const ot_handle) -> ot_status;
    pub fn ot_session_resume(context: *mut ot_context, session: *const ot_handle) -> ot_status;
    pub fn ot_session_get_terminal_state(context: *mut ot_context, session: *const ot_handle, out_phase: *mut u32) -> ot_status;
    pub fn ot_session_control(context: *mut ot_context, session: *const ot_handle, options: *const ot_session_control_options, bytes: *const u8, byte_count: u32) -> ot_status;
    pub fn ot_session_get_capabilities(context: *mut ot_context, session: *const ot_handle, out_capabilities: *mut ot_session_capabilities) -> ot_status;
    pub fn ot_session_clipboard(context: *mut ot_context, session: *const ot_handle, target: u32, bytes: *const u8, byte_count: u32, out_written: *mut u32) -> ot_status;
    pub fn ot_session_set_palette_state(context: *mut ot_context, handle: *const ot_handle, palette: *const u16, color_count: u32, foreground: *const u16, background: *const u16, epoch: u32) -> ot_status;
    pub fn ot_session_notification(context: *mut ot_context, handle: *const ot_handle, message: *const u8, message_len: u32, title: *const u8, title_len: u32, out_written: *mut u32) -> ot_status;
    pub fn ot_session_pump(context: *mut ot_context, session: *const ot_handle, now_ns: u64, work_budget: u32, out_result: *mut ot_session_pump_result) -> ot_status;
    pub fn ot_session_input_feed(context: *mut ot_context, session: *const ot_handle, bytes: *const u8, byte_count: u32, now_ns: u64, records: *mut ot_input_event, capacity: u32, payload: *mut u8, payload_capacity: u32, out_drain: *mut ot_input_drain) -> ot_status;
    pub fn ot_session_input_expect(context: *mut ot_context, session: *const ot_handle, flags: u32) -> ot_status;
    pub fn ot_session_input_reset(context: *mut ot_context, session: *const ot_handle, flags: u32) -> ot_status;
    pub fn ot_session_get_write_limit(context: *mut ot_context, session: *const ot_handle, out_bytes: *mut u64) -> ot_status;
    pub fn ot_session_write(context: *mut ot_context, session: *const ot_handle, bytes: *const u8, byte_count: u32) -> ot_status;
    pub fn ot_session_read_output(context: *mut ot_context, session: *const ot_handle, bytes: *mut u8, capacity: u32, out_ticket: *mut ot_output_ticket) -> ot_status;
    pub fn ot_session_drain_output(context: *mut ot_context, session: *const ot_handle, max_bytes: u32, out_written: *mut u32, user_data: *mut c_void, writer: ot_output_write_callback) -> ot_status;
    pub fn ot_session_drain_stdout(context: *mut ot_context, session: *const ot_handle, max_bytes: u32, out_written: *mut u32) -> ot_status;
    pub fn ot_session_post_stdout(context: *mut ot_context, session: *const ot_handle, max_bytes: u32, wait: u32, out_state: *mut u32, out_written: *mut u32) -> ot_status;
    pub fn ot_session_complete_output(context: *mut ot_context, session: *const ot_handle, ticket: *const ot_output_ticket, success: u32) -> ot_status;
    pub fn ot_session_close(context: *mut ot_context, session: *const ot_handle) -> ot_status;
    pub fn ot_session_drop_output(context: *mut ot_context, session: *const ot_handle) -> ot_status;
    pub fn ot_session_pump_exit(context: *mut ot_context, session: *const ot_handle, out_status: *mut u32) -> ot_status;
    pub fn ot_terminal_flush_input() -> ot_status;
    pub fn ot_session_cancel(context: *mut ot_context, session: *const ot_handle) -> ot_status;
    pub fn ot_session_get_state(context: *mut ot_context, session: *const ot_handle, out_state: *mut u32) -> ot_status;
    pub fn ot_session_destroy(context: *mut ot_context, session: *const ot_handle) -> ot_status;
    pub fn ot_clipboard_service_create(context: *mut ot_context, max_operations: u32, max_provider_transfers: u32, wayland_seat: *const u8, wayland_seat_length: u32) -> i32;
    pub fn ot_clipboard_service_begin_shutdown(context: *mut ot_context) -> u8;
    pub fn ot_clipboard_service_poll_shutdown(context: *mut ot_context) -> u8;
    pub fn ot_clipboard_service_destroy(context: *mut ot_context) -> u8;
    pub fn ot_clipboard_service_drain(context: *mut ot_context) -> u8;
    pub fn ot_clipboard_read_operation_start(context: *mut ot_context, request: *const u8, request_length: u32, selection: u8, max_bytes: u32, max_image_pixels: u32, max_conversion_bytes: u32, timeout_ms: u32, out_operation: *mut ot_handle) -> u8;
    pub fn ot_clipboard_write_operation_start(context: *mut ot_context, text: *const u8, text_length: u32, selection: u8, timeout_ms: u32, out_operation: *mut ot_handle) -> u8;
    pub fn ot_clipboard_clear_operation_start(context: *mut ot_context, selection: u8, timeout_ms: u32, out_operation: *mut ot_handle) -> u8;
    pub fn ot_clipboard_operation_poll(context: *mut ot_context, operation: *const ot_handle) -> u8;
    pub fn ot_clipboard_operation_cancel(context: *mut ot_context, operation: *const ot_handle) -> u8;
    pub fn ot_clipboard_operation_result_mime_length(context: *mut ot_context, operation: *const ot_handle, out_length: *mut u32) -> u8;
    pub fn ot_clipboard_operation_result_mime_copy(context: *mut ot_context, operation: *const ot_handle, out_bytes: *mut u8, capacity: u32) -> u8;
    pub fn ot_clipboard_operation_result_data_length(context: *mut ot_context, operation: *const ot_handle, out_length: *mut u32) -> u8;
    pub fn ot_clipboard_operation_result_data_copy(context: *mut ot_context, operation: *const ot_handle, out_bytes: *mut u8, capacity: u32) -> u8;
    pub fn ot_clipboard_operation_result_error_code(context: *mut ot_context, operation: *const ot_handle, out_error_code: *mut u32) -> u8;
    pub fn ot_clipboard_operation_result_diagnostic_length(context: *mut ot_context, operation: *const ot_handle, out_length: *mut u32) -> u8;
    pub fn ot_clipboard_operation_result_diagnostic_copy(context: *mut ot_context, operation: *const ot_handle, out_bytes: *mut u8, capacity: u32) -> u8;
    pub fn ot_clipboard_operation_destroy(context: *mut ot_context, operation: *const ot_handle) -> u8;
}
