//! Runs the shared text corpus (`packages/native/src/tests/fixtures/text-corpus.json`) and the Unicode width map through
//! the public text API: `TextBuffer` and `TextView` lay text out; `EditBuffer` and `EditorView` edit it, move the cursor,
//! select and read ranges. The file's "format" entry documents the row keys. A text view draws only inside a frame, so
//! the draw checks run in Zig and Core; rows that set `control` or `offset`, which no public API sets, are skipped and
//! counted.

use opentui::native::{
    Context, ContextOptions, EditBuffer, EditCommand, EditorView, SelectionColors, TextBuffer, TextView, Viewport,
    VisualLine, WidthMethod, WrapMode,
};
use serde_json::Value;
use std::collections::BTreeMap;

const CORPUS: &str = include_str!("../../../../native/src/tests/fixtures/text-corpus.json");
const WIDTH_MAP: &str = include_str!("../../../../native/src/tests/fixtures/unicode-width-map.json");
const METHODS: [(&str, WidthMethod); 4] = [
    ("wcwidth", WidthMethod::Wcwidth),
    ("unicode", WidthMethod::Unicode),
    ("no_zwj", WidthMethod::NoZwj),
    ("unicode_wide", WidthMethod::UnicodeWide),
];

/// [source line, column from the source line's first row, width] per virtual line.
type Layout = Vec<[u32; 3]>;

fn layout(lines: &[VisualLine]) -> Layout {
    let first = |source| lines.iter().find(|line| line.source_line == source).unwrap().start_column;
    lines.iter().map(|line| [line.source_line, line.start_column - first(line.source_line), line.width]).collect()
}

fn u32_of(value: &Value) -> u32 {
    value.as_u64().unwrap() as u32
}

struct Run<'a> {
    row: &'a Value,
    name: &'a str,
    method: WidthMethod,
    context: &'a Context,
    /// (check, defect) entries for this method, and whether each reversed a check that ran.
    bugs: Vec<(&'a str, &'a str, bool)>,
    failures: Vec<String>,
    counts: &'a mut BTreeMap<String, u64>,
}

impl<'a> Run<'a> {
    fn want(&self, key: &str) -> Option<&'a Value> {
        let value = self.row.get(key)?;
        if value.is_object() { value.get(self.name) } else { Some(value) }
    }

    /// A check named by a `bug` entry for this method must fail; every other check must pass.
    fn check(&mut self, name: &str, ok: bool) {
        *self.counts.entry(name.to_owned()).or_default() += 1;
        let bug = self.bugs.iter_mut().find(|(check, ..)| *check == name);
        let expected = bug.is_none();
        if let Some(bug) = bug {
            bug.2 = true;
        }
        if ok != expected {
            let defect = self.bugs.iter().find(|(check, ..)| *check == name).map(|bug| bug.1);
            self.failures.push(format!(
                "{name} {}: {}",
                self.name,
                defect.map_or("failed".into(), |d| format!("{d} passes"))
            ));
        }
    }

    fn tab(&self) -> u32 {
        self.row.get("tab").map_or(4, u32_of)
    }

    fn wrap(&self) -> WrapMode {
        match self.row.get("wrap").and_then(Value::as_str) {
            Some("char") => WrapMode::Char,
            Some("word") => WrapMode::Word,
            _ => WrapMode::None,
        }
    }

    fn cols(&self) -> Option<u32> {
        self.row.get("cols").map(u32_of)
    }

    fn load(&self, parts: &[&str]) -> TextBuffer {
        let buffer = TextBuffer::new(self.context, self.method).unwrap();
        buffer.set_tab_width(self.tab()).unwrap();
        for part in parts {
            buffer.append(part).unwrap();
        }
        buffer
    }

    /// A view wrapping at `cols` (its viewport width) in `wrap`, or unwrapped without `cols`.
    fn view(&self, buffer: &TextBuffer, wrap: WrapMode, cols: Option<u32>) -> TextView {
        let view = TextView::new(buffer).unwrap();
        view.set_wrap(wrap).unwrap();
        if let Some(width) = cols {
            view.set_viewport(Viewport { x: 0, y: 0, width, height: 1 << 20 }).unwrap();
        }
        view
    }

    fn lines(view: &TextView) -> Vec<VisualLine> {
        view.lines(0, u32::MAX).unwrap()
    }

    /// The widest-line metric equals the widest unwrapped line, however the chunks fall.
    fn widest(&self, buffer: &TextBuffer) -> bool {
        let view = self.view(buffer, WrapMode::None, None);
        let max = Self::lines(&view).iter().map(|line| line.width).max().unwrap_or(0);
        view.measure(80).unwrap().width_max == max
    }

    fn edit(&self, text: &str) -> EditBuffer {
        let edit = EditBuffer::new(self.context, self.method).unwrap();
        edit.set_tab_width(self.tab()).unwrap();
        edit.set_text(text, false).unwrap();
        edit
    }

    /// Cursor columns from the line start that moving right visits, without repeats.
    fn stops(edit: &EditBuffer, moves: usize) -> Vec<u32> {
        edit.set_cursor(0, 0).unwrap();
        let mut stops = vec![0];
        for _ in 0..moves {
            edit.command(EditCommand::MoveRight).unwrap();
            let col = edit.info().unwrap().cursor.1;
            if stops.last() != Some(&col) {
                stops.push(col);
            }
        }
        stops
    }

    fn text_row(&mut self, parts: &[&str]) {
        let text = parts.concat();
        let buffer = self.load(parts);
        self.check("text", buffer.text().unwrap() == text.replace("\r\n", "\n"));
        let unwrapped = Self::lines(&self.view(&buffer, WrapMode::None, None));
        let widths: Vec<u32> = unwrapped.iter().map(|line| line.width).collect();
        if let Some(width) = self.want("width").map(u32_of).filter(|_| !text.contains('\n')) {
            self.check("width", widths[0] == width);
        }
        if let Some(expected) = self.want("line_widths").cloned() {
            self.check("line_widths", widths == expected.as_array().unwrap().iter().map(u32_of).collect::<Vec<_>>());
        }
        if let Some(max) = self.want("max").map(u32_of) {
            self.check("max", self.view(&buffer, WrapMode::None, None).measure(80).unwrap().width_max == max);
        }
        let widest = self.widest(&buffer);
        self.check("widest", widest);

        let (wrap, cols) = (self.wrap(), self.cols());
        let main = self.view(&buffer, wrap, cols);
        let key = layout(&Self::lines(&main));
        if let Some(lines) = self.want("lines").cloned() {
            let expected: Layout = lines
                .as_array()
                .unwrap()
                .iter()
                .map(|line| [u32_of(&line[0]), u32_of(&line[1]), u32_of(&line[2])])
                .collect();
            self.check("lines", key == expected);
        }
        if let (true, Some(cols)) = (self.row.get("wrap").is_some(), cols) {
            let measured = main.measure(cols).unwrap();
            let max = key.iter().map(|line| line[2]).max().unwrap_or(0);
            self.check("measure", (measured.line_count as usize, measured.width_max) == (key.len(), max));
            main.set_viewport(Viewport { x: 0, y: 0, width: cols + 2, height: 1 << 20 }).unwrap();
            Self::lines(&main);
            main.set_viewport(Viewport { x: 0, y: 0, width: cols, height: 1 << 20 }).unwrap();
            let fresh = layout(&Self::lines(&self.view(&buffer, wrap, Some(cols))));
            self.check("resize", layout(&Self::lines(&main)) == fresh);
        }
        let whole = |run: &Self| layout(&Self::lines(&run.view(&run.load(&[&text]), wrap, cols)));
        if parts.len() > 1 {
            self.check("fresh", key == whole(self));
        }
        // Selections and ranges count document cells, which the editor reads.
        if self.want("select").is_some() || self.want("range").is_some() {
            let edit = self.edit(&text);
            let editor = EditorView::new(&edit, 80, 1 << 10).unwrap();
            for entry in self.want("select").and_then(Value::as_array).cloned().unwrap_or_default() {
                editor.select_range(u32_of(&entry[0]), u32_of(&entry[1]), SelectionColors::default()).unwrap();
                self.check("select", editor.selected_text().unwrap() == entry[2].as_str().unwrap());
            }
            for entry in self.want("range").and_then(Value::as_array).cloned().unwrap_or_default() {
                let range = edit.range(u32_of(&entry[0]), u32_of(&entry[1])).unwrap();
                self.check("range", range == entry[2].as_str().unwrap());
            }
        }
        if self.row.get("split").and_then(Value::as_bool) == Some(true) {
            let (mut ok, mut widest_ok) = (true, true);
            let expected = whole(self);
            for (cut, _) in text.char_indices().skip(1) {
                let pieces = self.load(&[&text[..cut], &text[cut..]]);
                ok &= layout(&Self::lines(&self.view(&pieces, wrap, cols))) == expected;
                widest_ok &= self.widest(&pieces);
            }
            self.check("split", ok);
            self.check("widest", widest_ok);
        }
        if !text.contains(['\n', '\r']) {
            self.clusters(&text);
        }
    }

    /// The cursor stops that moving right visits end at the line's width, and char wrap at one column breaks only at a
    /// stop, into rows whose widths add up to that width. Under wcwidth a stop can fall inside a cluster, so the check
    /// goes one way: every break is a stop.
    fn clusters(&mut self, text: &str) {
        let edit = self.edit(text);
        let stops = Self::stops(&edit, text.chars().count());
        let editor = EditorView::new(&edit, 1, 1 << 10).unwrap();
        let width = editor.lines().unwrap()[0].width;
        editor.set_wrap(WrapMode::Char).unwrap();
        let rows = editor.lines().unwrap();
        let ok = stops.last() == Some(&width)
            && rows.iter().map(|row| row.width).sum::<u32>() == width
            && rows.iter().all(|row| stops.contains(&row.start_column));
        self.check("clusters", ok);
    }

    fn ops_row(&mut self, ops: &[Value]) {
        let edit = EditBuffer::new(self.context, self.method).unwrap();
        edit.set_tab_width(self.tab()).unwrap();
        for op in ops {
            apply(&edit, op);
        }
        let text = edit.text().unwrap();
        let editor = EditorView::new(&edit, self.cols().unwrap_or(80), 1 << 10).unwrap();
        if let Some(result) = self.want("result").cloned() {
            self.check("result", text == result.as_str().unwrap());
        }
        let widths: Vec<u32> = editor.lines().unwrap().iter().map(|line| line.width).collect();
        if let Some(expected) = self.want("line_widths").cloned() {
            self.check("line_widths", widths == expected.as_array().unwrap().iter().map(u32_of).collect::<Vec<_>>());
        }
        let max = editor.measure(self.cols().unwrap_or(80), 1 << 10).unwrap().1;
        if let Some(expected) = self.want("max").map(u32_of) {
            self.check("max", max == expected);
        }
        self.check("widest", max == widths.iter().copied().max().unwrap_or(0));
        editor.set_wrap(self.wrap()).unwrap();
        let fresh = layout(&Self::lines(&self.view(&self.load(&[&text]), self.wrap(), self.cols())));
        self.check("fresh", layout(&editor.lines().unwrap()) == fresh);
        if let Some(expected) = self.want("stops").cloned() {
            edit.set_cursor(0, 0).unwrap();
            let mut seen: Vec<[u32; 2]> = Vec::new();
            for _ in 0..text.encode_utf16().count() + 2 {
                let (row, col) = edit.info().unwrap().cursor;
                if seen.last() == Some(&[row, col]) {
                    break;
                }
                seen.push([row, col]);
                edit.command(EditCommand::MoveRight).unwrap();
            }
            let expected: Vec<[u32; 2]> =
                expected.as_array().unwrap().iter().map(|stop| [u32_of(&stop[0]), u32_of(&stop[1])]).collect();
            self.check("stops", seen == expected);
        }
    }
}

fn apply(edit: &EditBuffer, op: &Value) {
    let op = op.as_array().unwrap();
    let text = |index: usize| op[index].as_str().unwrap();
    match text(0) {
        "repeat" => {
            let limit = edit.text().unwrap().encode_utf16().count() + 1;
            for _ in 0..limit {
                let before = edit.text().unwrap();
                apply(edit, &op[1]);
                if edit.text().unwrap() == before {
                    break;
                }
            }
        }
        "set" => edit.set_text(text(1), false).unwrap(),
        "cursor" => edit.set_cursor(u32_of(&op[1]), u32_of(&op[2])).unwrap(),
        "insert" => edit.insert(text(1)).unwrap(),
        "delete" => edit.command(EditCommand::DeleteForward).unwrap(),
        "backspace" => edit.command(EditCommand::Backspace).unwrap(),
        "right" => edit.command(EditCommand::MoveRight).unwrap(),
        "undo_all" => {
            while edit.info().unwrap().can_undo {
                edit.undo().unwrap();
            }
        }
        name => panic!("unknown op {name}"),
    }
}

#[test]
fn text_corpus_rows_hold_through_the_public_text_api() {
    let corpus: Value = serde_json::from_str(CORPUS).unwrap();
    let keys: Vec<&str> = corpus["keys"].as_array().unwrap().iter().map(|key| key.as_str().unwrap()).collect();
    let context = Context::new(ContextOptions::default()).unwrap();
    let mut counts = BTreeMap::new();
    let mut failures = Vec::new();
    for row in corpus["rows"].as_array().unwrap() {
        let id = row["id"].as_str().unwrap();
        let fields = row.as_object().unwrap();
        assert!(fields.keys().all(|key| keys.contains(&key.as_str())), "{id}: unknown key");
        let methods: Vec<&str> = row.get("methods").map_or(METHODS.iter().map(|(name, _)| *name).collect(), |list| {
            list.as_array().unwrap().iter().map(|name| name.as_str().unwrap()).collect()
        });
        for name in methods {
            let method = METHODS.iter().find(|(known, _)| *known == name).unwrap_or_else(|| panic!("{id}: {name}")).1;
            if row.get("control").is_some() || row.get("offset").is_some() {
                *counts.entry("skipped".to_owned()).or_default() += 1;
                continue;
            }
            let bugs = row
                .get("bug")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|bug| bug.get(2).is_none_or(|only| only.as_array().unwrap().iter().any(|m| m == name)))
                .map(|bug| (bug[0].as_str().unwrap(), bug[1].as_str().unwrap(), false))
                .collect();
            let mut run = Run { row, name, method, context: &context, bugs, failures: Vec::new(), counts: &mut counts };
            match (row.get("ops"), row.get("parts")) {
                (Some(ops), _) => run.ops_row(ops.as_array().unwrap()),
                (None, Some(parts)) => run
                    .text_row(&parts.as_array().unwrap().iter().map(|part| part.as_str().unwrap()).collect::<Vec<_>>()),
                (None, None) => run.text_row(&[row["text"].as_str().unwrap()]),
            }
            // A text view draws only inside a frame: entries for draw checks have nothing to reverse here.
            const DRAWN: [&str; 6] = ["draw", "draw_at", "draw_text", "encode", "overdraw", "terminal"];
            for (check, ..) in run.bugs.iter().filter(|(check, _, ran)| !ran && !DRAWN.contains(check)) {
                run.failures.push(format!("{name}: bug entry {check} never ran"));
            }
            failures.extend(run.failures.into_iter().map(|failure| format!("{id}: {failure}")));
        }
    }
    assert_eq!(failures, Vec::<String>::new());
    // Each check kind runs as often as the file says, so a runner change cannot skip one silently.
    let expected: BTreeMap<String, u64> = serde_json::from_value(corpus["checks"]["rust"].clone()).unwrap();
    assert_eq!(counts, expected);
}

#[test]
fn each_code_point_of_the_width_map_takes_its_cells() {
    let map: Value = serde_json::from_str(WIDTH_MAP).unwrap();
    let context = Context::new(ContextOptions::default()).unwrap();
    let mut failures = Vec::new();
    for (name, method) in METHODS {
        let buffer = TextBuffer::new(&context, method).unwrap();
        let view = TextView::new(&buffer).unwrap();
        for run in map["runs"].as_array().unwrap() {
            let bound = |index: usize| u32::from_str_radix(run[index].as_str().unwrap(), 16).unwrap();
            for cp in bound(0)..=bound(1) {
                buffer.set_text(char::from_u32(cp).unwrap().encode_utf8(&mut [0; 4])).unwrap();
                if view.lines(0, 1).unwrap()[0].width != u32_of(&run[2]) {
                    failures.push(format!("U+{cp:04X} {name}"));
                }
            }
        }
    }
    assert_eq!(failures, Vec::<String>::new());
}
