//! `TextTable` frames, compared with OpenTUI Core's snapshots (`TextTable.test.ts.snap`) where Core has one.

use opentui::native::Capture;
use opentui::prelude::*;
use opentui::testing::TestApp;
use opentui::widget::{ColumnFitter, ColumnWidthMode, TextTable};
use std::time::Duration;

/// Long enough after a press that the next press is not a double click.
const LATER: Duration = Duration::from_secs(1);

fn rows(app: &TestApp) -> Vec<String> {
    let capture = app.render();
    (0..capture.height).map(|y| capture.row(y).trim_end().to_owned()).collect()
}

/// The first rows of a frame, without trailing spaces.
fn top(app: &TestApp, count: usize) -> Vec<String> {
    rows(app).into_iter().take(count).collect()
}

/// The x cells of vertical border glyphs on a row.
fn border_xs(capture: &Capture, y: u32) -> Vec<u32> {
    (0..capture.width).filter(|&x| capture.cell(x, y).is_some_and(|cell| cell.symbol == "│")).collect()
}

/// The first row containing every needle.
fn row_with(capture: &Capture, needles: &[&str]) -> u32 {
    (0..capture.height)
        .find(|&y| needles.iter().all(|needle| capture.row(y).contains(needle)))
        .unwrap_or_else(|| panic!("no row contains {needles:?}"))
}

fn plain(rows: &[&[&str]]) -> Vec<Vec<String>> {
    rows.iter().map(|row| row.iter().map(|cell| cell.to_string()).collect()).collect()
}

fn table(app: &TestApp, content: &[&[&str]]) -> TextTable {
    TextTable::new(app).set_content(plain(content))
}

#[test]
fn styled_cells_draw_in_a_grid() {
    let app = TestApp::new(60, 16);
    let table = TextTable::new(&app)
        .column_width_mode(ColumnWidthMode::Content)
        .set_content([
            vec!["Name".bold(), "Status".bold(), "Notes".bold()],
            vec!["Alpha".into(), "OK".fg(Color::GREEN), "All systems nominal".into()],
            vec!["Bravo".into(), "WARN".fg(Color::RED), "Pending checks".into()],
        ])
        .margin_edge(Edge::Left, 1)
        .margin_edge(Edge::Top, 1);
    app.root().add(&table);
    // Core: "basic table".
    assert_eq!(
        top(&app, 9),
        [
            "",
            " ┌─────┬──────┬───────────────────┐",
            " │Name │Status│Notes              │",
            " ├─────┼──────┼───────────────────┤",
            " │Alpha│OK    │All systems nominal│",
            " ├─────┼──────┼───────────────────┤",
            " │Bravo│WARN  │Pending checks     │",
            " └─────┴──────┴───────────────────┘",
            "",
        ]
    );
    let capture = app.render();
    assert_eq!(capture.cell(8, 4).unwrap().symbol, "O");
    assert_eq!(capture.cell(8, 4).unwrap().fg, Color::GREEN);
    assert!(capture.cell(2, 2).unwrap().attributes.contains(Attributes::BOLD));
    assert_eq!(capture.cell(2, 4).unwrap().fg, app.theme().foreground);
    assert_eq!(capture.cell(1, 1).unwrap().fg, app.theme().border);
    // The table sizes itself to its content.
    assert_eq!((table.row_count(), table.column_count()), (3, 3));
    assert_eq!(table.rect().height, 7.0);
}

#[test]
fn columns_align_their_lines_and_follow_a_change() {
    let app = TestApp::new(20, 6);
    let table = table(&app, &[&["Key", "Value"], &["a", "b"]])
        .column_width_mode(ColumnWidthMode::Content)
        .column_alignments([Alignment::Right, Alignment::Center]);
    app.root().add(&table);
    // Core: "aligns each column's lines and follows a columnAlignments change".
    assert_eq!(top(&app, 4)[3], "│  a│  b  │");
    table.column_alignments([Alignment::Left]);
    assert_eq!(top(&app, 4)[3], "│a  │b    │");
}

#[test]
fn cells_wrap_and_columns_fit_a_narrow_width() {
    let app = TestApp::new(60, 16);
    let table = TextTable::new(&app).width(34).set_content([
        vec!["ID".bold(), "Description".bold()],
        vec!["1".into(), "This is a long sentence that should wrap across multiple visual lines".into()],
        vec!["2".into(), "Short".into()],
    ]);
    app.root().add(&table);
    // Core: "wrapped constrained width".
    assert_eq!(
        top(&app, 10),
        [
            "┌──┬─────────────────────────────┐",
            "│ID│Description                  │",
            "├──┼─────────────────────────────┤",
            "│1 │This is a long sentence that │",
            "│  │should wrap across multiple  │",
            "│  │visual lines                 │",
            "├──┼─────────────────────────────┤",
            "│2 │Short                        │",
            "└──┴─────────────────────────────┘",
            "",
        ]
    );
}

#[test]
fn full_and_content_modes_size_columns() {
    let app = TestApp::new(60, 16);
    let table = table(&app, &[&["A", "B"], &["1", "2"]]).width(34);
    app.root().add(&table);
    // Full width by default: the columns share the spare width.
    assert_eq!(border_xs(&app.render(), 1), [0, 17, 33]);
    table.column_width_mode(ColumnWidthMode::Content);
    assert_eq!(border_xs(&app.render(), 1), [0, 2, 4]);
    table.column_width_mode(ColumnWidthMode::Full);
    assert_eq!(border_xs(&app.render(), 1), [0, 17, 33]);

    // Unwrapped text still fills the width in full mode.
    table.wrap(WrapMode::None).width(24).set_content(plain(&[&["Key", "Value"], &["A", "B"]]));
    assert_eq!(border_xs(&app.render(), 1), [0, 11, 23]);
}

#[test]
fn proportional_fitting_breaks_exact_ties_by_column() {
    let app = TestApp::new(60, 16);
    let long = "ABCDEFGHIJKLMNOPQRS";
    let table = table(&app, &[&[long, "XYZ"]]).width(8);
    app.root().add(&table);
    let capture = app.render();
    assert_eq!(border_xs(&capture, row_with(&capture, &["A", "X"])), [0, 5, 7]);
    table.width(12).cell_padding_x(1);
    let capture = app.render();
    assert_eq!(border_xs(&capture, row_with(&capture, &["A", "X"])), [0, 7, 11]);
    // Padding is part of every column's minimum width.
    table.width(13).set_content(plain(&[&["Alpha", "Bravo", "Charlie"]]));
    let capture = app.render();
    assert_eq!(border_xs(&capture, row_with(&capture, &["A", "B", "C"])), [0, 4, 8, 12]);
}

#[test]
fn fitters_narrow_columns_differently() {
    let app = TestApp::new(60, 16);
    let table = table(
        &app,
        &[
            &["Provider", "Compute Services", "Storage Solutions", "Pricing Model", "Regions", "Use Cases"],
            &[
                "Amazon Web Services",
                "EC2 instances with extensive options for general, memory, and accelerated workloads",
                "S3 tiers, EBS, EFS, and archive classes for long retention",
                "Pay as you go, reserved terms, and discounted spot capacity",
                "Global regions and many edge locations",
                "Enterprise migration, analytics, ML, and backend services",
            ],
        ],
    )
    .width(58);
    app.root().add(&table);
    // Core: "fitter proportional constrained".
    assert_eq!(
        top(&app, 14),
        [
            "┌─────┬───────────┬─────────┬─────────┬────────┬─────────┐",
            "│Provi│Compute    │Storage  │Pricing  │Regions │Use Cases│",
            "│der  │Services   │Solutions│Model    │        │         │",
            "├─────┼───────────┼─────────┼─────────┼────────┼─────────┤",
            "│Amazo│EC2        │S3 tiers,│Pay as   │Global  │Enterpris│",
            "│n Web│instances  │EBS, EFS,│you go,  │regions │e        │",
            "│Servi│with       │and      │reserved │and many│migration│",
            "│ces  │extensive  │archive  │terms,   │edge    │,        │",
            "│     │options for│classes  │and      │location│analytics│",
            "│     │general,   │for long │discounte│s       │, ML, and│",
            "│     │memory, and│retention│d spot   │        │backend  │",
            "│     │accelerated│         │capacity │        │services │",
            "│     │workloads  │         │         │        │         │",
            "└─────┴───────────┴─────────┴─────────┴────────┴─────────┘",
        ]
    );
    table.column_fitter(ColumnFitter::Balanced);
    // Core: "fitter balanced constrained", cut off by the 16-row screen.
    assert_eq!(
        rows(&app),
        [
            "┌────────┬────────┬─────────┬─────────┬────────┬─────────┐",
            "│Provider│Compute │Storage  │Pricing  │Regions │Use Cases│",
            "│        │Services│Solutions│Model    │        │         │",
            "├────────┼────────┼─────────┼─────────┼────────┼─────────┤",
            "│Amazon  │EC2     │S3 tiers,│Pay as   │Global  │Enterpris│",
            "│Web     │instance│EBS, EFS,│you go,  │regions │e        │",
            "│Services│s with  │and      │reserved │and many│migration│",
            "│        │extensiv│archive  │terms,   │edge    │,        │",
            "│        │e       │classes  │and      │location│analytics│",
            "│        │options │for long │discounte│s       │, ML, and│",
            "│        │for     │retention│d spot   │        │backend  │",
            "│        │general,│         │capacity │        │services │",
            "│        │memory, │         │         │        │         │",
            "│        │and     │         │         │        │         │",
            "│        │accelera│         │         │        │         │",
            "│        │ted     │         │         │        │         │",
        ]
    );
}

#[test]
fn border_styles_draw_their_junctions() {
    let app = TestApp::new(10, 5);
    let table = table(&app, &[&["A", "B"], &["1", "2"]]).column_width_mode(ColumnWidthMode::Content).grid_lines(false);
    app.root().add(&table);
    assert_eq!(rows(&app), ["AB", "12", "", "", ""]);
    // A border style turns the lines on.
    let expected: [(BorderStyle, [&str; 5]); 4] = [
        (BorderStyle::Single, ["┌─┬─┐", "│A│B│", "├─┼─┤", "│1│2│", "└─┴─┘"]),
        (BorderStyle::Double, ["╔═╦═╗", "║A║B║", "╠═╬═╣", "║1║2║", "╚═╩═╝"]),
        (BorderStyle::Rounded, ["╭─┬─╮", "│A│B│", "├─┼─┤", "│1│2│", "╰─┴─╯"]),
        (BorderStyle::Heavy, ["┏━┳━┓", "┃A┃B┃", "┣━╋━┫", "┃1┃2┃", "┗━┻━┛"]),
    ];
    for (style, frame) in expected {
        table.border(style);
        assert_eq!(rows(&app), frame, "{style:?}");
    }
    table.border(BorderStyle::Single).border_color(Color::RED).border_bg(Color::BLUE);
    let capture = app.render();
    assert_eq!((capture.cell(0, 0).unwrap().fg, capture.cell(0, 0).unwrap().bg), (Color::RED, Color::BLUE));
}

#[test]
fn inner_and_outer_borders_switch_separately() {
    let app = TestApp::new(10, 5);
    let table = table(&app, &[&["A", "B"], &["1", "2"]]).column_width_mode(ColumnWidthMode::Content);
    app.root().add(&table);
    table.outer_border(false);
    assert_eq!(rows(&app), ["A│B", "─┼─", "1│2", "", ""]);
    // Without inner lines the outer border follows, unless set.
    table.outer_border(None).grid_lines(false);
    assert_eq!(rows(&app), ["AB", "12", "", "", ""]);
    table.outer_border(true);
    assert_eq!(rows(&app), ["┌──┐", "│AB│", "│12│", "└──┘", ""]);
    // Hidden borders keep their space.
    table.outer_border(None).grid_lines(true).show_borders(false);
    assert_eq!(rows(&app), ["", " A B", "", " 1 2", ""]);
    // Without lines, a column gap separates the columns.
    table.grid_lines(false).column_gap(2);
    assert_eq!(rows(&app), ["A  B", "1  2", "", "", ""]);
}

#[test]
fn cell_padding_surrounds_the_text() {
    let app = TestApp::new(12, 8);
    let table = table(&app, &[&["A", "B"], &["1", "2"]]).column_width_mode(ColumnWidthMode::Content).cell_padding(1);
    app.root().add(&table);
    assert_eq!(
        rows(&app),
        ["┌───┬───┐", "│   │   │", "│ A │ B │", "│   │   │", "├───┼───┤", "│   │   │", "│ 1 │ 2 │", "│   │   │"]
    );
    table.cell_padding_y(0);
    assert_eq!(rows(&app)[..5], ["┌───┬───┐", "│ A │ B │", "├───┼───┤", "│ 1 │ 2 │", "└───┴───┘"]);
}

#[test]
fn wide_characters_keep_borders_aligned() {
    let app = TestApp::new(60, 16);
    let table =
        TextTable::new(&app).width(36).wrap(WrapMode::None).column_width_mode(ColumnWidthMode::Content).set_content([
            vec!["Locale".bold(), "Sample".bold()],
            vec!["ja-JP".into(), "東京で寿司 🍣".into()],
            vec!["zh-CN".into(), "你好世界 🚀".into()],
            vec!["ko-KR".into(), "한글 테스트 😄".into()],
        ]);
    app.root().add(&table);
    // Core: "unicode border alignment".
    assert_eq!(
        top(&app, 9),
        [
            "┌──────┬──────────────┐",
            "│Locale│Sample        │",
            "├──────┼──────────────┤",
            "│ja-JP │東京で寿司 🍣 │",
            "├──────┼──────────────┤",
            "│zh-CN │你好世界 🚀   │",
            "├──────┼──────────────┤",
            "│ko-KR │한글 테스트 😄│",
            "└──────┴──────────────┘",
        ]
    );
    let capture = app.render();
    for y in [1, 3, 5, 7] {
        assert_eq!(border_xs(&capture, y), [0, 7, 22]);
    }

    table.width(30).wrap(WrapMode::Word).column_width_mode(ColumnWidthMode::Full).set_content([
        vec!["Item".bold(), "Details".bold()],
        vec!["mixed".into(), "東京界 🌍 emoji wrapping continues across lines for width checks".into()],
        vec!["emoji".into(), "Faces 😀😃😄 should remain stable".into()],
    ]);
    // Core: "unicode wrapping".
    assert_eq!(
        top(&app, 11),
        [
            "┌─────┬──────────────────────┐",
            "│Item │Details               │",
            "├─────┼──────────────────────┤",
            "│mixed│東京界 🌍 emoji       │",
            "│     │wrapping continues    │",
            "│     │across lines for width│",
            "│     │checks                │",
            "├─────┼──────────────────────┤",
            "│emoji│Faces 😀😃😄 should   │",
            "│     │remain stable         │",
            "└─────┴──────────────────────┘",
        ]
    );
}

#[test]
fn new_content_replaces_the_cells() {
    let app = TestApp::new(60, 16);
    let table = table(&app, &[&["A", "B"]]).column_width_mode(ColumnWidthMode::Content);
    app.root().add(&table);
    assert_eq!(top(&app, 3), ["┌─┬─┐", "│A│B│", "└─┴─┘"]);
    table.set_content([
        vec!["Col 1".bold(), "Col 2".bold()],
        vec!["row-1".into(), "updated".into()],
        vec!["row-2".into(), "active".fg(Color::GREEN)],
    ]);
    // Core: "content setter update".
    assert_eq!(
        top(&app, 7),
        [
            "┌─────┬───────┐",
            "│Col 1│Col 2  │",
            "├─────┼───────┤",
            "│row-1│updated│",
            "├─────┼───────┤",
            "│row-2│active │",
            "└─────┴───────┘"
        ]
    );
    // Short rows get empty cells, and the same shape keeps working after a change.
    table.set_content(plain(&[&["x", "y"], &["z"]]));
    assert_eq!(top(&app, 5), ["┌─┬─┐", "│x│y│", "├─┼─┤", "│z│ │", "└─┴─┘"]);
    assert_eq!(table.content()[1][1].plain_text(), "");
    table.set_content(Vec::<Vec<&str>>::new());
    assert_eq!(top(&app, 2), ["", ""]);
}

#[test]
fn text_defaults_color_unstyled_cells() {
    let app = TestApp::new(20, 4);
    let table = TextTable::new(&app)
        .column_width_mode(ColumnWidthMode::Content)
        .fg(Color::YELLOW)
        .attributes(Attributes::ITALIC)
        .text_bg(Color::BLUE)
        .bg(Color::MAGENTA)
        .set_content([vec!["plain".into(), "red".fg(Color::RED)]]);
    app.root().add(&table);
    let capture = app.render();
    let cell = capture.cell(1, 1).unwrap();
    assert_eq!((cell.fg, cell.bg), (Color::YELLOW, Color::BLUE));
    assert!(cell.attributes.contains(Attributes::ITALIC));
    assert_eq!(capture.cell(7, 1).unwrap().fg, Color::RED);
    // The table background fills its area, borders included.
    assert_eq!(capture.cell(0, 0).unwrap().bg, Color::MAGENTA);
    table.fg(Color::CYAN);
    assert_eq!(app.render().cell(1, 1).unwrap().fg, Color::CYAN);
}

const PRIMARY: [[&str; 3]; 6] = [
    ["Task", "Owner", "ETA"],
    [
        "Wrap regression in operational status dashboard with dynamic row heights and constrained layout validation",
        "core platform and runtime reliability squad",
        "done after validating none, word, and char wrap modes across narrow, medium, wide, and ultra-wide terminal \
         widths",
    ],
    [
        "Unicode layout stabilization for mixed Latin, punctuation, symbols, and long identifiers in adjacent columns",
        "render pipeline maintainers with fallback shaping support",
        "in review with follow-up checks for border style transitions, cell padding variants, and selection range \
         consistency",
    ],
    [
        "Snapshot pass for table rendering in content mode and full mode with heavy and double border combinations",
        "qa automation and visual diff triage group",
        "today pending final baseline updates for oversized fixtures that intentionally stress wrapping behavior on \
         high-resolution terminals",
    ],
    [
        "Document edge cases where long tokens without spaces force char wrapping and reveal per-cell clipping \
         regressions",
        "developer experience and docs tooling",
        "planned for this sprint once final reproducible examples are captured and linked to regression tracking \
         tickets",
    ],
    [
        "Performance sweep of wrapping algorithm under large datasets to confirm stable frame times during rapid key \
         toggling",
        "runtime performance task force",
        "scheduled after review, with benchmark runs on laptop and desktop terminals at 200-plus column widths",
    ],
];

/// Core: "demo resize expected primary table", the primary table at 70 cells.
const PRIMARY_AT_70: [&str; 38] = [
    "┌────────────────────────┬─────────────────┬─────────────────────────┐",
    "│Task                    │Owner            │ETA                      │",
    "├────────────────────────┼─────────────────┼─────────────────────────┤",
    "│Wrap regression in      │core platform and│done after validating    │",
    "│operational status      │runtime          │none, word, and char wrap│",
    "│dashboard with dynamic  │reliability squad│modes across narrow,     │",
    "│row heights and         │                 │medium, wide, and ultra- │",
    "│constrained layout      │                 │wide terminal widths     │",
    "│validation              │                 │                         │",
    "├────────────────────────┼─────────────────┼─────────────────────────┤",
    "│Unicode layout          │render pipeline  │in review with follow-up │",
    "│stabilization for mixed │maintainers with │checks for border style  │",
    "│Latin, punctuation,     │fallback shaping │transitions, cell padding│",
    "│symbols, and long       │support          │variants, and selection  │",
    "│identifiers in adjacent │                 │range consistency        │",
    "│columns                 │                 │                         │",
    "├────────────────────────┼─────────────────┼─────────────────────────┤",
    "│Snapshot pass for table │qa automation and│today pending final      │",
    "│rendering in content    │visual diff      │baseline updates for     │",
    "│mode and full mode with │triage group     │oversized fixtures that  │",
    "│heavy and double border │                 │intentionally stress     │",
    "│combinations            │                 │wrapping behavior on     │",
    "│                        │                 │high-resolution terminals│",
    "├────────────────────────┼─────────────────┼─────────────────────────┤",
    "│Document edge cases     │developer        │planned for this sprint  │",
    "│where long tokens       │experience and   │once final reproducible  │",
    "│without spaces force    │docs tooling     │examples are captured and│",
    "│char wrapping and reveal│                 │linked to regression     │",
    "│per-cell clipping       │                 │tracking tickets         │",
    "│regressions             │                 │                         │",
    "├────────────────────────┼─────────────────┼─────────────────────────┤",
    "│Performance sweep of    │runtime          │scheduled after review,  │",
    "│wrapping algorithm under│performance task │with benchmark runs on   │",
    "│large datasets to       │force            │laptop and desktop       │",
    "│confirm stable frame    │                 │terminals at 200-plus    │",
    "│times during rapid key  │                 │column widths            │",
    "│toggling                │                 │                         │",
    "└────────────────────────┴─────────────────┴─────────────────────────┘",
];

#[test]
fn wrapped_tables_relayout_when_resized() {
    let app = TestApp::new(108, 40);
    let table = TextTable::new(&app).set_content(PRIMARY);
    app.root().add(&table);
    let wide = rows(&app);
    assert_eq!(border_xs(&app.render(), 1), [0, 39, 66, 107]);
    app.resize(70, 40);
    assert_eq!(top(&app, 38), PRIMARY_AT_70);
    assert_eq!(table.rect().height, 38.0);
    app.resize(108, 40);
    assert_eq!(rows(&app), wide);
}

#[test]
fn scroll_boxes_reach_the_last_row_after_a_narrowing_resize() {
    let app = TestApp::new(104, 34);
    let table = TextTable::new(&app).set_content([
        ["Key".bold(), "Value".bold()],
        [
            "alpha".into(),
            "word wrapping should preserve intrinsic table height even when parent measure passes provide a smaller \
             at-most height"
                .into(),
        ],
        [
            "beta".into(),
            "this row is intentionally verbose and pushes the wrapped table height so that scrolling must include all \
             visual lines"
                .into(),
        ],
        ["marker".into(), "ENDWORD".into()],
    ]);
    let scroll = ScrollBox::new(&app).grow(1.0).scrollbars(false).content_gap(1);
    scroll.add(&Text::new(&app, "Word Wrap Table").selectable(false)).add(&table);
    let page = View::new(&app).padding(1).gap(1).grow(1.0).child(&scroll).child(&View::new(&app).height(18));
    app.root().add(&page);
    app.render();
    let wide_height = table.rect().height;
    app.resize(66, 34);
    app.render();
    assert!(table.rect().height > wide_height);
    assert!(!rows(&app).iter().any(|row| row.contains("ENDWORD")));
    scroll.scroll_to_bottom();
    let frame = rows(&app);
    assert!(frame.iter().any(|row| row.contains("│marker│ENDWORD")), "{frame:#?}");
    // The scroll box ends at the table's bottom border.
    let bottom = frame.iter().rposition(|row| !row.is_empty() && !row.trim().is_empty()).unwrap();
    assert!(frame[bottom].trim_start().starts_with('└'), "{frame:#?}");
}

/// The screen cell of the first occurrence of `text`, by character index (ASCII rows only).
fn find(app: &TestApp, text: &str) -> (u16, u16) {
    let capture = app.render();
    (0..capture.height)
        .find_map(|y| {
            let row: Vec<char> = capture.row(y).chars().collect();
            let needle: Vec<char> = text.chars().collect();
            row.windows(needle.len()).position(|window| window == needle.as_slice()).map(|x| (x as u16, y as u16))
        })
        .unwrap_or_else(|| panic!("{text:?} is not on screen"))
}

#[test]
fn selection_starts_only_on_cells_and_skips_grid_lines() {
    let app = TestApp::new(60, 16);
    let table = table(&app, &[&["c1", "c2"], &["aa", "bb"], &["cc", "dd"]]).column_width_mode(ColumnWidthMode::Content);
    app.root().add(&table);
    app.render();
    // Presses on grid lines start nothing.
    for start in [(0, 0), (1, 0), (0, 1), (3, 1)] {
        app.drag(start, (4, 3));
        assert_eq!(table.selected_text(), "", "from {start:?}");
        assert_eq!(app.selected_text(), None);
    }
    // The anchor cell is selected whole; the others from the anchor to the pointer, which is on the second "b".
    app.drag((1, 1), (5, 3));
    assert_eq!(table.selected_text(), "c1\tc2\naa\tbb");
    assert_eq!(app.selected_text().as_deref(), Some("c1\tc2\naa\tbb"));
    let capture = app.render();
    assert_eq!(capture.cell(1, 3).unwrap().bg, app.theme().selection_bg);
    assert_ne!(capture.cell(3, 3).unwrap().bg, app.theme().selection_bg);
    // A click elsewhere clears it.
    app.click(30, 10);
    assert_eq!(table.selected_text(), "");

    table.selectable(false);
    app.drag((1, 1), (5, 3));
    assert_eq!(app.selected_text(), None);
}

#[test]
fn a_drag_within_one_cell_selects_part_of_it() {
    let app = TestApp::new(60, 16);
    let table = table(&app, &[&["alphabet", "status"]]);
    app.root().add(&table);
    let (x, y) = find(&app, "alphabet");
    app.drag((x + 3, y), (x + 5, y));
    assert_eq!(table.selected_text(), "hab");
    // Once the pointer leaves the cell, the cell is selected whole.
    app.advance(LATER);
    let (status, _) = find(&app, "status");
    app.drag((x + 3, y), (status + 2, y));
    assert_eq!(table.selected_text(), "alphabet\tsta");
}

fn grid(app: &TestApp) -> TextTable {
    let table = table(app, &[&["colA", "colB", "colC"], &["a1", "b1", "c1"], &["a2", "b2", "c2"], &["a3", "b3", "c3"]]);
    app.root().add(&table);
    table
}

#[test]
fn a_drag_down_one_column_selects_only_that_column() {
    let app = TestApp::new(60, 16);
    let table = grid(&app);
    let (x, y) = find(&app, "colB");
    app.drag((x, y), (x, 11));
    assert_eq!(table.selected_text(), "colB\nb1\nb2\nb3");
    // Leaving the column selects whole rows again.
    app.advance(LATER);
    let (right, _) = find(&app, "colC");
    app.drag((x, y), (right, 11));
    assert_eq!(table.selected_text(), "colB\tcolC\na1\tb1\tc1\na2\tb2\tc2\na3\tb3\tc3");
}

#[test]
fn reverse_drags_select_from_the_bottom_right() {
    let app = TestApp::new(60, 16);
    let table = table(
        &app,
        &[&["H1", "H2", "H3"], &["R1C1", "R1C2", "R1C3"], &["R2C1", "R2C2", "R2C3"], &["R3C1", "R3C2", "R3C3"]],
    );
    app.root().add(&table);
    app.render();
    // The last cell ends just inside the right border.
    app.drag((58, 7), (1, 1));
    assert_eq!(table.selected_text(), "H1\tH2\tH3\nR1C1\tR1C2\tR1C3\nR2C1\tR2C2\tR2C3\nR3C1\tR3C2\tR3C3");
    // Ending on the left border still takes the first column.
    app.advance(LATER);
    app.drag((58, 7), (0, 1));
    assert!(table.selected_text().starts_with("H1\tH2\tH3\nR1C1"));
}

#[test]
fn retracting_a_drag_restores_cell_colors() {
    let app = TestApp::new(20, 6);
    let fg = Color::hex(0x111111);
    let selection = SelectionColors { fg: Some(Color::hex(0xfefefe)), bg: Some(Color::hex(0xcc5500)) };
    let table = table(&app, &[&["AA", "BB"], &["CC", "DD"]])
        .column_width_mode(ColumnWidthMode::Content)
        .fg(fg)
        .text_bg(Color::BLACK)
        .selection_colors(selection);
    app.root().add(&table);
    app.render();
    let text_cells = [(1, 1), (2, 1), (4, 1), (5, 1), (1, 3), (2, 3), (4, 3), (5, 3)];
    app.mouse(MouseEventKind::Down(MouseButton::Left), 1, 1);
    app.mouse(MouseEventKind::Drag(MouseButton::Left), 5, 3);
    assert_eq!(table.selected_text(), "AA\tBB\nCC\tDD");
    let capture = app.render();
    for (x, y) in text_cells {
        let cell = capture.cell(x, y).unwrap();
        assert_eq!((cell.fg, cell.bg), (Color::hex(0xfefefe), Color::hex(0xcc5500)), "({x}, {y})");
    }
    assert_eq!(capture.cell(3, 1).unwrap().bg, app.theme().background);
    app.mouse(MouseEventKind::Drag(MouseButton::Left), 1, 1);
    assert_eq!(table.selected_text(), "");
    let capture = app.render();
    for (x, y) in text_cells {
        let cell = capture.cell(x, y).unwrap();
        assert_eq!((cell.fg, cell.bg), (fg, Color::BLACK), "({x}, {y})");
    }
    app.mouse(MouseEventKind::Up(MouseButton::Left), 1, 1);
    assert_eq!(app.selected_text(), None);
}

#[test]
fn a_new_drag_forgets_the_previous_one() {
    let app = TestApp::new(60, 16);
    let table = TextTable::new(&app).width(44).margin_edge(Edge::Left, 1).margin_edge(Edge::Top, 8).set_content([
        vec!["Service".bold(), "Status".bold(), "Notes".bold()],
        vec!["api".into(), "OK".fg(Color::GREEN), "latency 28ms".into()],
        vec!["worker".into(), "DEGRADED".fg(Color::YELLOW), "queue depth: 124".into()],
        vec!["billing".into(), "ERROR".fg(Color::RED), "retrying payment provider".into()],
    ]);
    app.root().add(&table);
    app.render();
    // Core's sequence, which once left stale selections in cells.
    app.drag((14, 9), (40, 18));
    app.click(27, 13);
    app.mouse(MouseEventKind::Down(MouseButton::Left), 13, 9);
    for y in [10, 11, 13, 16, 20] {
        app.mouse(MouseEventKind::Drag(MouseButton::Left), 13, y);
    }
    app.mouse(MouseEventKind::Up(MouseButton::Left), 13, 20);
    assert_eq!(table.selected_text(), "Status\nOK\nDEGRADED\nERROR");
}

#[test]
fn double_and_triple_clicks_select_a_word_and_a_line_of_a_cell() {
    let app = TestApp::new(30, 4);
    let table = table(&app, &[&["hello brave world", "x"]]).column_width_mode(ColumnWidthMode::Content);
    app.root().add(&table);
    app.render();
    app.click(8, 1);
    assert_eq!(app.selected_text(), None);
    app.click(8, 1);
    assert_eq!(app.selected_text().as_deref(), Some("brave"));
    app.click(8, 1);
    assert_eq!(app.selected_text().as_deref(), Some("hello brave world"));
}

#[test]
fn a_selection_continues_from_text_into_a_table() {
    let app = TestApp::new(20, 7);
    let title = Text::new(&app, "Title");
    let table = table(&app, &[&["a1", "b1"], &["a2", "b2"]]).column_width_mode(ColumnWidthMode::Content);
    app.root().add(&title).add(&table);
    app.render();
    app.drag((0, 0), (2, 4));
    assert_eq!(title.selected_text(), "Title");
    assert_eq!(table.selected_text(), "a1\tb1\na2");
    assert_eq!(app.selected_text().as_deref(), Some("Title\na1\tb1\na2"));
}

#[test]
fn a_selection_follows_the_cells_when_the_table_relayouts() {
    let app = TestApp::new(40, 12);
    let table = table(&app, &[&["key", "a value that wraps when narrow"], &["k2", "short"]]);
    app.root().add(&table);
    app.render();
    // From the first cell to below the table: everything.
    app.drag((1, 1), (38, 11));
    let everything = "key\ta value that wraps when narrow\nk2\tshort";
    assert_eq!(table.selected_text(), everything);
    app.resize(20, 12);
    let frame = rows(&app);
    assert_eq!(frame[1], "│key│a value that  │");
    assert_eq!(table.selected_text(), everything);
    assert_eq!(app.render().cell(5, 2).unwrap().bg, app.theme().selection_bg);
    // Empty styled cells are fine too.
    table.set_content([vec!["".bold(), "x".into()]]);
    assert_eq!(top(&app, 3), ["┌─────────┬────────┐", "│         │x       │", "└─────────┴────────┘"]);
}

#[test]
fn long_tables_scroll_inside_a_scroll_box() {
    let app = TestApp::new(24, 8);
    let rows_content: Vec<[String; 2]> = (0..50).map(|row| [format!("row {row}"), format!("value {row}")]).collect();
    let table = TextTable::new(&app).column_width_mode(ColumnWidthMode::Content).set_content(rows_content);
    let scroll = ScrollBox::new(&app).scrollbars(false).height(5);
    scroll.add(&table);
    app.root().add(&scroll).add(&Text::new(&app, "below"));
    assert_eq!(
        top(&app, 6),
        [
            "┌──────┬────────┐",
            "│row 0 │value 0 │",
            "├──────┼────────┤",
            "│row 1 │value 1 │",
            "├──────┼────────┤",
            "below"
        ]
    );
    assert_eq!(table.rect().height, 101.0);
    // Row 20's text is on the table's line 41.
    scroll.scroll_to(0.0, 40.0);
    assert_eq!(
        top(&app, 6),
        [
            "├──────┼────────┤",
            "│row 20│value 20│",
            "├──────┼────────┤",
            "│row 21│value 21│",
            "├──────┼────────┤",
            "below"
        ]
    );
    scroll.scroll_to(0.0, 41.0);
    assert_eq!(top(&app, 2), ["│row 20│value 20│", "├──────┼────────┤"]);
    scroll.scroll_to_bottom();
    assert_eq!(top(&app, 6)[3..], ["│row 49│value 49│".to_owned(), "└──────┴────────┘".to_owned(), "below".to_owned()]);
}
