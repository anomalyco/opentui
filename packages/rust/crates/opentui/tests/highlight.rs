//! Tree-sitter highlighting in a `Textarea`, checked through rendered cells.

use opentui::prelude::*;
use opentui::syntax::SyntaxTheme;
use opentui::testing::TestApp;

/// The color the default syntax theme gives a capture name, or the text color without the `tree-sitter` feature.
fn syntax_fg(app: &TestApp, name: &str) -> Color {
    let theme = SyntaxTheme::from_theme(&app.theme());
    let highlighted = cfg!(feature = "tree-sitter").then(|| theme.get(name).and_then(|style| style.fg)).flatten();
    highlighted.unwrap_or(app.theme().foreground)
}

fn fg(app: &TestApp, x: u32, y: u32) -> Color {
    app.render().cell(x, y).unwrap().fg
}

fn rust_area(app: &TestApp, text: &str) -> Textarea {
    let area = Textarea::new(app).filetype("rust").grow(1.0);
    area.set_text(text);
    app.root().add(&area);
    area
}

#[test]
fn a_rust_textarea_colors_keywords() {
    let app = TestApp::new(30, 3);
    rust_area(&app, "let a = 1;");
    let capture = app.render();
    assert_eq!(capture.cell(0, 0).unwrap().fg, syntax_fg(&app, "keyword"));
    assert_eq!(capture.cell(4, 0).unwrap().fg, app.theme().foreground);
    assert_eq!(capture.cell(8, 0).unwrap().fg, syntax_fg(&app, "number"));
}

#[test]
fn without_a_grammar_the_text_is_plain() {
    let app = TestApp::new(30, 3);
    let area = Textarea::new(&app).filetype("cobol").grow(1.0);
    area.set_text("MOVE A TO B");
    app.root().add(&area);
    assert_eq!(fg(&app, 0, 0), app.theme().foreground);
}

#[cfg(feature = "tree-sitter")]
#[test]
fn typing_highlights_again_at_the_next_frame() {
    let app = TestApp::new(30, 3);
    let area = rust_area(&app, "le");
    area.focus();
    assert_eq!(fg(&app, 0, 0), app.theme().foreground);
    app.type_text("t x = 1;");
    assert_eq!(area.text(), "let x = 1;");
    let capture = app.render();
    assert_eq!(capture.cell(0, 0).unwrap().fg, syntax_fg(&app, "keyword"));
    assert_eq!(capture.cell(8, 0).unwrap().fg, syntax_fg(&app, "number"));
}

#[cfg(feature = "tree-sitter")]
#[test]
fn highlights_land_after_line_breaks_tabs_and_wide_characters() {
    let app = TestApp::new(40, 4);
    // Columns on the second line: the tab is two wide, `let` 2..5, the string 10..16 with each character two wide,
    // then `let` 18..21 and `n` at 22.
    let area = rust_area(&app, "fn f() {\n\tlet s = \"日本\"; let n = 1;\n}");
    let (keyword, plain) = (syntax_fg(&app, "keyword"), app.theme().foreground);
    let capture = app.render();
    let at = |x: u32| capture.cell(x, 1).unwrap().fg;
    assert_eq!(capture.cell(0, 0).unwrap().fg, keyword);
    assert_eq!((at(2), at(4), at(5)), (keyword, keyword, plain));
    assert_eq!((at(10), at(15)), (syntax_fg(&app, "string"), syntax_fg(&app, "string")));
    assert_eq!((at(17), at(18), at(20), at(21), at(22)), (plain, keyword, keyword, plain, plain));
    assert_eq!(at(26), syntax_fg(&app, "number"));
    // A wider tab moves everything after it.
    area.tab_width(4);
    let capture = app.render();
    let at = |x: u32| capture.cell(x, 1).unwrap().fg;
    assert_eq!((at(3), at(4), at(20), at(22), at(23)), (plain, keyword, keyword, keyword, plain));
    // Control characters put in through the buffer show as notation: `^L` two cells wide, `<85>` four.
    area.buffer().set_text("\x0clet a;\n\u{85}let b;", false).unwrap();
    let capture = app.render();
    let cells = [(2, 0), (4, 0), (5, 0), (4, 1), (6, 1), (7, 1)].map(|(x, y)| capture.cell(x, y).unwrap().fg);
    assert_eq!(cells, [keyword, keyword, plain, keyword, keyword, plain]);
}

#[cfg(feature = "tree-sitter")]
#[test]
fn nested_captures_style_over_the_ones_around_them() {
    let app = TestApp::new(30, 3);
    let area = rust_area(&app, "let s = \"a\\nb\";");
    let red = Style::new().fg(Color::RED);
    area.syntax_theme(SyntaxTheme::new().style("string", red).style("escape", Style::new().bold()));
    let capture = app.render();
    let (a, escape) = (capture.cell(9, 0).unwrap(), capture.cell(10, 0).unwrap());
    assert_eq!((a.fg, a.attributes.contains(Attributes::BOLD)), (Color::RED, false));
    assert_eq!((escape.fg, escape.attributes.contains(Attributes::BOLD)), (Color::RED, true));
    // Keywords have no style in this theme.
    assert_eq!(capture.cell(0, 0).unwrap().fg, app.theme().foreground);
}

#[cfg(feature = "tree-sitter")]
#[test]
fn extmark_styles_draw_over_highlighting() {
    let app = TestApp::new(30, 3);
    let area = rust_area(&app, "let a = 1;");
    area.add_extmark(0..3, ExtmarkOptions::default().style(Style::new().fg(Color::CYAN)));
    assert_eq!(fg(&app, 0, 0), Color::CYAN);
    // A new style table keeps the mark's color, and so does the undo that brings back a deleted mark.
    area.syntax_style(&opentui::native::SyntaxStyle::new(app.session().context()).unwrap());
    assert_eq!(fg(&app, 0, 0), Color::CYAN);
    area.focus();
    area.set_cursor_offset(3);
    (0..3).for_each(|_| app.press("backspace"));
    assert_eq!((area.text().as_str(), area.extmarks().len()), (" a = 1;", 0));
    (0..3).for_each(|_| app.press("ctrl+-"));
    assert_eq!(fg(&app, 0, 0), Color::CYAN);
    area.clear_extmarks();
    assert_eq!(fg(&app, 0, 0), syntax_fg(&app, "keyword"));
}

#[cfg(feature = "tree-sitter")]
#[test]
fn only_edits_highlight_again() {
    let app = TestApp::new(30, 4);
    let area = rust_area(&app, "let a = 1;\nlet b = 2;\nlet c = 3;\nlet d = 4;\nlet e = 5;");
    let other = Textarea::new(&app).height(1);
    app.root().add(&other);
    area.height(3).focus();
    let keyword = syntax_fg(&app, "keyword");
    assert_eq!(fg(&app, 0, 0), keyword);
    // Highlights removed behind the widget's back stay removed until the text changes.
    area.buffer().clear_highlights().unwrap();
    assert_eq!(fg(&app, 0, 0), app.theme().foreground);
    for key in ["right", "down", "shift+right", "ctrl+e"] {
        app.press(key);
    }
    app.scroll(1, 1, true);
    other.focus();
    area.focus();
    area.set_cursor_offset(0);
    assert_eq!(fg(&app, 0, 0), app.theme().foreground);
    app.type_text("x");
    app.press("backspace");
    assert_eq!(area.text().lines().next(), Some("let a = 1;"));
    assert_eq!(fg(&app, 0, 0), keyword);
}

#[cfg(feature = "tree-sitter")]
#[test]
fn theme_and_filetype_changes_restyle() {
    let app = TestApp::new(30, 3);
    let area = rust_area(&app, "let a = 1;");
    assert_eq!(fg(&app, 0, 0), syntax_fg(&app, "keyword"));
    area.syntax_theme(SyntaxTheme::new().style("keyword", Style::new().fg(Color::RED)));
    assert_eq!(fg(&app, 0, 0), Color::RED);
    assert_eq!(fg(&app, 8, 0), app.theme().foreground);
    area.filetype(None);
    assert_eq!(fg(&app, 0, 0), app.theme().foreground);
    area.filetype("rs");
    assert_eq!(fg(&app, 0, 0), Color::RED);
}

#[cfg(feature = "tree-sitter")]
#[test]
fn highlighting_registers_into_a_style_table_the_app_sets() {
    let app = TestApp::new(30, 3);
    let theme = SyntaxTheme::new().style("keyword", Style::new().fg(Color::RED));
    let table = theme.to_syntax_style(app.session().context()).unwrap();
    let keyword = table.resolve("keyword").unwrap().expect("a registered name");
    assert_eq!(table.resolve("keyword.return").unwrap(), None);
    let area = rust_area(&app, "let a = 1;").syntax_style(&table);
    assert_eq!(fg(&app, 0, 0), syntax_fg(&app, "keyword"));
    // A highlight of the app's own, under its own tag, draws over highlighting: here, over the number.
    let highlight = opentui::native::Highlight { start: 8, end: 9, style_id: keyword, priority: 1, tag: 1 };
    area.buffer().highlight(highlight).unwrap();
    // Ids with the run flag name styled-text styles: a highlight with one fails and leaves the others.
    let flagged = opentui::native::Highlight { style_id: keyword | opentui::sys::OT_STYLE_RUN_FLAG, ..highlight };
    assert_eq!(area.buffer().highlight(flagged).unwrap_err().status(), Some(opentui::Status::InvalidArgument));
    // At priority 0 it draws over text the syntax theme leaves plain, and under styled text.
    area.buffer().highlight(opentui::native::Highlight { start: 0, end: 7, priority: 0, ..highlight }).unwrap();
    let capture = app.render();
    assert_eq!(capture.cell(8, 0).unwrap().fg, Color::RED);
    assert_eq!(capture.cell(3, 0).unwrap().fg, Color::RED);
    assert_eq!(capture.cell(0, 0).unwrap().fg, syntax_fg(&app, "keyword"));
}
