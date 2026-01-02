const std = @import("std");

// Import all test modules
const text_buffer_tests = @import("tests/text-buffer_test.zig");
const text_buffer_highlights_tests = @import("tests/text-buffer-highlights_test.zig");
const text_buffer_view_tests = @import("tests/text-buffer-view_test.zig");
const text_buffer_selection_tests = @import("tests/text-buffer-selection_test.zig");
const text_buffer_drawing_tests = @import("tests/text-buffer-drawing_test.zig");
const text_buffer_segment_tests = @import("tests/text-buffer-segment_test.zig");
const text_buffer_iterators_tests = @import("tests/text-buffer-iterators_test.zig");
const edit_buffer_tests = @import("tests/edit-buffer_test.zig");
const edit_buffer_history_tests = @import("tests/edit-buffer-history_test.zig");
const editor_view_tests = @import("tests/editor-view_test.zig");
const grapheme_tests = @import("tests/grapheme_test.zig");
const syntax_style_tests = @import("tests/syntax-style_test.zig");
const rope_tests = @import("tests/rope_test.zig");
const rope_nested_tests = @import("tests/rope-nested_test.zig");
const rope_fuzz_tests = @import("tests/rope_fuzz_test.zig");
const utf8_tests = @import("tests/utf8_test.zig");
const utf8_wcwidth_tests = @import("tests/utf8_wcwidth_test.zig");
const utf8_no_zwj_tests = @import("tests/utf8_no_zwj_test.zig");
const event_emitter_tests = @import("tests/event-emitter_test.zig");
const buffer_tests = @import("tests/buffer_test.zig");
const segment_merge_tests = @import("tests/segment-merge.test.zig");
const word_wrap_editing_tests = @import("tests/word-wrap-editing_test.zig");
const renderer_tests = @import("tests/renderer_test.zig");
const terminal_tests = @import("tests/terminal_test.zig");
const mem_registry_tests = @import("tests/mem-registry_test.zig");
const memory_leak_regression_tests = @import("tests/memory_leak_regression_test.zig");
// const example_tests = @import("example_test.zig");

// Re-export test declarations from individual test files
// This allows `zig test index.zig` to run all tests
comptime {
    _ = text_buffer_tests;
    _ = text_buffer_highlights_tests;
    _ = text_buffer_view_tests;
    _ = text_buffer_selection_tests;
    _ = text_buffer_drawing_tests;
    _ = text_buffer_segment_tests;
    _ = text_buffer_iterators_tests;
    _ = edit_buffer_tests;
    _ = edit_buffer_history_tests;
    _ = editor_view_tests;
    _ = grapheme_tests;
    _ = syntax_style_tests;
    _ = rope_tests;
    _ = rope_nested_tests;
    _ = rope_fuzz_tests;
    _ = utf8_tests;
    _ = utf8_wcwidth_tests;
    _ = utf8_no_zwj_tests;
    _ = event_emitter_tests;
    _ = buffer_tests;
    _ = segment_merge_tests;
    _ = word_wrap_editing_tests;
    _ = renderer_tests;
    _ = terminal_tests;
    _ = mem_registry_tests;
    _ = memory_leak_regression_tests;

    // _ = example_tests;
}
