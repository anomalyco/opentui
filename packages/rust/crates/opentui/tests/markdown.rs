//! Frames of the Markdown corpus in `tests/fixtures/markdown`, compared with the frames OpenTUI Core renders for it
//! (`render.ts` there writes them).

use opentui::input::{MouseButton, MouseEventKind};
use opentui::native::Capture;
use opentui::style::{Attributes, Color, Span, Style};
use opentui::testing::TestApp;
use opentui::widget::{
    AnyWidget, Container, InlineContext, InlineSpan, Markdown, MarkdownTableOptions, ScrollBox, Text, View, Widget,
};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
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
    for case in CASES {
        let source = fixture(&format!("{case}.md"));
        let source = source.trim();
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
            let piece = |text: &str, style: Style, target: Option<&str>| InlineSpan {
                span: Span::styled(text.to_owned(), style),
                code,
                target: target.map(str::to_owned),
            };
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
    let app = TestApp::new(10, 4);
    let markdown = hooked(&app).set_markdown("1234567:ses_cjk");
    app.root().add(&markdown);
    let capture = app.render();
    assert_eq!(capture.text(), "1234567:\n@中文タイ\nトル\n");
    assert_targets(&capture, &markdown, |_| "ses_cjk");

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
        let target = InlineSpan {
            span: Span::styled("@Known", Style::new().underline()),
            code: false,
            target: Some("ses_a".to_owned()),
        };
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
    let source = fixture("links.md");
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
