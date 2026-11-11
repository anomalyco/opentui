//! Frames of the shared Markdown corpus (`packages/core/src/renderables/markdown.conformance.json`), compared with
//! the frames OpenTUI Core renders for it (`tests/fixtures/markdown/render.ts` writes the fixtures' frames).

use opentui::testing::TestApp;
use opentui::widget::{AnyWidget, ColumnWidthMode, Container, Markdown, MarkdownTableOptions, Text, Widget};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::{Cell, RefCell};
use std::path::Path;
use std::rc::Rc;

thread_local! {
    /// Allocations made on this thread, so a test can check that a read allocates nothing.
    static ALLOCATIONS: Cell<usize> = const { Cell::new(0) };
}

struct Counting;

#[global_allocator]
static ALLOCATOR: Counting = Counting;

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOCATIONS.with(|count| count.set(count.get() + 1));
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
}

const CASES: [&str; 6] = ["code", "emphasis", "headings", "links", "lists", "tables"];

/// Where the Rust widget differs from Core on purpose; `docs/markdown.md` gives the reasons.
const DEVIATIONS: [(&str, &str, &str, &str); 5] = [
    ("lists", "conceal", "- todo", "- ☐ todo"),
    ("lists", "conceal", "- done", "- ☑ done"),
    ("lists", "source", "- todo", "- [ ] todo"),
    ("lists", "source", "- done", "- [x] done"),
    ("emphasis", "conceal", "Escaped \\*stars\\*.", "Escaped *stars*."),
];

fn fixture(name: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/markdown").join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// The rows of the Markdown corpus that Core's tests run too: name, chunks, HTML, failing runners, and frames.
fn corpus() -> Vec<serde_json::Value> {
    let corpus: serde_json::Value =
        serde_json::from_str(include_str!("../../../../core/src/renderables/markdown.conformance.json")).unwrap();
    corpus["rows"].as_array().unwrap().clone()
}

fn strings(value: &serde_json::Value) -> Vec<&str> {
    value.as_array().unwrap().iter().map(|item| item.as_str().unwrap()).collect()
}

fn frame(app: &TestApp) -> String {
    let capture = app.render();
    let rows: Vec<String> = (0..capture.height).map(|y| capture.row(y).trim_end().to_owned()).collect();
    rows.join("\n").trim_end().to_owned() + "\n"
}

/// A document as OpenCode's transcript configures it.
fn document(app: &TestApp, conceal: bool) -> Markdown {
    let options = MarkdownTableOptions { cell_padding_x: Some(1), ..MarkdownTableOptions::default() };
    let markdown = Markdown::new(app).conceal(conceal).table_options(options);
    app.root().add(&markdown);
    markdown
}

#[test]
fn corpus_matches_core_one_shot_and_streamed() {
    let corpus = corpus();
    for case in CASES {
        let row = corpus.iter().find(|row| row[0] == format!("fixture {case}")).unwrap();
        let source = strings(&row[1])[0];
        for (mode, conceal) in [("conceal", true), ("source", false)] {
            let expected = DEVIATIONS
                .iter()
                .filter(|(name, deviation_mode, ..)| *name == case && *deviation_mode == mode)
                .fold(fixture(&format!("{case}.{mode}.txt")), |frame, (.., core, rust)| frame.replace(core, rust));
            let app = TestApp::new(60, 80);
            let oneshot = document(&app, conceal).set_markdown(source);
            assert_eq!(frame(&app), expected, "{case} ({mode}), one shot");
            assert!(oneshot.with_markdown(|shown| shown == source) && oneshot.markdown() == source);

            // Streamed in chunks, each frame equals a one-shot render of the source so far.
            let streamed_app = TestApp::new(60, 80);
            let streamed = document(&streamed_app, conceal).streaming(true);
            let mut end = 0;
            while end < source.len() {
                let next = (end + 7..=source.len()).find(|&next| source.is_char_boundary(next)).unwrap_or(source.len());
                streamed.append(&source[end..next]);
                end = next;
                let allocations = ALLOCATIONS.with(Cell::get);
                assert!(streamed.with_markdown(|shown| shown == &source[..end]), "{case} ({mode}), read at byte {end}");
                assert_eq!(ALLOCATIONS.with(Cell::get), allocations, "{case} ({mode}), read allocates");
                assert_eq!(streamed.markdown(), &source[..end]);
                let oneshot_app = TestApp::new(60, 80);
                document(&oneshot_app, conceal).set_markdown(&source[..end]);
                assert_eq!(frame(&streamed_app), frame(&oneshot_app), "{case} ({mode}), streamed to byte {end}");
            }
            streamed.streaming(false);
            assert_eq!(frame(&streamed_app), expected, "{case} ({mode}), streamed");
        }
    }
}

#[test]
fn corpus_text_matches_unless_listed() {
    // Core's Markdown test renders the same rows with the same table options: the frame after each chunk, the last
    // after streaming ends. Each frame is its own check.
    let corpus = corpus();
    let mut wrong = Vec::new();
    for row in corpus.iter().filter(|row| row.get(4).is_some()) {
        let chunks = strings(&row[1]);
        let app = TestApp::new(60, 40);
        let options = MarkdownTableOptions { width_mode: Some(ColumnWidthMode::Content), ..Default::default() };
        let markdown = Markdown::new(&app).table_options(options).streaming(chunks.len() > 1);
        app.root().add(&markdown);
        let text = strings(&row[4]);
        let fails = strings(&row[3]);
        for (index, chunk) in chunks.iter().enumerate() {
            markdown.append(chunk);
            if index + 1 == chunks.len() {
                markdown.streaming(false);
            }
            let check = format!("rust-text:{}", index + 1);
            if (frame(&app) == format!("{}\n", text[index])) == fails.contains(&check.as_str()) {
                wrong.push(format!("{}|{check}", row[0].as_str().unwrap()));
            }
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}

#[test]
fn code_block_renderers_replace_and_keep_their_widgets() {
    let app = TestApp::new(30, 8);
    let calls = Rc::new(Cell::new(0));
    let first: Rc<Cell<Option<u32>>> = Rc::default();
    let (counted, kept) = (calls.clone(), first.clone());
    let markdown = Markdown::new(&app).streaming(true).code_block_renderer("mermaid", move |block| {
        counted.set(counted.get() + 1);
        // Keep the first diagram while the fence streams, as Mermaid keeps its last good diagram.
        if let Some(previous) = block.previous {
            assert_eq!(Some(previous.id()), kept.get());
            return Some(previous.clone());
        }
        let widget: AnyWidget = Text::new(block.app, format!("diagram: {}", block.code)).as_any();
        kept.set(Some(widget.id()));
        Some(widget)
    });
    app.root().add(&markdown);
    markdown.set_markdown("```mermaid\ngraph");
    assert_eq!(frame(&app), "diagram: graph\n");
    markdown.append(" TD\n```\n\n```rust\nfn x() {}\n```");
    assert_eq!(frame(&app), "diagram: graph\n\nfn x() {}\n");
    assert_eq!(calls.get(), 2);
    assert!(first.get().is_some());
    // Removing the renderer brings back the code.
    markdown.remove_code_block_renderer("mermaid");
    assert_eq!(frame(&app), "graph TD\n\nfn x() {}\n");
}

#[test]
fn ending_the_stream_runs_code_block_renderers_again() {
    let app = TestApp::new(30, 4);
    let markdown = Markdown::new(&app).streaming(true).code_block_renderer("latex", move |block| {
        // A preview that holds only while streaming, as LaTeX keeps its last formula that parsed.
        if block.streaming {
            return block.previous.cloned().or_else(|| Some(Text::new(block.app, "preview").as_any()));
        }
        None
    });
    app.root().add(&markdown);
    markdown.set_markdown("```latex\nx +");
    assert_eq!(frame(&app), "preview\n");
    markdown.streaming(false);
    assert_eq!(frame(&app), "x +\n");
}

#[test]
fn ending_the_stream_runs_renderers_of_nested_code_blocks_again() {
    for (source, streamed, ended) in [
        ("- item\n\n  ```latex\n  x +", "- item\n\n  preview\n", "- item\n\n  x +\n"),
        ("> ```latex\n> x +", "│ preview\n", "│ x +\n"),
    ] {
        let app = TestApp::new(30, 4);
        let markdown = Markdown::new(&app).streaming(true).code_block_renderer("latex", move |block| {
            if block.streaming {
                return Some(Text::new(block.app, "preview").as_any());
            }
            None
        });
        app.root().add(&markdown);
        markdown.set_markdown(source);
        assert_eq!(frame(&app), streamed, "{source:?}");
        markdown.streaming(false);
        assert_eq!(frame(&app), ended, "{source:?}");
    }
}

#[test]
fn code_block_renderers_learn_when_the_fence_closes() {
    let app = TestApp::new(30, 4);
    let seen: Rc<RefCell<Vec<(String, bool)>>> = Rc::default();
    let record = seen.clone();
    let markdown = Markdown::new(&app).streaming(true).code_block_renderer("latex", move |block| {
        record.borrow_mut().push((block.code.to_owned(), block.closed));
        // A preview that holds only while the fence is open, as LaTeX's does.
        if block.closed {
            return None;
        }
        block.previous.cloned().or_else(|| Some(Text::new(block.app, "preview").as_any()))
    });
    app.root().add(&markdown);
    markdown.set_markdown("```latex\nx +");
    assert_eq!(frame(&app), "preview\n");
    // The closing fence leaves the code as it was, and the renderer runs again while the document still streams.
    markdown.append("\n```");
    assert_eq!(frame(&app), "x +\n");
    assert_eq!(*seen.borrow(), [("x +".to_owned(), false), ("x +".to_owned(), true)]);
}
