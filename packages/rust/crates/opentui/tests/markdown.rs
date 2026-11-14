//! Frames of the shared Markdown corpus (`packages/core/src/renderables/markdown.conformance.json`), compared with
//! the frames OpenTUI Core renders for it (`tests/fixtures/markdown/render.ts` writes the fixtures' frames).

use opentui::input::{MouseButton, MouseEventKind};
use opentui::native::Capture;
use opentui::style::{Attributes, Color, Span, Style};
use opentui::testing::TestApp;
use opentui::widget::{
    AnyWidget, ColumnWidthMode, Container, InlineContext, InlineSpan, Markdown, MarkdownExtension,
    MarkdownTableOptions, ScrollBox, Text, View, Widget,
};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::Path;
use std::rc::Rc;

#[path = "support/allocations.rs"]
mod allocations;

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

            // Streamed in chunks, each frame equals a fresh streaming document of the source so far: the last line is
            // pending in both.
            let streamed_app = TestApp::new(60, 80);
            let streamed = document(&streamed_app, conceal).streaming(true);
            let mut end = 0;
            while end < source.len() {
                let next = (end + 7..=source.len()).find(|&next| source.is_char_boundary(next)).unwrap_or(source.len());
                streamed.append(&source[end..next]);
                end = next;
                let allocations = allocations::count();
                assert!(streamed.with_markdown(|shown| shown == &source[..end]), "{case} ({mode}), read at byte {end}");
                assert_eq!(allocations::count(), allocations, "{case} ({mode}), read allocates");
                assert_eq!(streamed.markdown(), &source[..end]);
                let oneshot_app = TestApp::new(60, 80);
                document(&oneshot_app, conceal).streaming(true).set_markdown(&source[..end]);
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
        let math = row[0].as_str().unwrap().starts_with("math ");
        let extensions: &[_] = if math { &[MarkdownExtension::Math] } else { &[] };
        let markdown = Markdown::new(&app).extensions(extensions).table_options(options).streaming(chunks.len() > 1);
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
    // The other way: the default widget while streaming, the renderer's once the stream ends, though the closed
    // fence did not change.
    let app = TestApp::new(30, 4);
    let markdown = Markdown::new(&app)
        .streaming(true)
        .code_block_renderer("latex", move |block| (!block.streaming).then(|| Text::new(block.app, "done").as_any()));
    app.root().add(&markdown);
    markdown.set_markdown("```latex\nx\n```\n\ntail\n");
    assert_eq!(frame(&app), "x\n\ntail\n");
    markdown.streaming(false);
    assert_eq!(frame(&app), "done\n\ntail\n");
    // Ending the stream asks each fence's renderer once (bigboi-r2-4): an open fence, a pending closer, a nested
    // fence, and a closed fence with a tail.
    for source in ["```latex\nx", "```latex\nx\n```", "- a\n\n  ```latex\n  x", "```latex\nx\n```\n\ntail\n"] {
        let app = TestApp::new(30, 6);
        let finished = Rc::new(Cell::new(0));
        let count = finished.clone();
        let markdown = Markdown::new(&app).streaming(true).code_block_renderer("latex", move |block| {
            if block.streaming {
                return None;
            }
            count.set(count.get() + 1);
            (count.get() > 1).then(|| Text::new(block.app, "second call").as_any())
        });
        app.root().add(&markdown);
        markdown.set_markdown(source);
        markdown.streaming(false);
        assert_eq!(finished.get(), 1, "{source:?}");
        assert!(!frame(&app).contains("second call"), "{source:?}");
    }
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
    // The closing fence leaves the code as it was, and the renderer runs again while the document still streams. A
    // closer counts once its line ends: until then the line may still grow into code.
    markdown.append("\n```\n");
    assert_eq!(frame(&app), "x +\n");
    assert_eq!(*seen.borrow(), [("x +".to_owned(), false), ("x +".to_owned(), true)]);
}

#[test]
fn math_leaves_streamed_prose_to_native_code() {
    // Math changes only what the engine parses: where native code writes the text, the widget does the same work
    // for a document without math with the extension on as off.
    let allocations = |extensions: &[MarkdownExtension]| {
        let app = TestApp::with_hyperlinks(40, 8);
        let markdown = Markdown::new(&app).extensions(extensions).streaming(true);
        app.root().add(&markdown);
        let before = allocations::count();
        for chunk in ["Some ", "**bold** ", "text\n\n", "streams ", "in."] {
            markdown.append(chunk);
        }
        allocations::count() - before
    };
    assert_eq!(allocations(&[MarkdownExtension::Math]), allocations(&[]));
}

#[test]
fn math_reaches_renderers_as_code_and_hooks_as_spans() {
    // Display math is code of the language `math`, at any depth, and never reaches the hook (S3, invariant 7). Inline
    // math reaches it with its TeX, with or without conceal. Without the extension, `$` and `\(` are text.
    let app = TestApp::new(30, 8);
    let (blocks, spans, sources) = (Calls::default(), Calls::default(), Calls::default());
    let (record_block, record_span, record_source) = (blocks.clone(), spans.clone(), sources.clone());
    let markdown = Markdown::new(&app)
        .streaming(true)
        .code_block_renderer("math", move |block| {
            let seen = format!("{} {} {} {}", block.language, block.info, block.code, block.closed);
            record_block.borrow_mut().push(seen);
            Some(Text::new(block.app, format!("math: {}", block.code)).as_any())
        })
        .inline_hook(move |spans, context| {
            record_source.borrow_mut().push(context.source.to_owned());
            let math = spans.iter().filter_map(|span| Some(format!("{} {}", span.span.content, span.math.as_ref()?)));
            record_span.borrow_mut().extend(math);
            spans
        });
    app.root().add(&markdown);
    markdown.set_markdown("a $x*y$ and \\(z\\) $5\n\n> $$\n> e^x");
    assert_eq!(frame(&app), "a $x*y$ and (z) $5\n\n│ $$\n│ e^x\n");
    assert!(blocks.borrow().is_empty() && spans.borrow().is_empty());
    sources.borrow_mut().clear();
    markdown.extensions(&[MarkdownExtension::Math]);
    assert_eq!(frame(&app), "a x*y and z $5\n\n│ math: e^x\n");
    assert_eq!(*blocks.borrow(), ["math math e^x false"]);
    markdown.append("\n> $$\n");
    assert_eq!(*blocks.borrow(), ["math math e^x false", "math math e^x true"]);
    assert_eq!(*spans.borrow(), ["x*y x*y", "z z"]);
    markdown.conceal(false);
    assert_eq!(frame(&app), "a $x*y$ and \\(z\\) $5\n\n│ math: e^x\n");
    assert_eq!(spans.borrow().last_chunk(), Some(&["$x*y$ x*y".to_owned(), "\\(z\\) z".to_owned()]));
    markdown.append("\n| \\(t\\) |\n| - |\n");
    assert_eq!(spans.borrow().last().map(String::as_str), Some("\\(t\\) t"));
    assert!(sources.borrow().iter().all(|source| !source.contains("e^x")), "{:?}", sources.borrow());
    // Off again, `$` and `\(` are text again.
    markdown.conceal(true).extensions(&[]);
    assert!(frame(&app).starts_with("a $x*y$ and (z) $5\n\n│ $$\n│ e^x\n"), "{}", frame(&app));
}

fn inline_span(text: Span<'static>, code: bool, target: Option<&str>) -> InlineSpan {
    let mut span = InlineSpan::from(text);
    (span.code, span.target) = (code, target.map(str::to_owned));
    span
}

type Titles = Rc<RefCell<HashMap<&'static str, &'static str>>>;
type Calls = Rc<RefCell<Vec<String>>>;

/// An inline hook like OpenCode's session links: a mention of a known ID, `ses_…` alone or after `@session:`, shows
/// as `@title` in the link style, or as written without conceal, and clicks through to the ID. A code span takes
/// part only when it is exactly an ID, so a command that holds one stays as written. `calls` gets the source of each
/// block the hook sees.
fn session_links(
    titles: &Titles,
    calls: &Calls,
) -> impl Fn(Vec<InlineSpan>, &InlineContext<'_>) -> Vec<InlineSpan> + use<> {
    let (titles, calls) = (titles.clone(), calls.clone());
    move |spans, context| {
        calls.borrow_mut().push(context.source.to_owned());
        let link = context.syntax.get("markup.link.url").unwrap_or(Style::new()).underline();
        let mut out = Vec::new();
        for span in spans {
            let text = span.span.content.to_string();
            let inner = text.trim_matches('`');
            if span.span.link.is_some() || span.code && !(inner.starts_with("ses_") && !inner.contains(' ')) {
                out.push(span);
                continue;
            }
            let (style, code) = (span.span.style, span.code);
            let piece =
                |text: &str, style: Style, target| inline_span(Span::styled(text.to_owned(), style), code, target);
            let mut rest = text.as_str();
            while let Some(found) = rest.find("ses_") {
                let end = rest[found..]
                    .find(|c: char| !c.is_alphanumeric() && c != '_')
                    .map_or(rest.len(), |end| found + end);
                let start = if rest[..found].ends_with("@session:") { found - "@session:".len() } else { found };
                let id = &rest[found..end];
                match titles.borrow().get(id) {
                    Some(title) => {
                        out.push(piece(&rest[..start], style, None));
                        let shown = if context.conceal { format!("@{title}") } else { rest[start..end].to_owned() };
                        out.push(piece(&shown, style.patch(link), Some(id)));
                    }
                    None => out.push(piece(&rest[..end], style, None)),
                }
                rest = &rest[end..];
            }
            out.push(piece(rest, style, None));
        }
        out.retain(|span| !span.span.content.is_empty());
        out
    }
}

/// The display column of the first `needle` in row `y` of the last frame, where CJK characters take two columns.
fn column(app: &TestApp, y: u16, needle: &str) -> u16 {
    let row = app.render().row(u32::from(y));
    let byte = row.find(needle).unwrap_or_else(|| panic!("{needle:?} not in {row:?}"));
    row[..byte].chars().map(|c| if c.is_ascii() { 1 } else { 2 }).sum()
}

#[test]
fn inline_hooks_rewrite_prose_but_not_code_or_renderers() {
    let app = TestApp::new(50, 24);
    let titles: Titles = Rc::new(RefCell::new(HashMap::from([("ses_known", "Known")])));
    let calls = Calls::default();
    let markdown = Markdown::new(&app)
        .code_block_renderer("mermaid", |block| Some(Text::new(block.app, format!("diagram {}", block.code)).as_any()))
        .inline_hook(session_links(&titles, &calls));
    app.root().add(&markdown);
    markdown.set_markdown(concat!(
        "# Plan ses_known\n\n",
        "See ses_known, @session:ses_known and ses_other.\n\n",
        "- run `opencode -s ses_known` or `ses_known`\n\n",
        "> ses_known\n\n",
        "```\nses_known\n```\n\n",
        "```mermaid\nses_known\n```",
    ));
    assert_eq!(
        frame(&app),
        "Plan @Known\n\nSee @Known, @Known and ses_other.\n\n- run opencode -s ses_known or @Known\n\n│ @Known\n\n\
         ses_known\n\ndiagram ses_known\n"
    );
    assert_eq!(
        *calls.borrow(),
        [
            "Plan ses_known",
            "See ses_known, @session:ses_known and ses_other.",
            "run `opencode -s ses_known` or `ses_known`",
            "ses_known"
        ]
    );
}

#[test]
fn inline_hooks_rewrite_table_cells_without_targets() {
    let app = TestApp::new(20, 8);
    let titles: Titles = Rc::new(RefCell::new(HashMap::from([("ses_a", "A")])));
    let calls = Calls::default();
    let markdown = Markdown::new(&app).streaming(true).inline_hook(session_links(&titles, &calls));
    app.root().add(&markdown);
    markdown.append("| id |\n| -- |\n| ses_a |");
    let table = |rows: &[&str]| {
        let rows: Vec<String> = ["id"].iter().chain(rows).map(|row| format!("│{row:<18}│\n")).collect();
        format!("┌──────────────────┐\n{}└──────────────────┘\n", rows.join("├──────────────────┤\n"))
    };
    assert_eq!(frame(&app), table(&["@A"]));
    // A cell draws the hook's text but gives no click target.
    assert_eq!(markdown.target_at(1, 3), None);
    // A streamed row's cells go through the hook as they arrive.
    markdown.append("\n| ses_a too |");
    assert_eq!(frame(&app), table(&["@A", "@A too"]));
    // A re-run reaches the cells whose source it selects.
    titles.borrow_mut().insert("ses_a", "B");
    calls.borrow_mut().clear();
    markdown.rerun_inline_hook(|source| source.contains("ses_a"));
    assert_eq!(frame(&app), table(&["@B", "@B too"]));
    assert_eq!(*calls.borrow(), ["id", "ses_a", "ses_a too"]);
    // Without the hook, cells show their own text again.
    markdown.remove_inline_hook();
    assert_eq!(frame(&app), table(&["ses_a", "ses_a too"]));
}

#[test]
fn the_inline_context_says_which_spans_are_table_cells() {
    let app = TestApp::new(20, 16);
    let seen: Rc<RefCell<Vec<(String, bool)>>> = Rc::default();
    // The hook may read the whole document while it runs.
    let document: Rc<RefCell<Option<Markdown>>> = Rc::default();
    let (record, read) = (seen.clone(), document.clone());
    let markdown = Markdown::new(&app).streaming(true).inline_hook(move |spans, context| {
        let whole = read.borrow().as_ref().map(Markdown::markdown).unwrap_or_default();
        assert!(whole.starts_with("# Title\n\nText") && whole.contains(context.source), "{whole:?}");
        record.borrow_mut().push((context.source.to_owned(), context.table_cell));
        spans
    });
    *document.borrow_mut() = Some(markdown.clone());
    app.root().add(&markdown);
    markdown.append("# Title\n\nText\n\n- item\n\n> quote\n\n| id |\n| -- |\n| cell |");
    // A streamed row refills the table; a re-run reaches a quote and a table.
    markdown.append("\n| more |");
    markdown.rerun_inline_hook(|source| source == "quote" || source == "more");
    let (prose, cell) = (false, true);
    let expected = [
        ("Title", prose),
        ("Text", prose),
        ("item", prose),
        ("quote", prose),
        ("id", cell),
        ("cell", cell),
        ("id", cell),
        ("cell", cell),
        ("more", cell),
        ("quote", prose),
        ("id", cell),
        ("cell", cell),
        ("more", cell),
    ];
    assert_eq!(*seen.borrow(), expected.map(|(source, cell)| (source.to_owned(), cell)));
    document.borrow_mut().take();
}

#[test]
fn streamed_text_runs_the_inline_hook_once_per_changed_block() {
    let app = TestApp::new(40, 8);
    let titles: Titles = Rc::new(RefCell::new(HashMap::from([("ses_a", "A"), ("ses_b", "B")])));
    let calls = Calls::default();
    let markdown = Markdown::new(&app).streaming(true).inline_hook(session_links(&titles, &calls));
    app.root().add(&markdown);
    for chunk in ["First ses_a\n\nSec", "ond ses_b", "\n\nThird"] {
        markdown.append(chunk);
    }
    markdown.streaming(false);
    assert_eq!(*calls.borrow(), ["First ses_a", "Sec", "Second ses_b", "Third"]);
    assert_eq!(frame(&app), "First @A\n\nSecond @B\n\nThird\n");
    // The block that changed in place keeps the targets of its last change.
    assert_eq!(markdown.target_at(column(&app, 2, "@B"), 2).as_deref(), Some("ses_b"));
}

#[test]
fn clicks_on_hook_targets_reach_the_app_without_hyperlinks() {
    let app = TestApp::new(24, 6);
    let titles: Titles = Rc::new(RefCell::new(HashMap::from([("ses_known", "Fix the flaky reconnect test")])));
    let markdown = Markdown::new(&app).inline_hook(session_links(&titles, &Calls::default()));
    app.root().add(&markdown);
    markdown.set_markdown("**中文** see ses_known now <https://x.test>");
    let clicked: Rc<RefCell<Option<String>>> = Rc::default();
    // The app owns the document; its own handler holds it weakly, so a removed message does not outlive the screen.
    let owner = Rc::new(markdown.clone());
    let (seen, doc) = (clicked.clone(), Rc::downgrade(&owner));
    markdown.on_mouse(move |_, event| {
        if event.kind == MouseEventKind::Up(MouseButton::Left)
            && let Some(doc) = doc.upgrade()
        {
            *seen.borrow_mut() = doc.target_at(event.x, event.y);
        }
    });
    assert_eq!(frame(&app), "中文 see @Fix the flaky\nreconnect test now\nhttps://x.test\n");
    // The title wraps: either row opens the session, the text around it does not, and the URL stays a hyperlink.
    let (head, tail, url) = (column(&app, 0, "@Fix"), column(&app, 1, "test"), column(&app, 2, "https"));
    let id = Some("ses_known");
    for (x, y, target) in [(head - 1, 0, None), (head, 0, id), (tail + 3, 1, id), (tail + 4, 1, None), (url, 2, None)] {
        app.click(x, y);
        assert_eq!(clicked.take().as_deref(), target, "click at {x}, {y}");
    }
    let session = app.app().session();
    assert_eq!(session.link_id(i32::from(head), 0).unwrap(), None);
    assert!(session.link_id(i32::from(url), 2).unwrap().is_some());
    // Selection copies the text shown.
    app.drag((column(&app, 0, "see"), 0), (head + 3, 0));
    assert_eq!(app.app().selected_text().as_deref(), Some("see @Fix"));
    drop(owner);
}

#[test]
fn selecting_a_wrapped_fence_line_copies_the_line() {
    let app = TestApp::new(24, 4);
    let markdown = Markdown::new(&app);
    app.root().add(&markdown);
    markdown.set_markdown("> ```sh\n> one two three four five six\n> ```\n");
    assert_eq!(frame(&app), "│ one two three four\n│ five six\n");
    app.drag((2, 0), (9, 1));
    assert_eq!(app.app().selected_text().as_deref(), Some("one two three four five six"));
}

/// Checks [`Markdown::target_at`] at every cell of `capture`: a cell answers exactly when it draws an underlined
/// grapheme, which the hooks here give only target spans, and then with `id` of the cell's row.
fn assert_targets(capture: &Capture, markdown: &Markdown, id: impl Fn(&str) -> &'static str) {
    for (y, x) in (0..capture.height).flat_map(|y| (0..capture.width).map(move |x| (y, x))) {
        let linked = capture.cell(x, y).unwrap().attributes.contains(Attributes::UNDERLINE);
        let expected = linked.then(|| id(&capture.row(y)));
        assert_eq!(markdown.target_at(x as u16, y as u16).as_deref(), expected, "cell {x}, {y}\n{}", capture.text());
    }
}

#[test]
fn targets_answer_only_where_the_last_frame_drew_them() {
    let titles: Titles = Rc::new(RefCell::new(HashMap::from([
        ("ses_a", "LongSessionTitle"),
        ("ses_b", "SecondLink"),
        ("ses_cjk", "中文タイトル"),
        ("ses_kana", "中文タイト"),
        ("ses_top", "TopLink"),
        ("ses_mid", "MidLink"),
        ("ses_bot", "BotLink"),
    ])));
    let hooked = |app: &TestApp| Markdown::new(app).inline_hook(session_links(&titles, &Calls::default()));
    // Wrap padding before and after a wrapped title, and the gap a wide character leaves, have no target, and the
    // padding at the end of one title's row does not reach the next title.
    let app = TestApp::new(12, 6);
    let markdown = hooked(&app).set_markdown("hi ses_a ses_b");
    app.root().add(&markdown);
    let capture = app.render();
    assert_eq!(capture.text(), "hi\n@LongSession\nTitle\n@SecondLink\n\n");
    assert_targets(&capture, &markdown, |row| if row.contains("Second") { "ses_b" } else { "ses_a" });
    // The blank right after a wrapped wide glyph has no target either.
    for (id, last) in [("ses_cjk", "トル"), ("ses_kana", "ト")] {
        let app = TestApp::new(10, 4);
        let markdown = hooked(&app).set_markdown(format!("1234567:{id}"));
        app.root().add(&markdown);
        let capture = app.render();
        assert_eq!(capture.text(), format!("1234567:\n@中文タイ\n{last}\n"));
        assert_targets(&capture, &markdown, |_| id);
    }

    // Rows a scroll box clips, cells an overlay covers, and moves not painted yet answer as the screen shows.
    let app = TestApp::new(24, 8);
    let markdown = hooked(&app).set_markdown("ses_top\n\nplain\n\nses_mid\n\nses_bot");
    let scroll = ScrollBox::new(&app).height(4).child(&markdown);
    app.root()
        .add(&Text::new(&app, "HEADER ROW 0\nHEADER ROW 1"))
        .add(&scroll)
        .add(&Text::new(&app, "FOOTER ROW 6\nFOOTER ROW 7"));
    scroll.scroll_to(0.0, 1.0);
    let capture = app.render();
    let row = |row: &str| match row.trim_end() {
        "@MidLink" => "ses_mid",
        "@BotLink" => "ses_bot",
        _ => "ses_top",
    };
    assert_targets(&capture, &markdown, row);
    scroll.scroll_to(0.0, 3.0);
    assert_targets(&capture, &markdown, row);
    let overlay = View::new(&app).absolute().width(24).height(8).bg(Color::BLACK);
    app.root().add(&overlay);
    let covered = app.render();
    assert_targets(&covered, &markdown, |_| "none");

    // A fractional translation moves text by whole cells, as native code paints it.
    let app = TestApp::new(12, 4);
    let markdown = hooked(&app).set_markdown("ses_top\nses_mid");
    app.root().add(&View::new(&app).translate(0.6, 0.6).child(&markdown));
    let capture = app.render();
    assert_targets(&capture, &markdown, |row| if row.contains("@Top") { "ses_top" } else { "ses_mid" });

    // Until a frame shows replaced text, its new targets do not answer.
    let app = TestApp::new(12, 2);
    let markdown = hooked(&app).set_markdown("ses_top");
    app.root().add(&markdown);
    let shown = app.render();
    markdown.set_markdown("ses_bot");
    assert_eq!(markdown.target_at(0, 0), None, "{}", shown.text());
    let capture = app.render();
    assert_targets(&capture, &markdown, |_| "ses_bot");

    // Equal text for another target: the painted target answers until a frame paints the new one.
    let same: Titles =
        Rc::new(RefCell::new(HashMap::from([("ses_top", "Same"), ("ses_mid", "Same"), ("ses_bot", "Same")])));
    let app = TestApp::new(12, 2);
    let markdown = Markdown::new(&app).inline_hook(session_links(&same, &Calls::default())).set_markdown("ses_top");
    app.root().add(&markdown);
    app.render();
    markdown.set_markdown("ses_mid").set_markdown("ses_bot");
    assert_eq!(markdown.target_at(0, 0).as_deref(), Some("ses_top"));
    // Only the targets changed, and a frame comes to paint them.
    assert!(app.needs_frame());
    let capture = app.render();
    assert_targets(&capture, &markdown, |_| "ses_bot");

    // An update from a resize handler, inside the frame, answers for what that frame shows.
    let app = TestApp::new(12, 2);
    let markdown = hooked(&app);
    let (doc, first) = (markdown.clone(), Cell::new(true));
    let parent = View::new(&app).child(&markdown).on_resize(move |_, _| {
        doc.set_markdown(if first.replace(false) { "ses_top" } else { "ses_mid" });
    });
    app.root().add(&parent);
    for (width, id) in [(12, "ses_top"), (10, "ses_mid")] {
        app.resize(width, 2);
        let capture = app.render();
        assert_targets(&capture, &markdown, |_| id);
        assert!(capture.text().starts_with('@'), "{}", capture.text());
    }
}

#[test]
fn targets_count_bytes_as_the_hook_returned_them() {
    // A hook's CRLF stays in the text native code holds, so the target after it lines up.
    let app = TestApp::new(20, 3);
    let markdown = Markdown::new(&app).inline_hook(|_, _| {
        let target = inline_span(Span::styled("@Known", Style::new().underline()), false, Some("ses_a"));
        vec![Span::raw("hi\r\n").into(), target, Span::raw(" plain").into()]
    });
    markdown.set_markdown("anything");
    app.root().add(&markdown);
    let capture = app.render();
    assert_eq!(capture.text(), "hi\n@Known plain\n");
    assert_targets(&capture, &markdown, |_| "ses_a");
}

#[test]
fn rerunning_the_inline_hook_touches_only_selected_blocks() {
    let app = TestApp::new(30, 14);
    let titles: Titles = Rc::new(RefCell::new(HashMap::from([("ses_a", "A"), ("ses_b", "B")])));
    let calls = Calls::default();
    // The hook arrives after the content, and the quote's link sits on its second line, indented.
    let markdown = Markdown::new(&app).set_markdown(
        "## Head ses_a\n\nFirst ses_a\n\nSecond ses_b\n\n> first\n> ses_a\n\n- item ses_a\n\n```\nses_a\n```",
    );
    app.root().add(&markdown);
    markdown.inline_hook(session_links(&titles, &calls));
    let id = |row: &str| if row.contains("@B") { "ses_b" } else { "ses_a" };
    let capture = app.render();
    assert_eq!(capture.text().trim_end(), "Head @A\n\nFirst @A\n\nSecond @B\n\n│ first\n│ @A\n\n- item @A\n\nses_a");
    assert_targets(&capture, &markdown, id);
    calls.borrow_mut().clear();
    titles.borrow_mut().insert("ses_a", "Renamed");
    markdown.rerun_inline_hook(|source| source.contains("ses_a"));
    assert_eq!(*calls.borrow(), ["Head ses_a", "First ses_a", "first\nses_a", "item ses_a"]);
    let capture = app.render();
    assert_eq!(
        capture.text().trim_end(),
        "Head @Renamed\n\nFirst @Renamed\n\nSecond @B\n\n│ first\n│ @Renamed\n\n- item @Renamed\n\nses_a"
    );
    assert_targets(&capture, &markdown, id);
    // Without the hook, the blocks show their own text again and nothing answers.
    markdown.remove_inline_hook();
    let capture = app.render();
    assert_eq!(capture.row(0).trim_end(), "Head ses_a");
    assert_targets(&capture, &markdown, |_| "none");
}

#[test]
fn a_hook_shows_its_inputs_and_its_targets_go_with_it() {
    // A hook that shows the inline source: a new source with the same display shows.
    let app = TestApp::new(20, 2);
    let markdown = Markdown::new(&app).inline_hook(|_, context| vec![Span::raw(context.source.to_owned()).into()]);
    app.root().add(&markdown);
    markdown.set_markdown("*hi*");
    assert_eq!(frame(&app), "*hi*\n");
    markdown.set_markdown("_hi_");
    assert_eq!(frame(&app), "_hi_\n");
    // Where native code writes the text (a terminal with hyperlinks), the hook's targets go with the hook.
    let app = TestApp::with_hyperlinks(20, 2);
    let markdown = Markdown::new(&app).inline_hook(|_, _| vec![inline_span(Span::raw("hello"), false, Some("old"))]);
    app.root().add(&markdown);
    markdown.set_markdown("hi");
    assert_eq!(frame(&app), "hello\n");
    assert_eq!(markdown.target_at(1, 0).as_deref(), Some("old"));
    markdown.remove_inline_hook();
    assert_eq!(frame(&app), "hi\n");
    assert_eq!(markdown.target_at(1, 0), None);
}

/// Sets up the session's terminal and drains its setup output, as a terminal that has not replied yet.
fn activate_terminal(session: &opentui::native::Session) {
    use opentui::native::{Pump, TerminalOptions};
    session.setup_terminal(TerminalOptions::default()).unwrap();
    let mut now = 0;
    for _ in 0..4096 {
        match session.pump(now, 1).unwrap() {
            Pump::Idle | Pump::Closed => break,
            Pump::Again => {}
            Pump::WaitUntil(deadline) => now = deadline,
            Pump::OutputPending => {
                let mut bytes = [0; 4096];
                let ticket = session.read_output(&mut bytes).unwrap().expect("pending output");
                session.complete_output(ticket, true).unwrap();
            }
        }
    }
}

#[test]
fn an_option_change_after_a_hyperlink_reply_keeps_text_coming() {
    // bigboi-r2-3: the terminal reports hyperlinks while the document streams; the next option change must send
    // the flags it decides, so native code and the widget agree who writes the text.
    let app = TestApp::new(30, 2);
    let session = app.app().session();
    activate_terminal(session);
    let markdown = Markdown::new(&app).streaming(true).inline_hook(|spans, _| spans);
    app.root().add(&markdown);
    markdown.set_markdown("first");
    assert_eq!(frame(&app), "first\n");
    session.control(opentui::native::Control::CapabilityResponse(b"\x1bP>|ghostty 1.3.1\x1b\\")).unwrap();
    assert!(session.capabilities().unwrap().flags.contains(opentui::native::CapabilityFlags::HYPERLINKS));
    markdown.remove_inline_hook().append(" second");
    assert_eq!(frame(&app), "first second\n");
}

#[test]
fn a_conceal_round_trip_shows_what_a_fresh_widget_shows() {
    // The math run's repro: the rebuild after conceal turned on again attached the paragraph's text anew, and it
    // kept the source form the widget had written (`` ```word ```mermaid ``).
    let app = TestApp::with_hyperlinks(40, 8);
    let subject = Markdown::new(&app);
    app.root().add(&subject);
    subject.append("```").append("word ").append("```mermaid\n");
    subject.conceal(false).append("- x ").conceal(true);
    let fresh_app = TestApp::with_hyperlinks(40, 8);
    let fresh = Markdown::new(&fresh_app);
    fresh_app.root().add(&fresh);
    fresh.set_markdown(subject.markdown());
    assert_eq!(frame(&app), frame(&fresh_app));
    assert!(app.render() == fresh_app.render(), "styles");
}

#[test]
fn rerunning_without_a_hook_builds_nothing() {
    let app = TestApp::new(30, 6);
    let built = Rc::new(Cell::new(0));
    let count = built.clone();
    let markdown = Markdown::new(&app).code_block_renderer("mermaid", move |block| {
        count.set(count.get() + 1);
        Some(Text::new(block.app, "diagram").as_any())
    });
    app.root().add(&markdown);
    markdown.set_markdown("- item ses_a\n\n  ```mermaid\n  g\n  ```");
    assert_eq!(built.get(), 1);
    markdown.rerun_inline_hook(|_| true);
    assert_eq!(built.get(), 1);
    // With a hook, the list holding a selected paragraph is built again, with its code block.
    markdown.inline_hook(|spans, _| spans).rerun_inline_hook(|_| true);
    assert_eq!(built.get(), 3);
}

#[test]
fn inline_hooks_keep_source_mode() {
    // A hook that returns its spans leaves every frame as it was, in both modes.
    let corpus = corpus();
    let source = strings(&corpus.iter().find(|row| row[0] == "fixture links").unwrap()[1])[0];
    for conceal in [true, false] {
        let (plain, hooked) = (TestApp::new(60, 80), TestApp::new(60, 80));
        document(&plain, conceal).set_markdown(source.trim());
        document(&hooked, conceal).inline_hook(|spans, _| spans).set_markdown(source.trim());
        assert_eq!(frame(&hooked), frame(&plain), "conceal {conceal}");
    }
    // Without conceal, the session hook keeps the source and styles only the mentions it links.
    let app = TestApp::new(60, 2);
    let titles: Titles = Rc::new(RefCell::new(HashMap::from([("ses_known", "Known")])));
    document(&app, false)
        .inline_hook(session_links(&titles, &Calls::default()))
        .set_markdown("Open `ses_known` or @session:ses_known.");
    let capture = app.render();
    assert_eq!(capture.row(0).trim_end(), "Open `ses_known` or @session:ses_known.");
    let underlined: Vec<u32> =
        (0..60).filter(|&x| capture.cell(x, 0).unwrap().attributes.contains(Attributes::UNDERLINE)).collect();
    assert_eq!(underlined, (6..15).chain(20..38).collect::<Vec<_>>());
}

#[path = "support/model.rs"]
mod model;

/// What the model does to the document under test (the subject).
#[derive(Clone, Debug)]
enum Command {
    Append(&'static str),
    /// A replace with the first `keep` bytes of the source, as OpenCode's `trim()` does.
    Set(usize),
    /// A replace with the source and more, as a caller that sets the whole streamed text each time does.
    Extend(&'static str),
    Streaming(bool),
    Conceal(bool),
    /// Theme changes: scope styles, and the other colors.
    Scopes(bool),
    Colors(bool),
    Renderer(bool),
    Hook(bool),
    Math(bool),
    /// The hook again on every block; its titles never change, so nothing may.
    Rerun,
}

/// Pieces the generator glues together: block starts, inline markers, IDs the hook links, and line endings.
const PIECES: [&str; 35] = [
    "$",
    "$$\n",
    "\\(",
    "- ",
    "> ",
    "```",
    "```mermaid\n",
    "```\n",
    "| a | b |\n",
    "| - | - |\n",
    "|",
    "[x](/u)",
    "[x]: /u\n",
    "**",
    "*",
    "_",
    "`",
    "1. ",
    "10. ",
    "===",
    "---",
    "\n",
    "\n\n",
    "word ",
    "ses_a",
    " ses_b ",
    "# ",
    "<div>",
    "&amp;",
    "\\",
    "    code",
    "~~",
    "www.a.b ",
    "- [x] ",
    "é",
];

/// The options a document has, which its fresh twin takes too.
#[derive(Clone, Copy, Default)]
struct Settings {
    streaming: bool,
    source_mode: bool,
    scopes: bool,
    other_colors: bool,
    renderer: bool,
    hook: bool,
    math: bool,
}

/// Sets every setting on a fresh document.
fn configure(markdown: &Markdown, settings: Settings) {
    for command in [
        Command::Conceal(settings.source_mode),
        Command::Scopes(settings.scopes),
        Command::Colors(settings.other_colors),
        Command::Renderer(settings.renderer),
        Command::Hook(settings.hook),
        Command::Math(settings.math),
        Command::Streaming(settings.streaming),
    ] {
        configure_one(markdown, &command, settings);
    }
}

/// Sets the one setting `command` changes, as an app does, so a change reaches the subject alone.
fn configure_one(markdown: &Markdown, command: &Command, settings: Settings) {
    let titles: Titles = Rc::new(RefCell::new(HashMap::from([("ses_a", "Alpha"), ("ses_b", "Beta")])));
    match command {
        Command::Conceal(_) => drop(markdown.conceal(!settings.source_mode)),
        Command::Scopes(_) => drop(markdown.scope_styles(settings.scopes)),
        Command::Colors(_) => configure_colors(markdown, settings),
        Command::Renderer(_) => configure_renderer(markdown, settings),
        Command::Hook(_) if settings.hook => drop(markdown.inline_hook(session_links(&titles, &Calls::default()))),
        Command::Hook(_) => drop(markdown.remove_inline_hook()),
        Command::Math(_) => drop(markdown.extensions(if settings.math { &[MarkdownExtension::Math] } else { &[] })),
        Command::Streaming(_) => drop(markdown.streaming(settings.streaming)),
        _ => {}
    }
}

fn configure_colors(markdown: &Markdown, settings: Settings) {
    if settings.other_colors {
        let theme = opentui::theme::Theme::default();
        let colors = opentui::widget::MarkdownColors {
            heading: Color::rgb(200, 20, 20),
            code_bg: Color::rgb(10, 10, 60),
            ..opentui::widget::MarkdownColors::from_theme(&theme)
        };
        markdown.colors(colors);
    } else {
        markdown.colors(opentui::widget::MarkdownColors::from_theme(&opentui::theme::Theme::default()));
    }
}

fn configure_renderer(markdown: &Markdown, settings: Settings) {
    if settings.renderer {
        markdown.code_block_renderer("mermaid", |block| {
            Some(Text::new(block.app, format!("diagram {}", block.code)).as_any())
        });
    } else {
        markdown.remove_code_block_renderer("mermaid");
    }
}

/// The model's terminal shows hyperlinks or not: native code writes the text, or the widget does.
struct MarkdownModel {
    hyperlinks: bool,
}

impl MarkdownModel {
    fn app(&self) -> TestApp {
        if self.hyperlinks { TestApp::with_hyperlinks(40, 24) } else { TestApp::new(40, 24) }
    }
}

impl model::Model for MarkdownModel {
    type Command = Command;

    fn generate(&self, rng: &mut model::Rng, steps: usize) -> Vec<Command> {
        (0..steps)
            .map(|_| match rng.below(24) {
                0 => Command::Set(rng.below(64)),
                1 => Command::Streaming(rng.below(2) == 0),
                2 => Command::Conceal(rng.below(4) == 0),
                3 => Command::Scopes(rng.below(2) == 0),
                4 => Command::Colors(rng.below(2) == 0),
                5 => Command::Renderer(rng.below(2) == 0),
                6 => Command::Hook(rng.below(2) == 0),
                7 => Command::Rerun,
                9 => Command::Math(rng.below(2) == 0),
                8 => Command::Extend(rng.pick(&PIECES)),
                _ => Command::Append(rng.pick(&PIECES)),
            })
            .collect()
    }

    fn simplify(&self, command: &Command) -> Vec<Command> {
        match command {
            Command::Set(keep) if *keep > 0 => vec![Command::Set(keep / 2)],
            Command::Append(piece) if *piece != "word " => vec![Command::Append("word ")],
            Command::Extend(piece) => vec![Command::Append(piece)],
            _ => Vec::new(),
        }
    }

    /// After every command: the document's frame, colors and attributes included, equals a fresh document's given the
    /// same source and options (P1 at widget level, P6 with spans), and so does every cell's click target (P16). A
    /// theme change changes no text (P11: it parses and writes nothing). A rerun of an unchanged hook changes nothing.
    fn run(&self, commands: &[Command]) -> Option<model::Failure> {
        let app = self.app();
        let subject = Markdown::new(&app);
        app.root().add(&subject);
        let mut settings = Settings::default();
        configure(&subject, settings);
        for (step, command) in commands.iter().enumerate() {
            let fail = |property| Some(model::Failure { property, step });
            let before = app.render();
            match *command {
                Command::Append(piece) => drop(subject.append(piece)),
                Command::Extend(piece) => drop(subject.set_markdown(subject.markdown() + piece)),
                Command::Set(keep) => {
                    let source = subject.markdown();
                    let keep = (0..=keep.min(source.len())).rev().find(|&at| source.is_char_boundary(at)).unwrap_or(0);
                    subject.set_markdown(&source[..keep]);
                }
                Command::Streaming(on) => settings.streaming = on,
                Command::Conceal(off) => settings.source_mode = off,
                Command::Scopes(on) => settings.scopes = on,
                Command::Colors(on) => settings.other_colors = on,
                Command::Renderer(on) => settings.renderer = on,
                Command::Hook(on) => settings.hook = on,
                Command::Math(on) => settings.math = on,
                Command::Rerun => drop(subject.rerun_inline_hook(|_| true)),
            }
            configure_one(&subject, command, settings);
            let shown = app.render();
            if matches!(command, Command::Scopes(_) | Command::Colors(_) | Command::Rerun)
                && shown.text() != before.text()
            {
                return fail("theme or rerun changes no text (P11)");
            }
            let twin_app = self.app();
            let twin = Markdown::new(&twin_app);
            twin_app.root().add(&twin);
            configure(&twin, settings);
            twin.set_markdown(subject.markdown());
            let fresh = twin_app.render();
            if shown != fresh {
                eprintln!("subject:\n{}\nfresh:\n{}", shown.text(), fresh.text());
                return fail("frame equals a fresh document's, spans included (P1, P6)");
            }
            // With or without a hook: a removed hook's targets go too.
            for (x, y) in (0..24u16).flat_map(|y| (0..40u16).map(move |x| (x, y))) {
                if subject.target_at(x, y) != twin.target_at(x, y) {
                    return fail("click targets equal a fresh document's (P16)");
                }
            }
        }
        None
    }
}

#[test]
fn model_streamed_documents_equal_fresh_ones() {
    // CI budget: 48 seeds of 24 commands; MODEL_SEEDS widens it.
    model::check(&MarkdownModel { hyperlinks: false }, 48, 24);
}

#[test]
fn model_streamed_documents_equal_fresh_ones_where_native_code_writes_the_text() {
    model::check(&MarkdownModel { hyperlinks: true }, 48, 24);
}

#[test]
fn model_every_three_ownership_changes_equal_a_fresh_document() {
    // bigboi's ownership model: who writes the text and who owns the targets, after every sequence of three.
    let alphabet = [
        Command::Hook(true),
        Command::Hook(false),
        Command::Rerun,
        Command::Streaming(false),
        Command::Set(0),
        Command::Append("ses_a word "),
        Command::Conceal(false),
        Command::Conceal(true),
    ];
    for hyperlinks in [false, true] {
        model::check_exhaustive(&MarkdownModel { hyperlinks }, &alphabet, 3);
    }
}

/// The math soup of markdown-highlight-ssot-models.md (S3), and `|`, which holds a streamed line that may be a
/// table's header.
const MATH_PIECES: [&str; 16] =
    ["$", "$$", "\\(", "\\)", "\\[", "\\]", "\\$", "`", "5", "x", " ", "\n", "**", "<", "](", "|"];

/// The inline math a fresh document of `source` shows: for each span, its paragraph or heading in document order,
/// where it starts in its text (without conceal, the source), and its TeX.
fn math_spans(source: &str, streaming: bool, conceal: bool) -> Vec<(usize, usize, String)> {
    let app = TestApp::new(40, 24);
    let found: Rc<RefCell<Vec<(usize, usize, String)>>> = Rc::default();
    let (record, leaves) = (found.clone(), Cell::new(0));
    let markdown = Markdown::new(&app).extensions(&[MarkdownExtension::Math]).conceal(conceal).streaming(streaming);
    markdown.inline_hook(move |spans, _| {
        let leaf = leaves.replace(leaves.get() + 1);
        let mut at = 0;
        for span in &spans {
            if let Some(tex) = &span.math {
                record.borrow_mut().push((leaf, at, tex.clone()));
            }
            at += span.span.content.len();
        }
        spans
    });
    app.root().add(&markdown);
    markdown.set_markdown(source);
    found.take()
}

/// S3's property for `source` streamed in chunks that end at `ends`: the math shown after each code point is still
/// shown, the same, after every later one and once the document ends (P17: a span changes at most once and never
/// reverts, so a `$` is never shown as math before it is decided); each streamed frame equals a fresh streaming
/// document's of the text so far, where native code writes the text (invariant 4); the ended stream's frame equals
/// one shot's. With `agree`, conceal on and off show the same math too. The failing check and the end of the text it
/// failed at.
fn math_streams_like_fresh_documents(source: &str, ends: &[usize], agree: bool) -> Option<(&'static str, usize)> {
    let tex =
        |spans: Vec<(usize, usize, String)>| spans.into_iter().map(|(leaf, _, tex)| (leaf, tex)).collect::<Vec<_>>();
    let mut shown = Vec::new();
    for end in (1..=source.len()).filter(|&end| source.is_char_boundary(end)) {
        let now = math_spans(&source[..end], true, false);
        if !shown.iter().all(|span| now.contains(span)) {
            return Some(("math never reverts (P17)", end));
        }
        if agree && tex(now.clone()) != tex(math_spans(&source[..end], true, true)) {
            return Some(("conceal on and off show the same math", end));
        }
        shown = now;
    }
    let ended = math_spans(source, false, false);
    if !shown.iter().all(|span| ended.contains(span)) {
        return Some(("math never reverts (P17)", source.len()));
    }
    let document = |app: &TestApp| {
        let markdown = Markdown::new(app).extensions(&[MarkdownExtension::Math]);
        app.root().add(&markdown);
        markdown
    };
    let app = TestApp::with_hyperlinks(40, 24);
    let streamed = document(&app).streaming(true);
    let mut start = 0;
    for &end in ends {
        streamed.append(&source[start..end]);
        start = end;
        let twin = TestApp::with_hyperlinks(40, 24);
        document(&twin).streaming(true).set_markdown(&source[..end]);
        if app.render() != twin.render() {
            return Some(("streamed frame equals a fresh streaming one (invariant 4)", end));
        }
    }
    streamed.streaming(false);
    let oneshot = TestApp::with_hyperlinks(40, 24);
    document(&oneshot).set_markdown(source);
    (app.render() != oneshot.render()).then_some(("ended stream equals one shot", source.len()))
}

fn chunk_ends(chunks: &[&str]) -> Vec<usize> {
    let mut end = 0;
    chunks
        .iter()
        .map(|chunk| {
            end += chunk.len();
            end
        })
        .collect()
}

#[test]
fn math_rows_stream_like_fresh_documents() {
    for row in corpus().iter().filter(|row| row[0].as_str().unwrap().starts_with("math ")) {
        let (chunks, html) = (strings(&row[1]), row[2].as_str().unwrap());
        // The spans the HTML holds, so the property below sees math where there is some.
        let tex: Vec<&str> =
            html.split("<span class=\"math\">").skip(1).map(|s| s.split("</span>").next().unwrap()).collect();
        let ended = math_spans(&chunks.concat(), false, false);
        assert_eq!(ended.iter().map(|(.., tex)| tex.as_str()).collect::<Vec<_>>(), tex, "{}", row[0]);
        let failure = math_streams_like_fresh_documents(&chunks.concat(), &chunk_ends(&chunks), true);
        assert_eq!(failure, None, "{}", row[0]);
    }
}

/// The math soup; with `agree`, conceal on and off must show the same math.
struct MathSoup {
    agree: bool,
}

impl model::Model for MathSoup {
    type Command = &'static str;

    fn generate(&self, rng: &mut model::Rng, steps: usize) -> Vec<&'static str> {
        (0..steps).map(|_| *rng.pick(&MATH_PIECES)).collect()
    }

    fn simplify(&self, piece: &&'static str) -> Vec<&'static str> {
        if *piece == "x" { Vec::new() } else { vec!["x"] }
    }

    /// Each piece is a chunk of the stream.
    fn run(&self, pieces: &[&'static str]) -> Option<model::Failure> {
        let ends = chunk_ends(pieces);
        let (property, end) = math_streams_like_fresh_documents(&pieces.concat(), &ends, self.agree)?;
        Some(model::Failure { property, step: ends.iter().position(|&e| e >= end).unwrap_or(0) })
    }
}

#[test]
fn model_streamed_math_never_reverts() {
    // CI budget: 64 documents of 24 pieces, every prefix; MODEL_SEEDS widens it.
    model::check(&MathSoup { agree: true }, 64, 24);
    // Seed 466 of 640: the `|` cuts the span after an escaped `$`, which is no closer.
    assert_eq!(model::Model::run(&MathSoup { agree: true }, &["$", "\\$", "|", "$", " ", "x"]), None);
}

#[test]
fn math_streams_as_decided_at_the_edges_the_reviews_found() {
    // The finding, the streamed chunks, and the frame after each chunk where native code writes the text (none: the
    // property alone).
    let rows: [(&str, &[&str], &[&str]); 4] = [
        // A span the held `|` of a streamed line cuts stays text until the line decides it.
        ("opus-2", &["$a", "|", "b$", " c"], &["$a", "$a", "$a", "$a"]),
        // A split escaped backslash is no `\)` closer.
        ("bigboi-2", &["\\(a b\\\\", ")", " now"], &[]),
        // A closer is decided by the character after it.
        ("bigboi-3", &["see $x$", "."], &["see $x$", "see x."]),
        // A line that may become a display block holds no inline math.
        ("bigboi-4", &["\\[a $b$ z\\]", "\n"], &[]),
    ];
    for (finding, chunks, frames) in rows {
        let app = TestApp::with_hyperlinks(40, 8);
        let markdown = Markdown::new(&app).extensions(&[MarkdownExtension::Math]).streaming(true);
        app.root().add(&markdown);
        for (chunk, expected) in chunks.iter().zip(frames.iter().map(Some).chain(std::iter::repeat(None))) {
            markdown.append(chunk);
            if let Some(expected) = expected {
                assert_eq!(frame(&app), format!("{expected}\n"), "{finding} after {chunk:?}");
            }
        }
        assert_eq!(math_streams_like_fresh_documents(&chunks.concat(), &chunk_ends(chunks), true), None, "{finding}");
    }
    // bigboi-1: a hook gets the formula a held `|` cuts only once it is whole, with conceal and without.
    for conceal in [true, false] {
        let app = TestApp::new(40, 8);
        let seen = Calls::default();
        let record = seen.clone();
        let markdown = Markdown::new(&app).extensions(&[MarkdownExtension::Math]).conceal(conceal).streaming(true);
        markdown.inline_hook(move |spans, _| {
            record.borrow_mut().extend(spans.iter().filter_map(|span| span.math.clone()));
            spans
        });
        app.root().add(&markdown);
        for chunk in ["pre $ab", "|cd$ ok", "\nnext\n"] {
            markdown.append(chunk);
        }
        assert_eq!(*seen.borrow(), ["ab|cd"], "conceal {conceal}");
    }
}
