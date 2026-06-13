const std = @import("std");
const Allocator = std.mem.Allocator;
const tb = @import("text-buffer.zig");
const tbv = @import("text-buffer-view.zig");
const eb = @import("edit-buffer.zig");
const iter_mod = @import("text-buffer-iterators.zig");
const ss = @import("syntax-style.zig");
const event_emitter = @import("event-emitter.zig");

const EditBuffer = eb.EditBuffer;

// Use the unified types to match EditBuffer
const UnifiedTextBuffer = tb.UnifiedTextBuffer;
const UnifiedTextBufferView = tbv.UnifiedTextBufferView;
const VirtualLine = tbv.VirtualLine;

pub const EditorViewError = error{
    OutOfMemory,
};

/// VisualCursor represents a cursor position with both visual and logical coordinates.
/// Visual coordinates (visual_row, visual_col) are VIEWPORT-RELATIVE.
/// This means visual_row=0 is the first visible line in the viewport, not the first line in the document.
/// Logical coordinates (logical_row, logical_col) are document-absolute.
pub const VisualCursor = struct {
    visual_row: u32, // Viewport-relative row (0 = top of viewport)
    visual_col: u32, // Viewport-relative column (0 = left edge of viewport when not wrapping)
    logical_row: u32, // Document-absolute row
    logical_col: u32, // Document-absolute column
    offset: u32, // Global display-width offset from buffer start
};

/// EditorView wraps a TextBufferView and manages viewport state for efficient rendering
/// It also holds a reference to an EditBuffer for cursor/editing operations
pub const EditorView = struct {
    text_buffer_view: *UnifiedTextBufferView,
    edit_buffer: *EditBuffer, // Reference to the EditBuffer (not owned)
    scroll_margin: f32, // Fraction of viewport height (0.0-0.5) to keep cursor away from edges
    desired_visual_col: ?u32, // Preserved visual column for visual up/down navigation
    selection_follow_cursor: bool, // Keep viewport synced during selection
    cursor_changed_listener: event_emitter.EventEmitter(eb.EditBufferEvent).Listener,

    placeholder_buffer: ?*UnifiedTextBuffer,
    placeholder_syntax_style: ?*ss.SyntaxStyle,
    placeholder_active: bool,

    // Memory management
    global_allocator: Allocator,

    fn onCursorChanged(ctx: *anyopaque) void {
        const self: *EditorView = @ptrCast(@alignCast(ctx));
        self.desired_visual_col = null;
        self.updatePlaceholderVisibility();

        const has_selection = self.text_buffer_view.selection != null;
        if (!has_selection or self.selection_follow_cursor) {
            const cursor = self.edit_buffer.getPrimaryCursor();
            const vcursor = self.logicalToVisualCursor(cursor.row, cursor.col);
            self.ensureCursorVisible(vcursor.visual_row);
        }
    }

    pub fn init(global_allocator: Allocator, edit_buffer: *EditBuffer, viewport_width: u32, viewport_height: u32) EditorViewError!*EditorView {
        const self = global_allocator.create(EditorView) catch return EditorViewError.OutOfMemory;
        errdefer global_allocator.destroy(self);

        const text_buffer = edit_buffer.getTextBuffer();
        const text_buffer_view = UnifiedTextBufferView.init(global_allocator, text_buffer) catch return EditorViewError.OutOfMemory;
        errdefer text_buffer_view.deinit();

        self.* = .{
            .text_buffer_view = text_buffer_view,
            .edit_buffer = edit_buffer,
            .scroll_margin = 0.15, // Default 15% margin
            .desired_visual_col = null,
            .selection_follow_cursor = false,
            .cursor_changed_listener = .{
                .ctx = undefined, // Will be set below
                .handle = onCursorChanged,
            },
            .placeholder_buffer = null,
            .placeholder_syntax_style = null,
            .placeholder_active = false,
            .global_allocator = global_allocator,
        };

        self.cursor_changed_listener.ctx = self;

        edit_buffer.events.on(.cursorChanged, self.cursor_changed_listener) catch return EditorViewError.OutOfMemory;

        text_buffer_view.setViewport(.{
            .x = 0,
            .y = 0,
            .width = viewport_width,
            .height = viewport_height,
        });

        return self;
    }

    pub fn deinit(self: *EditorView) void {
        const global_allocator = self.global_allocator;
        defer global_allocator.destroy(self);

        self.edit_buffer.events.off(.cursorChanged, self.cursor_changed_listener);

        if (self.placeholder_syntax_style) |style| {
            style.deinit();
        }

        if (self.placeholder_buffer) |placeholder| {
            placeholder.deinit();
        }

        self.text_buffer_view.deinit();
        self.* = undefined;
    }

    /// Set the viewport. If wrapping is enabled and viewport width differs from current wrap width,
    /// this will trigger a reflow by updating the TextBufferView's wrap width.
    /// moveCursor: if true, moves cursor to stay within viewport bounds (prevents viewport reset)
    pub fn setViewport(self: *EditorView, vp: ?tbv.Viewport, moveCursor: bool) void {
        self.text_buffer_view.setViewport(vp);

        if (moveCursor) {
            self.makeCursorVisible();
        }
    }

    pub fn getViewport(self: *const EditorView) ?tbv.Viewport {
        return self.text_buffer_view.getViewport();
    }

    /// Move the cursor to be within the current viewport if it's outside.
    /// Unlike ensureCursorVisible, this moves the cursor, not the viewport.
    /// Respects scroll margins to prevent immediate re-scrolling by ensureCursorVisible.
    pub fn makeCursorVisible(self: *EditorView) void {
        const vp = self.text_buffer_view.getViewport() orelse return;
        const cursor = self.edit_buffer.getPrimaryCursor();
        const vcursor = self.logicalToVisualCursor(cursor.row, cursor.col);

        const viewport_height = vp.height;
        const margin_lines = @max(1, @as(u32, @intFromFloat(@as(f32, @floatFromInt(viewport_height)) * self.scroll_margin)));

        const cursor_above_viewport = vcursor.visual_row < vp.y;
        const cursor_below_viewport = vcursor.visual_row >= vp.y + vp.height;
        const cursor_too_close_to_top = vcursor.visual_row < vp.y + margin_lines;
        const cursor_too_close_to_bottom = vcursor.visual_row >= vp.y + vp.height - margin_lines;

        if (cursor_above_viewport or cursor_below_viewport or cursor_too_close_to_top or cursor_too_close_to_bottom) {
            const target_visual_row = if (cursor_above_viewport or cursor_too_close_to_top)
                vp.y + margin_lines
            else
                vp.y + vp.height - margin_lines - 1;

            self.text_buffer_view.updateVirtualLines();
            const vlines = self.text_buffer_view.virtual_lines.items;
            if (target_visual_row < vlines.len) {
                const target_vline = &vlines[target_visual_row];
                const target_logical_row = @as(u32, @intCast(target_vline.source_line));

                const line_width = iter_mod.lineWidthAt(self.edit_buffer.tb.rope(), target_logical_row);
                const target_col = @min(cursor.col, line_width);

                if (self.edit_buffer.cursors.items.len > 0) {
                    const offset = iter_mod.coordsToOffset(self.edit_buffer.tb.rope(), target_logical_row, target_col) orelse return;
                    self.edit_buffer.cursors.items[0] = .{
                        .row = target_logical_row,
                        .col = target_col,
                        .desired_col = target_col,
                        .offset = offset,
                    };
                }
            }
        }
    }

    /// Set the scroll margin as a fraction of viewport height (0.0 to 0.5)
    /// The cursor will stay at least this many lines from the top/bottom edges when scrolling
    pub fn setScrollMargin(self: *EditorView, margin: f32) void {
        self.scroll_margin = @max(0.0, @min(0.5, margin));
    }

    pub fn setSelectionFollowCursor(self: *EditorView, enabled: bool) void {
        self.selection_follow_cursor = enabled;
    }

    /// Ensure the cursor is visible within the viewport, adjusting viewport.y and viewport.x if needed
    /// cursor_line: The virtual line index where the cursor is located
    pub fn ensureCursorVisible(self: *EditorView, cursor_line: u32) void {
        const vp = self.text_buffer_view.getViewport() orelse return;

        const viewport_height = vp.height;
        const viewport_width = vp.width;
        if (viewport_height == 0 or viewport_width == 0) return;

        const raw_margin_lines = @max(1, @as(u32, @intFromFloat(@as(f32, @floatFromInt(viewport_height)) * self.scroll_margin)));
        const max_margin_lines = if (viewport_height > 1) (viewport_height - 1) / 2 else 0;
        const margin_lines = @min(raw_margin_lines, max_margin_lines);

        const raw_margin_cols = @max(1, @as(u32, @intFromFloat(@as(f32, @floatFromInt(viewport_width)) * self.scroll_margin)));
        const max_margin_cols = if (viewport_width > 1) (viewport_width - 1) / 2 else 0;
        const margin_cols = @min(raw_margin_cols, max_margin_cols);

        const total_lines = self.text_buffer_view.getVirtualLineCount();
        const max_offset_y = if (total_lines > viewport_height) total_lines - viewport_height else 0;

        var new_offset_y = vp.y;
        var new_offset_x = vp.x;

        if (cursor_line < vp.y + margin_lines) {
            if (cursor_line >= margin_lines) {
                new_offset_y = cursor_line - margin_lines;
            } else {
                new_offset_y = 0;
            }
        } else if (cursor_line >= vp.y + viewport_height - margin_lines) {
            const desired_offset = cursor_line + margin_lines - viewport_height + 1;
            new_offset_y = @min(desired_offset, max_offset_y);
        }

        if (self.text_buffer_view.wrap_mode == .none) {
            const cursor = self.edit_buffer.getPrimaryCursor();
            const cursor_col = cursor.col;

            if (cursor_col < vp.x + margin_cols) {
                if (cursor_col >= margin_cols) {
                    new_offset_x = cursor_col - margin_cols;
                } else {
                    new_offset_x = 0;
                }
            } else if (cursor_col >= vp.x + viewport_width - margin_cols) {
                new_offset_x = cursor_col + margin_cols - viewport_width + 1;
            }
        }

        if (new_offset_y != vp.y or new_offset_x != vp.x) {
            self.text_buffer_view.setViewport(.{
                .x = new_offset_x,
                .y = new_offset_y,
                .width = vp.width,
                .height = vp.height,
            });
        }
    }

    /// Always ensures cursor visibility since cursor movements don't mark buffer dirty
    /// Note: With eager viewport updates in onCursorChanged, this is mainly for rendering methods
    pub fn updateBeforeRender(self: *EditorView) void {
        self.updatePlaceholderVisibility();

        const has_selection = self.text_buffer_view.selection != null;

        if (!has_selection or self.selection_follow_cursor) {
            const cursor = self.edit_buffer.getPrimaryCursor();
            const vcursor = self.logicalToVisualCursor(cursor.row, cursor.col);
            self.ensureCursorVisible(vcursor.visual_row);
        }
    }

    /// Automatically ensures cursor is visible before rendering
    pub fn getVirtualLines(self: *EditorView) []const VirtualLine {
        self.updateBeforeRender();
        return self.text_buffer_view.getVirtualLines();
    }

    /// Automatically ensures cursor is visible before rendering
    pub fn getCachedLineInfo(self: *EditorView) tbv.LineInfo {
        self.updateBeforeRender();
        return self.text_buffer_view.getCachedLineInfo();
    }

    pub fn getLogicalLineInfo(self: *EditorView) tbv.LineInfo {
        self.updatePlaceholderVisibility();
        self.text_buffer_view.virtual_lines_dirty = true;
        const line_info = self.text_buffer_view.getLogicalLineInfo();
        return line_info;
    }

    pub fn getTextBufferView(self: *EditorView) *UnifiedTextBufferView {
        return self.text_buffer_view;
    }

    pub fn getTotalVirtualLineCount(self: *EditorView) u32 {
        return self.text_buffer_view.getVirtualLineCount();
    }

    pub fn getVirtualLineSpans(self: *const EditorView, vline_idx: usize) tbv.VirtualLineSpanInfo {
        return self.text_buffer_view.getVirtualLineSpans(vline_idx);
    }

    pub fn getTextBuffer(self: *const EditorView) *UnifiedTextBuffer {
        return self.text_buffer_view.text_buffer;
    }

    pub fn getSelection(self: *const EditorView) ?tb.TextSelection {
        return self.text_buffer_view.selection;
    }

    pub fn setSelection(self: *EditorView, start: u32, end: u32, bgColor: ?tb.RGBA, fgColor: ?tb.RGBA) void {
        self.text_buffer_view.setSelection(start, end, bgColor, fgColor);
    }

    pub fn updateSelection(self: *EditorView, end: u32, bgColor: ?tb.RGBA, fgColor: ?tb.RGBA) void {
        self.text_buffer_view.updateSelection(end, bgColor, fgColor);
    }

    pub fn resetSelection(self: *EditorView) void {
        self.text_buffer_view.resetSelection();
    }

    pub fn setLocalSelection(self: *EditorView, anchorX: i32, anchorY: i32, focusX: i32, focusY: i32, bgColor: ?tb.RGBA, fgColor: ?tb.RGBA, updateCursor: bool) bool {
        const changed = self.text_buffer_view.setLocalSelection(anchorX, anchorY, focusX, focusY, bgColor, fgColor);

        if (changed and updateCursor) {
            self.syncCursorToSelectionFocus();
        }

        return changed;
    }

    pub fn updateLocalSelection(self: *EditorView, anchorX: i32, anchorY: i32, focusX: i32, focusY: i32, bgColor: ?tb.RGBA, fgColor: ?tb.RGBA, updateCursor: bool) bool {
        const changed = self.text_buffer_view.updateLocalSelection(anchorX, anchorY, focusX, focusY, bgColor, fgColor);

        if (changed and updateCursor) {
            self.syncCursorToSelectionFocus();
        }

        return changed;
    }

    pub fn resetLocalSelection(self: *EditorView) void {
        self.text_buffer_view.resetLocalSelection();
    }

    /// Updates the cursor position to match the selection focus position.
    /// Does NOT trigger viewport scrolling - TypeScript layer handles that.
    pub fn syncCursorToSelectionFocus(self: *EditorView) void {
        const selection = self.text_buffer_view.getSelection() orelse return;

        const focus_offset = if (self.text_buffer_view.selection_anchor_offset) |anchor| blk: {
            if (anchor == selection.start) {
                break :blk selection.end;
            } else {
                break :blk selection.start;
            }
        } else blk: {
            break :blk selection.end;
        };

        const focus_coords = iter_mod.offsetToCoords(self.edit_buffer.tb.rope(), focus_offset) orelse return;

        const line_count = iter_mod.getLineCount(self.edit_buffer.tb.rope());
        if (focus_coords.row >= line_count) return;

        const line_width = iter_mod.lineWidthAt(self.edit_buffer.tb.rope(), focus_coords.row);
        if (focus_coords.col > line_width) return;

        // Update cursor to focus position
        if (self.edit_buffer.cursors.items.len > 0) {
            self.edit_buffer.cursors.items[0] = .{
                .row = focus_coords.row,
                .col = focus_coords.col,
                .desired_col = focus_coords.col,
                .offset = focus_offset,
            };
        }
    }

    pub fn getSelectedTextIntoBuffer(self: *EditorView, out_buffer: []u8) usize {
        return self.text_buffer_view.getSelectedTextIntoBuffer(out_buffer);
    }

    pub fn packSelectionInfo(self: *const EditorView) u64 {
        return self.text_buffer_view.packSelectionInfo();
    }

    /// This is a convenience method that preserves existing offset
    /// After resize, ensures cursor is visible and clamps viewport offset to valid range
    pub fn setViewportSize(self: *EditorView, width: u32, height: u32) void {
        self.text_buffer_view.setViewportSize(width, height);

        const vp = self.text_buffer_view.getViewport() orelse return;
        const total_lines = self.text_buffer_view.getVirtualLineCount();
        const max_offset_y = if (total_lines > vp.height) total_lines - vp.height else 0;

        var new_offset_x = vp.x;
        if (self.text_buffer_view.wrap_mode == .none) {
            const max_line_width = iter_mod.getMaxLineWidth(self.edit_buffer.tb.rope());
            const max_offset_x = if (max_line_width > vp.width) max_line_width - vp.width else 0;
            if (vp.x > max_offset_x) {
                new_offset_x = max_offset_x;
            }
        }

        if (vp.y > max_offset_y or new_offset_x != vp.x) {
            self.text_buffer_view.setViewport(.{
                .x = new_offset_x,
                .y = @min(vp.y, max_offset_y),
                .width = vp.width,
                .height = vp.height,
            });
        }

        const cursor = self.edit_buffer.getPrimaryCursor();
        const vcursor = self.logicalToVisualCursor(cursor.row, cursor.col);
        self.ensureCursorVisible(vcursor.visual_row);
    }

    pub fn setWrapMode(self: *EditorView, mode: tb.WrapMode) void {
        self.text_buffer_view.setWrapMode(mode);
    }

    pub fn getPrimaryCursor(self: *const EditorView) eb.Cursor {
        return self.edit_buffer.getPrimaryCursor();
    }

    pub fn getCursor(self: *const EditorView, idx: usize) ?eb.Cursor {
        return self.edit_buffer.getCursor(idx);
    }

    pub fn getText(self: *EditorView, out_buffer: []u8) usize {
        return self.edit_buffer.getText(out_buffer);
    }

    /// Get the EditBuffer for direct access when needed
    pub fn getEditBuffer(self: *EditorView) *EditBuffer {
        return self.edit_buffer;
    }

    // ============================================================================
    // VisualCursor - Wrapping-aware cursor translation
    // ============================================================================

    /// Returns viewport-relative visual coordinates for external API consumers
    pub fn getVisualCursor(self: *EditorView) VisualCursor {
        self.updateBeforeRender();
        const cursor = self.edit_buffer.getPrimaryCursor();
        const vcursor = self.logicalToVisualCursor(cursor.row, cursor.col);

        // Convert absolute visual coordinates to viewport-relative for the API
        const vp = self.text_buffer_view.getViewport() orelse return vcursor;

        const viewport_relative_row = if (vcursor.visual_row >= vp.y) vcursor.visual_row - vp.y else 0;
        const viewport_relative_col = if (self.text_buffer_view.wrap_mode == .none)
            (if (vcursor.visual_col >= vp.x) vcursor.visual_col - vp.x else 0)
        else
            vcursor.visual_col;

        return .{
            .visual_row = viewport_relative_row,
            .visual_col = viewport_relative_col,
            .logical_row = vcursor.logical_row,
            .logical_col = vcursor.logical_col,
            .offset = vcursor.offset,
        };
    }

    /// This accounts for line wrapping by finding which virtual line contains the logical position
    /// Returns absolute visual coordinates (document-absolute, not viewport-relative)
    pub fn logicalToVisualCursor(self: *EditorView, logical_row: u32, logical_col: u32) VisualCursor {
        // Clamp logical coordinates to valid buffer ranges
        const line_count = iter_mod.getLineCount(self.edit_buffer.tb.rope());
        const clamped_row = if (line_count > 0) @min(logical_row, line_count - 1) else 0;

        const line_width = iter_mod.lineWidthAt(self.edit_buffer.tb.rope(), clamped_row);
        const clamped_col = @min(logical_col, line_width);

        const visual_row_idx = self.text_buffer_view.findVisualLineIndex(clamped_row, clamped_col);

        const vlines = self.text_buffer_view.virtual_lines.items;
        if (vlines.len == 0 or visual_row_idx >= vlines.len) {
            // Fallback for edge cases
            const offset = iter_mod.coordsToOffset(self.edit_buffer.tb.rope(), clamped_row, clamped_col) orelse 0;
            return .{
                .visual_row = 0,
                .visual_col = 0,
                .logical_row = clamped_row,
                .logical_col = clamped_col,
                .offset = offset,
            };
        }

        const vline = &vlines[visual_row_idx];
        const vline_start_col = vline.source_col_offset;

        // Calculate visual column within this virtual line
        const visual_col = if (clamped_col >= vline_start_col)
            clamped_col - vline_start_col
        else
            0;

        const offset = iter_mod.coordsToOffset(self.edit_buffer.tb.rope(), clamped_row, clamped_col) orelse 0;

        return .{
            .visual_row = visual_row_idx,
            .visual_col = visual_col,
            .logical_row = clamped_row,
            .logical_col = clamped_col,
            .offset = offset,
        };
    }

    /// Input visual coordinates are absolute (document-absolute)
    /// Returns a VisualCursor with absolute visual coordinates
    pub fn visualToLogicalCursor(self: *EditorView, visual_row: u32, visual_col: u32) ?VisualCursor {
        self.text_buffer_view.updateVirtualLines();

        const vlines = self.text_buffer_view.virtual_lines.items;
        if (visual_row >= vlines.len) return null;

        const vline = &vlines[visual_row];
        const clamped_visual_col = @min(visual_col, vline.width_cols);
        const logical_col = vline.source_col_offset + clamped_visual_col;
        const logical_row = @as(u32, @intCast(vline.source_line));

        const offset = iter_mod.coordsToOffset(self.edit_buffer.tb.rope(), logical_row, logical_col) orelse 0;

        return .{
            .visual_row = visual_row,
            .visual_col = clamped_visual_col,
            .logical_row = logical_row,
            .logical_col = logical_col,
            .offset = offset,
        };
    }

    fn clampVisualColToStayOnVisualRow(vlines: []const VirtualLine, visual_row: u32, visual_col: u32) u32 {
        if (visual_row >= vlines.len) return visual_col;

        const vline = &vlines[visual_row];
        var target_visual_col = @min(visual_col, vline.width_cols);

        // A wrap boundary is also the start of the next visual line. Step back so
        // logicalToVisualCursor does not canonicalize this target onto that line.
        if (target_visual_col == vline.width_cols and vline.width_cols > 0 and visual_row + 1 < vlines.len) {
            const next_vline = &vlines[visual_row + 1];
            if (next_vline.source_line == vline.source_line) {
                target_visual_col = vline.width_cols - 1;
            }
        }

        return target_visual_col;
    }

    pub fn moveUpVisual(self: *EditorView) void {
        const cursor = self.edit_buffer.getPrimaryCursor();
        const vcursor = self.logicalToVisualCursor(cursor.row, cursor.col);

        if (vcursor.visual_row == 0) {
            return;
        }

        const target_visual_row = vcursor.visual_row - 1;

        // This persists across empty/narrow lines to restore column when possible
        if (self.desired_visual_col == null) {
            self.desired_visual_col = vcursor.visual_col;
        }
        const desired_visual_col = self.desired_visual_col.?;

        // logicalToVisualCursor refreshed this snapshot; keep navigation on it.
        const vlines = self.text_buffer_view.virtual_lines.items;
        const target_visual_col = clampVisualColToStayOnVisualRow(vlines, target_visual_row, desired_visual_col);

        if (self.visualToLogicalCursor(target_visual_row, target_visual_col)) |new_vcursor| {
            if (self.edit_buffer.cursors.items.len > 0) {
                self.edit_buffer.cursors.items[0] = .{
                    .row = new_vcursor.logical_row,
                    .col = new_vcursor.logical_col,
                    .desired_col = new_vcursor.logical_col,
                    .offset = new_vcursor.offset,
                };
                self.ensureCursorVisible(new_vcursor.visual_row);

                // Restore desired_visual_col after the cursor change event resets it
                self.desired_visual_col = desired_visual_col;
            }
        }
    }

    pub fn moveDownVisual(self: *EditorView) void {
        const cursor = self.edit_buffer.getPrimaryCursor();
        const vcursor = self.logicalToVisualCursor(cursor.row, cursor.col);

        // logicalToVisualCursor refreshed this snapshot; keep navigation on it.
        const vlines = self.text_buffer_view.virtual_lines.items;

        if (vcursor.visual_row + 1 >= vlines.len) {
            return;
        }

        const target_visual_row = vcursor.visual_row + 1;

        // This persists across empty/narrow lines to restore column when possible
        if (self.desired_visual_col == null) {
            self.desired_visual_col = vcursor.visual_col;
        }
        const desired_visual_col = self.desired_visual_col.?;
        const target_visual_col = clampVisualColToStayOnVisualRow(vlines, target_visual_row, desired_visual_col);

        if (self.visualToLogicalCursor(target_visual_row, target_visual_col)) |new_vcursor| {
            if (self.edit_buffer.cursors.items.len > 0) {
                self.edit_buffer.cursors.items[0] = .{
                    .row = new_vcursor.logical_row,
                    .col = new_vcursor.logical_col,
                    .desired_col = new_vcursor.logical_col,
                    .offset = new_vcursor.offset,
                };
                self.ensureCursorVisible(new_vcursor.visual_row);

                // Restore desired_visual_col after the cursor change event resets it
                self.desired_visual_col = desired_visual_col;
            }
        }
    }

    pub fn deleteSelectedText(self: *EditorView) !void {
        const selection = self.text_buffer_view.getSelection() orelse {
            return;
        };

        const start_coords = iter_mod.offsetToCoords(self.edit_buffer.tb.rope(), selection.start) orelse {
            return;
        };
        const end_coords = iter_mod.offsetToCoords(self.edit_buffer.tb.rope(), selection.end) orelse {
            return;
        };

        const start_cursor: eb.Cursor = .{
            .row = start_coords.row,
            .col = start_coords.col,
            .desired_col = start_coords.col,
        };
        const end_cursor: eb.Cursor = .{
            .row = end_coords.row,
            .col = end_coords.col,
            .desired_col = end_coords.col,
        };

        try self.edit_buffer.deleteRange(start_cursor, end_cursor);
        self.text_buffer_view.resetLocalSelection();
        self.updateBeforeRender();
    }

    pub fn setCursorByOffset(self: *EditorView, offset: u32) !void {
        try self.edit_buffer.setCursorByOffset(offset);
        self.updateBeforeRender();
    }

    pub fn getNextWordBoundary(self: *EditorView) VisualCursor {
        const logical_cursor = self.edit_buffer.getNextWordBoundary();
        return self.logicalToVisualCursor(logical_cursor.row, logical_cursor.col);
    }

    pub fn getPrevWordBoundary(self: *EditorView) VisualCursor {
        const logical_cursor = self.edit_buffer.getPrevWordBoundary();
        return self.logicalToVisualCursor(logical_cursor.row, logical_cursor.col);
    }

    pub fn getEOL(self: *EditorView) VisualCursor {
        const logical_cursor = self.edit_buffer.getEOL();
        return self.logicalToVisualCursor(logical_cursor.row, logical_cursor.col);
    }

    /// Get the start of the current visual line (SOL = Start Of Line)
    /// Returns a cursor at column 0 of the current visual line
    pub fn getVisualSOL(self: *EditorView) VisualCursor {
        const cursor = self.edit_buffer.getPrimaryCursor();
        const vcursor = self.logicalToVisualCursor(cursor.row, cursor.col);

        // logicalToVisualCursor refreshed this snapshot; keep SOL on the same row.
        const vlines = self.text_buffer_view.virtual_lines.items;

        if (vcursor.visual_row >= vlines.len) {
            // Fallback: return cursor at column 0 of current logical line
            const offset = iter_mod.coordsToOffset(self.edit_buffer.tb.rope(), cursor.row, 0) orelse 0;
            return .{
                .visual_row = vcursor.visual_row,
                .visual_col = 0,
                .logical_row = cursor.row,
                .logical_col = 0,
                .offset = offset,
            };
        }

        const vline = &vlines[vcursor.visual_row];
        const logical_col = vline.source_col_offset; // Start column of this visual line
        const logical_row = @as(u32, @intCast(vline.source_line));
        const offset = iter_mod.coordsToOffset(self.edit_buffer.tb.rope(), logical_row, logical_col) orelse 0;

        return .{
            .visual_row = vcursor.visual_row,
            .visual_col = 0,
            .logical_row = logical_row,
            .logical_col = logical_col,
            .offset = offset,
        };
    }

    /// Get the end of the current visual line (EOL = End Of Line)
    /// Returns a cursor at the last position of the current visual line
    /// For wrapped lines, this is the position just before the wrap boundary to ensure
    /// the cursor stays on the current visual line when used with setCursor()
    pub fn getVisualEOL(self: *EditorView) VisualCursor {
        const cursor = self.edit_buffer.getPrimaryCursor();
        const vcursor = self.logicalToVisualCursor(cursor.row, cursor.col);

        // logicalToVisualCursor refreshed this snapshot; keep EOL on the same row.
        const vlines = self.text_buffer_view.virtual_lines.items;

        if (vcursor.visual_row >= vlines.len) {
            // Fallback: return end of current logical line
            const logical_cursor = self.edit_buffer.getEOL();
            return self.logicalToVisualCursor(logical_cursor.row, logical_cursor.col);
        }

        const vline = &vlines[vcursor.visual_row];
        const target_visual_col = clampVisualColToStayOnVisualRow(vlines, vcursor.visual_row, vline.width_cols);
        const logical_row = @as(u32, @intCast(vline.source_line));
        const logical_col = vline.source_col_offset + target_visual_col;
        const offset = iter_mod.coordsToOffset(self.edit_buffer.tb.rope(), logical_row, logical_col) orelse 0;

        return .{
            .visual_row = vcursor.visual_row,
            .visual_col = target_visual_col,
            .logical_row = logical_row,
            .logical_col = logical_col,
            .offset = offset,
        };
    }

    // ============================================================================
    // Placeholder - Visual Only
    // ============================================================================

    pub fn setPlaceholderStyledText(self: *EditorView, chunks: []const tb.StyledChunk) !void {
        if (chunks.len == 0) {
            if (self.placeholder_syntax_style) |style| {
                style.deinit();
                self.placeholder_syntax_style = null;
            }
            if (self.placeholder_buffer) |placeholder| {
                placeholder.deinit();
                self.placeholder_buffer = null;
            }
            if (self.placeholder_active) {
                self.text_buffer_view.switchToOriginalBuffer();
                self.placeholder_active = false;
            }
            return;
        }

        if (self.placeholder_buffer == null) {
            self.placeholder_buffer = try UnifiedTextBuffer.init(
                self.global_allocator,
                self.edit_buffer.tb.pool,
                self.edit_buffer.tb.link_pool,
                self.edit_buffer.tb.width_method,
            );
            const syntax_style = try ss.SyntaxStyle.init(self.global_allocator);
            self.placeholder_syntax_style = syntax_style;
            const placeholder = self.placeholder_buffer.?;
            placeholder.setSyntaxStyle(syntax_style);
        }

        const placeholder = self.placeholder_buffer.?;

        try placeholder.setStyledText(chunks);

        if (self.placeholder_active) {
            self.text_buffer_view.virtual_lines_dirty = true;
        }

        self.updatePlaceholderVisibility();
    }

    fn shouldShowPlaceholder(self: *const EditorView) bool {
        const rope_len = self.edit_buffer.tb.rope().totalWeight();
        return rope_len == 0 and self.placeholder_buffer != null;
    }

    fn updatePlaceholderVisibility(self: *EditorView) void {
        const should_show = self.shouldShowPlaceholder();

        if (should_show and !self.placeholder_active) {
            if (self.placeholder_buffer) |placeholder| {
                self.text_buffer_view.switchToBuffer(placeholder);
                self.placeholder_active = true;
            }
        } else if (!should_show and self.placeholder_active) {
            self.text_buffer_view.switchToOriginalBuffer();
            self.placeholder_active = false;
        }
    }

    pub fn setTabIndicator(self: *EditorView, indicator: ?u32) void {
        self.text_buffer_view.setTabIndicator(indicator);
    }

    pub fn getTabIndicator(self: *const EditorView) ?u32 {
        return self.text_buffer_view.getTabIndicator();
    }

    pub fn setTabIndicatorColor(self: *EditorView, color: ?tb.RGBA) void {
        self.text_buffer_view.setTabIndicatorColor(color);
    }

    pub fn getTabIndicatorColor(self: *const EditorView) ?tb.RGBA {
        return self.text_buffer_view.getTabIndicatorColor();
    }
};
