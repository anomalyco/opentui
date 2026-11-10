pub const SplitScrollback = struct {
    published_rows: u32 = 0,
    tail_column: u32 = 0,

    pub fn reset(self: *SplitScrollback, seed_rows: u32) void {
        self.published_rows = seed_rows;
        self.tail_column = 0;
    }

    pub fn renderOffset(self: *const SplitScrollback, surface_offset: u32) u32 {
        if (surface_offset == 0) {
            return 0;
        }

        return @min(self.published_rows, surface_offset);
    }

    pub fn noteViewportScroll(self: *SplitScrollback, lines: u32) void {
        self.published_rows = self.published_rows - @min(lines, self.published_rows);
        if (self.published_rows == 0) {
            self.tail_column = 0;
        }
    }

    pub fn noteNewline(self: *SplitScrollback) void {
        if (self.published_rows == 0) {
            self.published_rows = 1;
        }

        self.published_rows += 1;
        self.tail_column = 0;
    }

    pub fn publishSnapshotRows(
        self: *SplitScrollback,
        row_count: u32,
        row_columns: u32,
        terminal_width: u32,
        trailing_newline: bool,
    ) void {
        if (row_count == 0) {
            return;
        }

        var row: u32 = 0;
        while (row < row_count) : (row += 1) {
            self.publishRow(row_columns, terminal_width, row + 1 < row_count or trailing_newline);
        }
    }

    pub fn publishRow(self: *SplitScrollback, columns: u32, width: u32, trailing_newline: bool) void {
        self.publishColumns(columns, width);
        if (trailing_newline) {
            self.noteNewline();
        }
    }

    fn publishColumns(self: *SplitScrollback, columns: u32, width: u32) void {
        if (columns == 0) {
            return;
        }

        const safe_width = @max(width, @as(u32, 1));
        var remaining = columns;

        while (remaining > 0) {
            if (self.published_rows == 0) {
                self.published_rows = 1;
            }

            if (self.tail_column >= safe_width) {
                self.published_rows += 1;
                self.tail_column = 0;
            }

            const available_width = safe_width - self.tail_column;
            const step = @min(remaining, available_width);

            self.tail_column += step;
            remaining -= step;

            if (remaining > 0 and self.tail_column >= safe_width) {
                self.published_rows += 1;
                self.tail_column = 0;
            }
        }
    }
};
