//! Widget behavior and frame snapshots, driven through the public API without a terminal.

use opentui::prelude::*;
use opentui::testing::TestApp;
use opentui::widget::ScrollAction;
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Duration;

#[path = "support/allocations.rs"]
mod allocations;

fn rows(app: &TestApp) -> Vec<String> {
    let capture = app.render();
    (0..capture.height).map(|y| capture.row(y).trim_end().to_owned()).collect()
}

#[test]
fn sibling_paint_and_hits_match_a_fresh_tree() {
    let rows: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("../../../../core/src/tests/fixtures/sibling-paint-order.json")).unwrap();
    for row in rows {
        let key = row["key"].as_str().unwrap();
        let after = row["after"].as_str().unwrap();
        let observe = |fresh: bool| {
            let app = TestApp::new(3, 1);
            let nodes = ["A", "B", "C"].map(|k| {
                let width = 3 - "ABC".find(k).unwrap();
                Text::new(&app, k.repeat(width))
                    .absolute()
                    .width(width as u32)
                    .height(1)
                    .z_index(i32::from(row["raised"] == k))
            });
            let parent = app.root();
            let other = View::new(&app).width(0).height(0);
            let child = &nodes["ABC".find(key).unwrap()];
            if row["reparent"] == true {
                parent.add(&other);
                if !fresh {
                    other.add(child);
                }
            }
            for k in (if fresh { after } else { row["before"].as_str().unwrap() }).chars() {
                parent.add(&nodes["ABC".find(k).unwrap()]);
            }
            if !fresh {
                app.present().unwrap();
                parent.insert(after.find(key).unwrap() + usize::from(row["reparent"] == true), child);
            }
            let frame = app.text();
            let hits = (0..3)
                .map(|x| {
                    let hit = app.session().hit_test(x, 0).unwrap();
                    nodes.iter().zip('A'..='C').find(|(n, _)| Some(n.id()) == hit).map_or('?', |(_, k)| k)
                })
                .collect::<String>();
            (frame, hits)
        };
        let fresh = observe(true);
        let expected = row["frame"].as_str().unwrap();
        assert_eq!((&*fresh.0, &*fresh.1), (expected, expected), "{row}");
        assert_eq!(observe(false), fresh, "{row}");
    }
}

#[test]
fn views_lay_out_borders_titles_and_text() {
    let app = TestApp::new(20, 4);
    let panel = View::new(&app).border(BorderStyle::Rounded).title(" Hi ").padding_x(1).grow(1.0);
    panel.add(&Text::new(&app, "Hello"));
    app.root().add(&panel);
    assert_eq!(app.text(), "╭─ Hi ─────────────╮\n│ Hello            │\n│                  │\n╰──────────────────╯");
    let capture = app.render();
    assert_eq!(capture.cell(0, 0).unwrap().fg, app.theme().border);
    assert_eq!(capture.cell(5, 1).unwrap().bg, app.theme().background);
}

#[test]
fn rows_columns_gaps_and_visibility() {
    let app = TestApp::new(16, 3);
    let left = Text::new(&app, "left");
    let right = Text::new(&app, "right");
    let row = View::new(&app).row().gap(2).child(&left).child(&right);
    app.root().add(&row).add(&Text::new(&app, "below"));
    assert_eq!(rows(&app), ["left  right", "below", ""]);
    left.visible(false);
    assert_eq!(rows(&app), ["right", "below", ""]);
    assert!(!left.is_visible());
    row.detach();
    assert_eq!(rows(&app), ["below", "", ""]);
}

#[test]
fn clear_detaches_every_child_and_their_focus() {
    let app = TestApp::new(8, 4);
    let column = View::new(&app);
    let first = Text::new(&app, "first");
    let input = Input::new(&app);
    column.add(&first).add(&input).add(&Text::new(&app, "third"));
    app.root().add(&column).add(&Text::new(&app, "after"));
    input.focus();
    assert_eq!(rows(&app), ["first", "", "third", "after"]);
    column.clear();
    assert!(column.children().is_empty());
    assert!(first.parent().is_none() && input.parent().is_none());
    assert!(app.focused().is_none());
    assert_eq!(rows(&app), ["after", "", "", ""]);
    column.add(&first);
    assert_eq!(rows(&app), ["first", "after", "", ""]);
    column.clear().clear();
    assert_eq!(rows(&app), ["after", "", "", ""]);
}

#[test]
fn column_and_row_gaps_space_one_axis() {
    let app = TestApp::new(9, 3);
    let row = View::new(&app).row().flex_wrap(Wrap::Wrap).column_gap(1);
    for word in ["ab", "cd", "ef", "gh"] {
        row.add(&Text::new(&app, word));
    }
    app.root().add(&row);
    assert_eq!(rows(&app), ["ab cd ef", "gh", ""]);
    row.row_gap(1);
    assert_eq!(rows(&app), ["ab cd ef", "", "gh"]);
}

// As in Core, a list lays out its rows as a column with `overflow: scroll` does: a row direction does not apply, and a
// percent height inside an auto-height row resolves against no height, so the row after it starts right below.
#[test]
fn list_mode_stacks_rows_as_a_scrolling_column() {
    let app = TestApp::new(10, 10);
    let row = View::new(&app).child(&View::new(&app).width(1).height(Length::percent(100.0)));
    let after = View::new(&app).width(1).height(1);
    let list = View::new(&app).row().width(10).height(10).layout_mode(LayoutMode::List);
    list.add(&View::new(&app).width(2).height(1)).add(&row).add(&after);
    app.root().add(&list);
    let read = || {
        app.render();
        (row.rect().left, row.rect().top, after.rect().top)
    };
    assert_eq!(read(), (0.0, 1.0, 1.0));
    list.layout_mode(LayoutMode::Flex);
    assert_eq!(read(), (2.0, 0.0, 0.0));
    list.detach();
    let scroll = ScrollBox::new(&app).scrollbars(false).row().layout_mode(LayoutMode::List);
    scroll.add(&Text::new(&app, "ab")).add(&Text::new(&app, "cd"));
    app.root().add(&scroll);
    assert_eq!(rows(&app)[..2], ["ab", "cd"]);
}

#[test]
fn styled_text_wraps_and_updates() {
    let app = TestApp::new(10, 3);
    let text = Text::new(&app, vec!["Open".fg(Color::RED).bold(), " TUI rocks".into()]);
    app.root().add(&text);
    assert_eq!(rows(&app), ["Open TUI", "rocks", ""]);
    let capture = app.render();
    assert_eq!(capture.cell(0, 0).unwrap().fg, Color::RED);
    assert!(capture.cell(0, 0).unwrap().attributes.contains(Attributes::BOLD));
    assert_eq!(capture.cell(5, 0).unwrap().fg, app.theme().foreground);
    text.set_text("short").fg(Color::BLUE);
    assert_eq!(text.text(), "short");
    assert_eq!(rows(&app), ["short", "", ""]);
    assert_eq!(app.render().cell(0, 0).unwrap().fg, Color::BLUE);
}

#[test]
fn inputs_type_move_delete_and_undo() {
    let app = TestApp::new(30, 2);
    let input = Input::new(&app).placeholder("name");
    app.root().add(&input);
    assert_eq!(app.render().row(0).trim_end(), "name");
    input.focus();
    app.type_text("hello world");
    assert_eq!(input.value(), "hello world");
    assert_eq!(input.cursor_offset(), 11);
    app.press("ctrl+w");
    assert_eq!(input.value(), "hello ");
    app.press("backspace");
    app.press("ctrl+a");
    assert_eq!(input.cursor_offset(), 0);
    app.type_text(">");
    assert_eq!(input.value(), ">hello");
    app.press("ctrl+e");
    app.press("left");
    app.press("left");
    app.press("ctrl+k");
    assert_eq!(input.value(), ">hel");
    app.press("ctrl+-");
    assert_eq!(input.value(), ">hello");
    app.press("ctrl+.");
    assert_eq!(input.value(), ">hel");
    assert_eq!(app.render().row(0).trim_end(), ">hel");

    // 606: in a field narrower than its line, the visual line end is the line end, from before (Home) or past
    // (Left) the scroll offset.
    let app = TestApp::new(4, 2);
    let input = Input::new(&app).width(4).set_value("abcdefgh");
    let area = Textarea::new(&app).width(4).height(1).wrap(WrapMode::None).set_text("abcdefgh");
    app.root().add(&input).add(&area);
    let scroll_then_press = |start, key| {
        app.press("end");
        app.render();
        app.press(start);
        app.press(key);
    };
    let rows = [
        ("home", "alt+e", ""),
        ("left", "super+right", ""),
        ("home", "shift+alt+e", "abcdefgh"),
        ("left", "shift+super+right", "h"),
    ];
    for (start, key, selected) in rows {
        input.focus();
        scroll_then_press(start, key);
        assert_eq!((input.cursor_offset(), input.selected_text()), (8, selected.to_owned()), "Input {start} {key}");
        area.focus();
        scroll_then_press(start, key);
        assert_eq!((area.cursor_offset(), area.selected_text()), (8, selected.to_owned()), "Textarea {start} {key}");
    }
}

#[test]
fn editors_select_with_shift_and_replace_selection() {
    // Core's rows for the same keys (cell occupancy): a selection covers the cell it started on and the cursor's cell,
    // but not an empty one past the end of a line. A mouse selection grows from the cell at its other end.
    for (text, keys, selected, typed) in [
        ("a界", "left shift+left", "a界", "x"),
        ("a界", "home shift+right", "a界", "x"),
        ("a界", "shift+left", "界", "ax"),
        ("a界", "left shift+left shift+right", "", "ax界"),
        ("abc def", "shift+left shift+left shift+left", "def", "abc x"),
        ("abcdef", "left left left shift+left shift+left", "bcd", "axef"),
        ("abcdef", "shift+left shift+right", "", "abcdefx"),
        ("abcdef", "left left left shift+right shift+left backspace shift+right", "de", "abxf"),
        ("abcdef", "left left left shift+home", "abcd", "xef"),
        ("abc def", "home alt+shift+f", "abc d", "xef"),
        ("abc def", "super+a", "abc def", "x"),
        ("abc def", "super+a left", "", "xabc def"),
        ("ab\ncd", "up shift+right", "\nc", "abxd"),
        ("ab\ncd", "up home shift+right shift+right", "ab", "x\ncd"),
        ("ab\ncd", "left left shift+up", "ab\nc", "xd"),
        ("drag me", "drag 0 3, shift+right", "drag ", "xme"),
        ("drag me", "drag 3 0, shift+right", "rag", "dx me"),
        ("drag me", "drag 0 3, shift+left", "dra", "xg me"),
        ("a界b", "drag 2 0, shift+right", "界", "axb"),
        ("a界b", "drag 2 0, shift+right shift+right", "界b", "ax"),
        ("abc", "drag 3 0, shift+end", "", "abcx"),
        ("alpha beta gamma", "double-click 7, shift+right", "beta ", "alpha xgamma"),
        ("alpha beta gamma", "double-click 7, shift+home shift+right", "lpha b", "axeta gamma"),
        ("alpha beta gamma", "triple-click 7, shift+right", "alpha beta gamma", "x"),
    ] {
        for single_line in [true, false] {
            if single_line && text.contains('\n') {
                continue;
            }
            let app = TestApp::new(20, 1);
            let (input, area) = (Input::new(&app).set_value(text), Textarea::new(&app).set_text(text));
            if single_line {
                app.root().add(&input);
                input.focus();
            } else {
                app.root().add(&area);
                area.focus();
            }
            app.render();
            let (gesture, keys) = keys.split_once(", ").unwrap_or(("", keys));
            match gesture.split(' ').collect::<Vec<_>>()[..] {
                ["drag", from, to] => app.drag((from.parse().unwrap(), 0), (to.parse().unwrap(), 0)),
                [clicks, at] => {
                    (0..if clicks == "double-click" { 2 } else { 3 }).for_each(|_| app.click(at.parse().unwrap(), 0))
                }
                _ => {}
            }
            keys.split(' ').for_each(|key| app.press(key));
            let state = || {
                if single_line { (input.selected_text(), input.value()) } else { (area.selected_text(), area.text()) }
            };
            let now = state().0;
            app.type_text("x");
            assert_eq!((now.as_str(), state().1.as_str()), (selected, typed), "{text:?} {keys} {single_line}");
        }
    }
}

#[test]
fn inputs_submit_filter_paste_and_limit_length() {
    let app = TestApp::new(30, 1);
    let submitted = Rc::new(RefCell::new(Vec::new()));
    let changes = Rc::new(Cell::new(0));
    let input = Input::new(&app).max_length(8);
    input
        .on_submit({
            let submitted = submitted.clone();
            move |_cx, value| submitted.borrow_mut().push(value.to_owned())
        })
        .on_change({
            let changes = changes.clone();
            move |_cx, _value| changes.set(changes.get() + 1)
        });
    app.root().add(&input);
    input.focus();
    app.paste("one\ntwo\x1b[31m red\x07");
    assert_eq!(input.value(), "onetwo r");
    app.type_text("zzz");
    assert_eq!(input.value(), "onetwo r");
    app.press("enter");
    // A legacy line feed (Ctrl+J) submits too.
    app.feed(b"\n");
    assert_eq!(*submitted.borrow(), ["onetwo r", "onetwo r"]);
    assert_eq!(changes.get(), 1);
    app.press("left");
    assert_eq!(changes.get(), 1);
}

#[test]
fn textareas_insert_lines_wrap_and_submit() {
    let app = TestApp::new(12, 4);
    let submitted = Rc::new(Cell::new(false));
    let area = Textarea::new(&app).on_submit({
        let submitted = submitted.clone();
        move |_cx, _text| submitted.set(true)
    });
    app.root().add(&area);
    area.focus();
    app.type_text("first\nsecond line wraps");
    assert_eq!(area.text(), "first\nsecond line wraps");
    assert_eq!(rows(&app), ["first", "second line", "wraps", ""]);
    assert_eq!(area.cursor(), (1, 17));
    app.press("up");
    app.press("home");
    assert_eq!(area.cursor(), (0, 0));
    app.press("ctrl+shift+d");
    assert_eq!(area.text(), "second line wraps");
    app.press("alt+enter");
    assert!(submitted.get());
    app.paste("x\ty\r\n");
    assert!(area.text().starts_with("x\ty\n"), "{:?}", area.text());
    // A legacy line feed (Ctrl+J) inserts a line too.
    app.feed(b"\n");
    assert!(area.text().starts_with("x\ty\n\n"), "{:?}", area.text());
}

#[test]
fn editors_select_with_the_mouse_and_copy_text() {
    let app = TestApp::new(20, 2);
    let input = Input::new(&app).set_value("drag to select");
    app.root().add(&input);
    app.render();
    // A drag selects through the cell under the pointer.
    app.drag((0, 0), (3, 0));
    assert!(input.is_focused());
    assert_eq!(input.selected_text(), "drag");
    assert_eq!(app.selected_text().as_deref(), Some("drag"));
    app.click(10, 0);
    assert_eq!(app.selected_text(), None);
}

#[test]
fn text_selects_with_the_mouse() {
    let app = TestApp::new(20, 2);
    let text = Text::new(&app, "select me please").selectable(true);
    app.root().add(&text);
    app.render();
    app.drag((7, 0), (8, 0));
    assert_eq!(text.selected_text(), "me");
    assert_eq!(app.selected_text().as_deref(), Some("me"));
    let capture = app.render();
    assert_eq!(capture.cell(7, 0).unwrap().bg, app.theme().selection_bg);
}

fn menu(app: &TestApp) -> Select {
    Select::new(app).options([
        ("Build", "Compile the project"),
        ("Test", "Run the tests"),
        ("Ship", "Publish a release"),
        ("Rest", "Take a break"),
    ])
}

#[test]
fn selects_render_navigate_and_activate() {
    let app = TestApp::new(24, 4);
    let selected = Rc::new(RefCell::new(Vec::new()));
    let list = menu(&app).grow(1.0).on_select({
        let selected = selected.clone();
        move |_cx, index, option| selected.borrow_mut().push((index, option.name.clone()))
    });
    app.root().add(&list);
    list.focus();
    assert_eq!(rows(&app), [" ▶ Build", "   Compile the project", "   Test", "   Run the tests"]);
    let capture = app.render();
    assert_eq!(capture.cell(3, 0).unwrap().bg, app.theme().highlight_bg);
    app.press("down");
    app.press("j");
    assert_eq!(list.selected(), 2);
    // The selection stays centered when the list scrolls.
    assert_eq!(rows(&app), ["   Test", "   Run the tests", " ▶ Ship", "   Publish a release"]);
    app.press("end");
    assert_eq!(list.selected(), 3);
    app.press("down");
    assert_eq!(list.selected(), 3);
    app.press("enter");
    assert_eq!(*selected.borrow(), [(3, "Rest".to_owned())]);
    app.press("home");
    assert_eq!(list.selected(), 0);
}

#[test]
fn selects_follow_clicks_and_the_wheel() {
    let app = TestApp::new(24, 8);
    let changes = Rc::new(RefCell::new(Vec::new()));
    let list = menu(&app).show_description(false).height(4).on_change({
        let changes = changes.clone();
        move |_cx, index, _option| changes.borrow_mut().push(index)
    });
    app.root().add(&list);
    app.render();
    app.click(3, 2);
    assert_eq!(list.selected(), 2);
    assert!(list.is_focused());
    app.scroll(3, 2, true);
    assert_eq!(list.selected(), 3);
    assert_eq!(*changes.borrow(), [2, 3]);
    list.wrap_selection(true);
    list.focus();
    app.press("down");
    assert_eq!(list.selected(), 0);
}

#[test]
fn tabs_move_render_and_truncate_wide_names() {
    let app = TestApp::new(30, 3);
    let tabs = TabSelect::new(&app).tab_width(10).options([
        ("Files", "Browse"),
        ("Search", "Find text"),
        ("設定とオプション", "Settings"),
    ]);
    app.root().add(&tabs);
    tabs.focus();
    let lines = rows(&app);
    // A wide glyph that would cross the clip edge leaves its cell blank.
    assert_eq!(lines[0], " Files     Search    設定と …");
    assert_eq!(lines[1], "▬▬▬▬▬▬▬▬▬▬");
    assert_eq!(lines[2], " Browse");
    app.press("right");
    app.press("]");
    assert_eq!(tabs.selected(), 2);
    assert_eq!(rows(&app)[2], " Settings");
    app.render();
    app.click(12, 0);
    assert_eq!(tabs.selected(), 1);
}

#[test]
fn sliders_follow_keys_clicks_and_drags() {
    let app = TestApp::new(20, 2);
    let values = Rc::new(RefCell::new(Vec::new()));
    let slider = Slider::new(&app).range(0.0, 100.0).width(20).height(1).on_change({
        let values = values.clone();
        move |_cx, value| values.borrow_mut().push(value)
    });
    app.root().add(&slider);
    slider.focus();
    app.press("right");
    assert_eq!(slider.value(), 5.0);
    app.press("end");
    assert_eq!(slider.value(), 100.0);
    app.press("home");
    assert_eq!(slider.value(), 0.0);
    let capture = app.render();
    assert_eq!(capture.cell(0, 0).unwrap().symbol, "█");
    assert_eq!(capture.cell(19, 0).unwrap().symbol, " ");
    app.click(10, 0);
    assert!((45.0..=55.0).contains(&slider.value()), "{}", slider.value());
    app.render();
    let before = slider.value();
    app.drag((10, 0), (19, 0));
    assert!(slider.value() > before, "{} -> {}", before, slider.value());
    assert_eq!(slider.value(), 100.0);
    assert_eq!(values.borrow().len(), values.borrow().iter().filter(|value| value.is_finite()).count());
}

#[test]
fn scroll_boxes_clip_scroll_and_show_scrollbars() {
    let app = TestApp::new(12, 4);
    let scroll = ScrollBox::new(&app).grow(1.0);
    for line in 0..10 {
        scroll.add(&Text::new(&app, format!("line {line}")));
    }
    app.root().add(&scroll);
    let lines = rows(&app);
    assert_eq!(
        lines.iter().map(|line| line[..6.min(line.len())].trim_end()).collect::<Vec<_>>(),
        ["line 0", "line 1", "line 2", "line 3"]
    );
    // The vertical scrollbar takes the last column.
    let capture = app.render();
    assert_ne!(capture.cell(11, 0).unwrap().bg, app.theme().background);
    app.scroll(2, 1, true);
    app.scroll(2, 1, true);
    assert_eq!(scroll.scroll_position(), (0.0, 2.0));
    assert!(rows(&app)[0].starts_with("line 2"));
    scroll.focus();
    app.press("end");
    assert_eq!(scroll.scroll_position(), (0.0, 6.0));
    assert!(rows(&app)[3].starts_with("line 9"));
    app.press("home");
    assert_eq!(scroll.scroll_position(), (0.0, 0.0));
    app.scroll(2, 1, false);
    assert_eq!(scroll.scroll_position(), (0.0, 0.0));
}

#[test]
fn an_always_shown_vertical_scrollbar_fills_its_track_until_the_content_overflows() {
    let (thumb, track) = (Color::hex(0xff0000), Color::hex(0x0000ff));
    let app = TestApp::new(12, 4);
    let scroll = ScrollBox::new(&app).grow(1.0).scrollbar_colors(thumb, track).vertical_scrollbar_always(true);
    scroll.add(&Text::new(&app, "line 0"));
    app.root().add(&scroll);
    let column = |app: &TestApp| {
        let capture = app.render();
        (0..4).map(|y| capture.cell(11, y).unwrap().fg).collect::<Vec<_>>()
    };
    assert_eq!(column(&app), [thumb; 4]);
    for line in 1..8 {
        scroll.add(&Text::new(&app, format!("line {line}")));
    }
    let overflowing = column(&app);
    assert!(overflowing.contains(&thumb) && overflowing != [thumb; 4], "{overflowing:?}");
    // Without the option a fitting content shows no scrollbar.
    let app = TestApp::new(12, 4);
    let scroll = ScrollBox::new(&app).grow(1.0).scrollbar_colors(thumb, track);
    scroll.add(&Text::new(&app, "line 0"));
    app.root().add(&scroll);
    assert!(!column(&app).contains(&thumb));
}

// Scrollbar options set on a rendered box show what a box built with them shows, with no size change between.
#[test]
fn scrollbar_options_changed_after_a_frame_match_a_fresh_box() {
    let bars = |lines: usize, (show, always): (bool, bool), last: (bool, bool)| {
        let app = TestApp::new(8, 4);
        let scroll = ScrollBox::new(&app).grow(1.0).scrollbars(show).vertical_scrollbar_always(always);
        scroll.add(&Text::new(&app, "a\n".repeat(lines)).shrink(0.0));
        app.root().add(&scroll);
        app.render();
        // Each setter alone, so neither covers for the other.
        (show != last.0).then(|| scroll.scrollbars(last.0));
        (always != last.1).then(|| scroll.vertical_scrollbar_always(last.1));
        let capture = (app.render(), app.render()).1;
        let column: String = (0..4).map(|y| capture.row(y).chars().nth(7).unwrap_or(' ')).collect();
        (column, scroll.content_view().rect().width)
    };
    let options = [(false, false), (false, true), (true, false), (true, true)];
    for lines in [0, 6] {
        for (first, last) in options.iter().flat_map(|&first| options.map(|last| (first, last))) {
            assert_eq!(bars(lines, first, last), bars(lines, last, last), "{lines} lines, {first:?} then {last:?}");
        }
    }
    // A box that fits on both axes shows no bar, and between frames the last call wins.
    let app = TestApp::new(8, 4);
    app.root().add(&ScrollBox::new(&app).grow(1.0).axes(true, true).child(&Text::new(&app, "a")));
    assert_eq!(rows(&app)[3], "");
    let scroll = ScrollBox::new(&app).grow(1.0).child(&Text::new(&app, "a\n".repeat(6)).shrink(0.0));
    app.root().clear().add(&scroll);
    app.render();
    scroll.scrollbars(false).scrollbars(true).scrollbars(false);
    app.render();
    assert_eq!(scroll.content_view().rect().width, 8.0);
    // Options set from a resize handler stay within the per-frame toggle limit, so the frame still lays out.
    let app = TestApp::new(8, 4);
    let scroll = ScrollBox::new(&app).grow(1.0).child(&Text::new(&app, "a"));
    let handle = scroll.clone();
    scroll.content_view().on_resize(move |_, rect| drop(handle.vertical_scrollbar_always(rect.width >= 8.0)));
    app.root().add(&scroll);
    app.render();
    app.render();
}

#[test]
fn sticky_scroll_boxes_follow_new_content() {
    let app = TestApp::new(12, 3);
    let scroll = ScrollBox::new(&app).sticky(true).scrollbars(false).grow(1.0);
    app.root().add(&scroll);
    for line in 0..5 {
        scroll.add(&Text::new(&app, format!("line {line}")));
        app.render();
    }
    assert_eq!(rows(&app), ["line 2", "line 3", "line 4"]);
    scroll.scroll_by(0.0, -1.0);
    scroll.add(&Text::new(&app, "line 5"));
    app.render();
    assert_eq!(rows(&app), ["line 1", "line 2", "line 3"]);
    scroll.scroll_to_bottom();
    scroll.add(&Text::new(&app, "line 6"));
    app.render();
    assert_eq!(rows(&app), ["line 4", "line 5", "line 6"]);
}

#[test]
fn growing_scroll_boxes_never_squeeze_their_siblings() {
    let app = TestApp::new(12, 6);
    let tabs = TabSelect::new(&app).tab_width(6).show_description(false).options(["One", "Two"]).grow(1.0);
    let scroll = ScrollBox::new(&app).scrollbars(false).grow(1.0);
    for line in 0..100 {
        scroll.add(&Text::new(&app, format!("line {line}")));
    }
    let panel = View::new(&app).border(BorderStyle::Single).grow(1.0).child(&scroll);
    app.root().add(&View::new(&app).row().child(&tabs)).add(&panel).add(&Text::new(&app, "footer"));
    let lines = rows(&app);
    assert_eq!(lines[0], " One   Two");
    assert_eq!(lines[1], "▬▬▬▬▬▬");
    assert_eq!(lines[2], "┌──────────┐");
    assert_eq!(lines[3], "│line 0    │");
    assert_eq!(lines[5], "footer");
}

// The rows come from Core's ScrollBoxRenderable with the same tree. As there, a box without a height takes its height
// from its content up to its maximum height, and its content view's 100% minimum height fills that maximum.
#[test]
fn scroll_boxes_without_a_height_size_to_content_up_to_their_maximum() {
    let app = TestApp::new(12, 8);
    let lines = |prefix: &str, count: usize| {
        let scroll = ScrollBox::new(&app);
        for line in 0..count {
            scroll.add(&Text::new(&app, format!("{prefix} {line}")));
        }
        scroll
    };
    let column = View::new(&app).column();
    column.add(&lines("fit", 2).max_height(5)).add(&lines("cap", 4).max_height(2)).add(&Text::new(&app, "after"));
    app.root().add(&column);
    assert_eq!(rows(&app), ["fit 0", "fit 1", "", "", "", "cap 0      █", "cap 1", "after"]);
}

#[test]
fn scroll_into_view_reveals_children() {
    let app = TestApp::new(12, 3);
    let scroll = ScrollBox::new(&app).scrollbars(false).grow(1.0);
    let lines: Vec<Text> = (0..10).map(|line| Text::new(&app, format!("line {line}"))).collect();
    for line in &lines {
        scroll.add(line);
    }
    app.root().add(&scroll);
    app.render();
    scroll.scroll_into_view(&lines[7]);
    assert_eq!(rows(&app)[2], "line 7");
    scroll.scroll_into_view(&lines[1]);
    assert_eq!(rows(&app)[0], "line 1");
}

#[test]
fn scroll_moves_before_a_frame_add_up_and_clamp_once() {
    // 10 lines in 4 rows scroll from 0 to 6. `F` renders a frame; a number scrolls by it; a key presses it.
    let cases: &[(&str, &[&str], f64)] = &[
        ("moves add up within the range", &["2", "3"], 5.0),
        ("moves past the start add up", &["-5", "3"], 0.0),
        ("a move back past the start", &["-5", "6"], 1.0),
        ("a frame ends the sum at the start", &["-5", "F", "3"], 3.0),
        ("moves past the end stop at it", &["5", "5", "-3"], 3.0),
        ("a frame at the end", &["5", "5", "F", "-3"], 3.0),
        ("a frame between moves within the range", &["2", "F", "3"], 5.0),
        ("keys add up as moves do", &["home", "down"], 0.0),
        ("a frame ends the sum of keys", &["home", "F", "down"], 1.0),
        ("end then a key back", &["end", "up"], 5.0),
        ("a wheel step ends the sum", &["-5", "wheel", "1"], 2.0),
        ("a zero move keeps the sum", &["-5", "0", "3"], 0.0),
    ];
    for &(name, steps, expected) in cases {
        let app = TestApp::new(20, 4);
        let scroll = scroll_box_with_lines(&app, 10).scrollbars(false);
        scroll.focus();
        app.render();
        for step in steps {
            match *step {
                "F" => {
                    app.render();
                }
                "wheel" => app.scroll(2, 1, true),
                "home" | "end" | "up" | "down" => app.press(step),
                delta => {
                    scroll.scroll_by(0.0, delta.parse().unwrap());
                }
            }
        }
        assert_eq!(scroll.scroll_position().1, expected, "{name}");
        app.render();
        assert_eq!(scroll.scroll_position().1, expected, "{name}, after a frame");
    }
}

#[test]
fn scroll_moves_to_the_end_follow_content_added_before_the_frame() {
    let app = TestApp::new(20, 4);
    let scroll = scroll_box_with_lines(&app, 10).scrollbars(false);
    scroll.scroll_by(0.0, 4.0).scroll_by(0.0, 4.0);
    for line in 10..13 {
        scroll.add(&Text::new(&app, format!("line {line}")));
    }
    app.render();
    assert_eq!(scroll.scroll_position().1, 9.0);
    // Within the range, the sum holds as content grows.
    scroll.scroll_by(0.0, -3.0).scroll_by(0.0, -3.0);
    scroll.add(&Text::new(&app, "line 13"));
    app.render();
    assert_eq!(scroll.scroll_position().1, 3.0);
}

#[test]
fn tab_moves_focus_in_tree_order_and_skips_hidden_widgets() {
    let app = TestApp::new(20, 6);
    let first = Input::new(&app);
    let hidden = Input::new(&app).visible(false);
    let list = menu(&app).height(2);
    let last = Input::new(&app);
    app.root().add(&first).add(&hidden).add(&View::new(&app).child(&list)).add(&last);
    app.press("tab");
    assert!(first.is_focused());
    assert!(app.focused().unwrap().element().is_editor());
    app.press("tab");
    assert!(list.is_focused());
    assert!(!app.focused().unwrap().element().is_editor());
    assert!(Textarea::new(&app).element().is_editor());
    app.press("tab");
    assert!(last.is_focused());
    app.press("tab");
    assert!(first.is_focused());
    app.press("shift+tab");
    assert!(last.is_focused());
    last.detach();
    assert_eq!(app.focused(), None);
}

#[test]
fn keys_bubble_from_the_focused_widget_to_the_app() {
    let app = TestApp::new(20, 3);
    let log = Rc::new(RefCell::new(Vec::new()));
    let push = |name: &'static str| {
        let log = log.clone();
        move |_cx: &mut Cx<'_>, key: &KeyEvent| log.borrow_mut().push(format!("{name}:{:?}", key.code))
    };
    let input = Input::new(&app).on_key(push("input"));
    let panel = View::new(&app).child(&input).on_key(push("panel"));
    app.root().add(&panel);
    app.on_key(push("app"));
    app.on_key_capture({
        let log = log.clone();
        move |cx, key| {
            if key.matches("f1") {
                log.borrow_mut().push("capture".into());
                cx.stop_propagation();
            }
        }
    });
    input.focus();
    // Typed text stops at the input, which consumes it.
    app.type_text("a");
    assert_eq!(*log.borrow(), ["input:Char('a')"]);
    log.borrow_mut().clear();
    // Keys the input ignores reach its ancestors and the app.
    app.press("f5");
    assert_eq!(*log.borrow(), ["input:F(5)", "panel:F(5)", "app:F(5)"]);
    log.borrow_mut().clear();
    app.press("f1");
    assert_eq!(*log.borrow(), ["capture"]);
    // prevent_default skips the input's own behavior but the event still bubbles.
    input.on_key(|cx, key| {
        if key.matches("b") {
            cx.prevent_default();
        }
    });
    log.borrow_mut().clear();
    app.type_text("b");
    assert_eq!(input.value(), "a");
    assert_eq!(*log.borrow(), ["input:Char('b')", "panel:Char('b')", "app:Char('b')"]);
}

#[test]
fn ctrl_c_quits_and_handlers_can_claim_it() {
    let app = TestApp::new(10, 1);
    app.press("ctrl+c");
    assert!(app.is_quitting());
    let options = AppOptions { exit_on_ctrl_c: true, ..Default::default() };
    let app = TestApp::with_options(10, 1, options);
    app.on_key(|cx, key| {
        if key.matches("ctrl+c") {
            cx.prevent_default();
        }
    });
    app.press("ctrl+c");
    assert!(!app.is_quitting());
}

#[test]
fn clicks_focus_bubble_and_report_hover() {
    let app = TestApp::new(20, 4);
    let log = Rc::new(RefCell::new(Vec::new()));
    let button = Text::new(&app, "[ OK ]");
    let card = View::new(&app).border(BorderStyle::Single).focusable(true).size(10, 3).child(&button);
    app.root().add(&card);
    button.on_click({
        let log = log.clone();
        move |_cx, event| log.borrow_mut().push(format!("click {} {}", event.x, event.y))
    });
    for (name, widget) in [("card", card.as_any()), ("button", button.as_any())] {
        let log = log.clone();
        widget.on_hover(move |_cx, hovered| log.borrow_mut().push(format!("{name} {hovered}")));
    }
    app.render();
    app.hover(5, 0);
    app.hover(2, 1);
    app.click(2, 1);
    app.hover(15, 3);
    assert_eq!(
        *log.borrow(),
        ["card true", "button true", "click 2 1", "button false", "card false"],
        "{:?}",
        log.borrow()
    );
    assert!(card.is_focused());
    assert_eq!(app.widget_at(2, 1).map(|widget| widget.is(&button)), Some(true));
}

#[test]
fn focus_handlers_run_after_the_event() {
    let app = TestApp::new(20, 2);
    let log = Rc::new(RefCell::new(Vec::new()));
    let first = Input::new(&app);
    let second = Input::new(&app);
    for (name, input) in [("first", &first), ("second", &second)] {
        let log = log.clone();
        input.on_focus(move |_cx, focused| log.borrow_mut().push(format!("{name} {focused}")));
    }
    app.root().add(&first).add(&second);
    first.focus();
    second.focus();
    app.blur();
    app.render();
    assert_eq!(*log.borrow(), ["first true", "first false", "second true", "second false"]);
}

#[test]
fn timers_intervals_and_animations_use_the_app_clock() {
    let app = TestApp::new(10, 1);
    let ticks = Rc::new(Cell::new(0));
    let fired = Rc::new(Cell::new(false));
    app.set_timeout(Duration::from_millis(100), {
        let fired = fired.clone();
        move |_cx| fired.set(true)
    });
    let interval = app.set_interval(Duration::from_millis(30), {
        let ticks = ticks.clone();
        move |_cx| ticks.set(ticks.get() + 1)
    });
    for _ in 0..9 {
        app.advance(Duration::from_millis(11));
    }
    assert!(!fired.get());
    assert_eq!(ticks.get(), 3);
    // After a stall, an interval fires once instead of catching up.
    app.advance(Duration::from_millis(1));
    assert!(fired.get());
    assert_eq!(ticks.get(), 3);
    assert!(app.cancel_timer(interval));
    app.advance(Duration::from_secs(1));
    assert_eq!(ticks.get(), 3);

    let frames = Rc::new(Cell::new(0));
    app.animate({
        let frames = frames.clone();
        move |_cx, _elapsed| {
            frames.set(frames.get() + 1);
            frames.get() < 3
        }
    });
    for _ in 0..5 {
        app.advance(Duration::from_millis(16));
        app.render();
    }
    assert_eq!(frames.get(), 3);
    assert!(!app.needs_frame());
}

#[test]
fn proxies_deliver_messages_from_other_threads() {
    let app = TestApp::new(20, 1);
    let status = Text::new(&app, "waiting");
    app.root().add(&status);
    app.on_message({
        let status = status.clone();
        move |_cx, count: &usize| {
            status.set_text(format!("got {count}"));
        }
    });
    let proxy = app.proxy();
    std::thread::spawn(move || {
        proxy.send(7usize).unwrap();
        proxy.post(|cx| cx.request_redraw()).unwrap();
    })
    .join()
    .unwrap();
    assert_eq!(rows(&app), ["got 7"]);
    let proxy = app.proxy();
    drop(app);
    assert_eq!(proxy.send(1usize), Err(opentui::app::ProxyError::Closed));
}

struct Counter {
    count: i32,
}

impl Component for Counter {
    fn paint(&self, painter: &mut Painter<'_>) {
        painter.fill(0, 0, painter.width(), 1, Color::BLUE);
        painter.text(1, 0, &format!("count {}", self.count), Style::new().fg(Color::WHITE));
    }

    fn key(&mut self, _cx: &mut Cx<'_>, key: &KeyEvent) -> bool {
        match () {
            _ if key.matches("+") => self.count += 1,
            _ if key.matches("-") => self.count -= 1,
            _ => return false,
        }
        true
    }

    fn mouse(&mut self, _cx: &mut Cx<'_>, event: &MouseEvent, local: (i32, i32)) -> bool {
        if matches!(event.kind, MouseEventKind::Down(MouseButton::Left)) {
            self.count = local.0;
            return true;
        }
        false
    }
}

#[test]
fn custom_components_paint_and_handle_input() {
    let app = TestApp::new(16, 2);
    let counter = Custom::new(&app, Counter { count: 0 }).height(1).focusable(true);
    app.root().add(&Text::new(&app, "above")).add(&counter);
    counter.focus();
    app.type_text("++-+");
    assert_eq!(counter.with(|counter| counter.count), 2);
    assert_eq!(rows(&app), ["above", " count 2"]);
    let capture = app.render();
    assert_eq!(capture.cell(15, 1).unwrap().bg, Color::BLUE);
    app.click(9, 1);
    assert_eq!(counter.with(|counter| counter.count), 9);
    counter.update(|counter| counter.count = 42);
    assert_eq!(rows(&app)[1], " count 42");
}

#[test]
fn native_failures_end_the_frame_with_an_error() {
    let app = TestApp::new(10, 1);
    let text = Text::new(&app, "x").width(Length::Cells(f32::INFINITY));
    app.root().add(&text);
    let error = app.try_render().expect_err("an infinite width is rejected");
    assert_eq!(error.status(), Some(opentui::Status::InvalidArgument));
    assert!(app.try_render().is_ok());
}

#[test]
fn ending_the_app_releases_widgets_that_handlers_capture() {
    let sentinel = Rc::new(());
    {
        let app = TestApp::new(10, 2);
        let input = Input::new(&app);
        // A handler that captures its own widget forms a cycle until the app ends.
        input.on_change({
            let input = input.clone();
            let sentinel = sentinel.clone();
            move |_cx, _text| {
                let _ = (&input, &sentinel);
            }
        });
        app.root().add(&input);
        app.on_key({
            let sentinel = sentinel.clone();
            move |_cx, _key| {
                let _ = &sentinel;
            }
        });
        assert_eq!(Rc::strong_count(&sentinel), 3);
    }
    assert_eq!(Rc::strong_count(&sentinel), 1);
}

#[test]
fn resizing_relays_out_and_notifies() {
    let app = TestApp::new(10, 2);
    let sizes = Rc::new(RefCell::new(Vec::new()));
    app.on_resize({
        let sizes = sizes.clone();
        move |_cx, width, height| sizes.borrow_mut().push((width, height))
    });
    app.root().add(&Text::new(&app, "a fairly long line"));
    assert_eq!(rows(&app), ["a fairly", "long line"]);
    app.resize(20, 1);
    assert_eq!(rows(&app), ["a fairly long line"]);
    assert_eq!(*sizes.borrow(), [(20, 1)]);
    assert_eq!(app.size(), (20, 1));
}

#[test]
fn raw_input_bytes_drive_widgets() {
    let app = TestApp::new(20, 1);
    let input = Input::new(&app);
    app.root().add(&input);
    input.focus();
    app.feed(b"hi\x1b[D!\x1b[200~ there\x1b[201~");
    assert_eq!(input.value(), "h! therei");
}

/// The color the default syntax theme gives a capture name, or the text color without the `tree-sitter` feature.
fn syntax_fg(app: &TestApp, name: &str) -> Color {
    let theme = opentui::syntax::SyntaxTheme::from_theme(&app.theme());
    let highlighted = cfg!(feature = "tree-sitter").then(|| theme.get(name).and_then(|style| style.fg)).flatten();
    highlighted.unwrap_or(app.theme().foreground)
}

#[test]
fn code_highlights_numbers_lines_and_scrolls() {
    use opentui::widget::Code;
    let app = TestApp::new(24, 3);
    let code = Code::new(&app).filetype("rust").line_numbers(true).wrap(WrapMode::Word).grow(1.0);
    let source: String = (1..=12).map(|line| format!("let x{line} = \"v\"; // c\n")).collect();
    code.set_code(source.trim_end());
    // Before its first layout the view has no width, so it wraps nothing: 12 rows, not one per character.
    assert_eq!(code.scroll_to(u32::MAX).scroll_position(), 12);
    code.scroll_to(0);
    app.root().add(&code);
    // Core's gutter: at least three cells, with one cell of padding on each side of the number.
    assert_eq!(rows(&app), ["  1 let x1 = \"v\"; // c", "  2 let x2 = \"v\"; // c", "  3 let x3 = \"v\"; // c"]);
    let capture = app.render();
    assert_eq!(capture.cell(2, 0).unwrap().fg, app.theme().muted);
    assert_eq!(capture.cell(4, 0).unwrap().fg, syntax_fg(&app, "keyword"));
    assert_eq!(capture.cell(13, 0).unwrap().fg, syntax_fg(&app, "string"));
    assert_eq!(capture.cell(18, 0).unwrap().fg, syntax_fg(&app, "comment"));
    app.scroll(10, 1, true);
    assert_eq!(code.scroll_position(), 1);
    code.focus();
    app.press("end");
    assert_eq!(code.scroll_position(), 9);
    assert_eq!(rows(&app), [" 10 let x10 = \"v\"; // c", " 11 let x11 = \"v\"; // c", " 12 let x12 = \"v\"; // c"]);
}

#[test]
fn followed_code_keeps_appended_text_in_view() {
    use opentui::widget::Code;
    let app = TestApp::new(12, 3);
    // Text given before follow and before the first frame is followed too.
    let log = Code::new(&app).grow(1.0).append("line 0\nline 1\nline 2\nline 3\n").follow(true);
    app.root().add(&log);
    app.render();
    for line in 4..6 {
        log.append(&format!("line {line}\n"));
        app.render();
    }
    // The trailing newline leaves an empty last line in view.
    assert_eq!(rows(&app), ["line 4", "line 5", ""]);
}

#[test]
fn tables_resolve_columns_align_and_select() {
    use opentui::widget::{Column, ColumnWidth, Table};
    let app = TestApp::new(24, 4);
    let picked = Rc::new(Cell::new(None));
    let table = Table::new(&app)
        .set_columns([Column::new("Name"), Column::new("Size").width(ColumnWidth::Cells(6)).align(Alignment::Right)])
        .set_rows([["Cargo.toml", "1 KB"], ["README.md", "6 KB"], ["a very long file name.rs", "12 KB"], ["z", "0 B"]])
        .grow(1.0)
        .on_select({
            let picked = picked.clone();
            move |_cx, index| picked.set(Some(index))
        });
    app.root().add(&table);
    assert_eq!(
        rows(&app),
        [
            "Name                Size",
            "Cargo.toml          1 KB",
            "README.md           6 KB",
            "a very long file…  12 KB"
        ]
    );
    table.focus();
    app.press("down");
    assert_eq!(table.selected(), Some(0));
    app.press("end");
    assert_eq!(table.selected(), Some(3));
    // The selection scrolled the last row into view.
    assert_eq!(rows(&app)[3], "z                    0 B");
    app.press("enter");
    assert_eq!(picked.get(), Some(3));
    app.render();
    app.click(2, 1);
    assert_eq!(table.selected(), Some(1));
}

#[test]
fn tables_return_their_columns_and_rows() {
    use opentui::widget::{Column, Table};
    let app = TestApp::new(12, 3);
    let table = Table::new(&app).set_columns(["Name", "Size"]).set_rows([["a", "1"]]).push_row(["b", "2"]).grow(1.0);
    assert_eq!(table.columns(), [Column::new("Name"), Column::new("Size")]);
    assert_eq!(table.rows(), [["a", "1"], ["b", "2"]]);
    table.set_columns([String::from("Title")]);
    assert_eq!(table.columns(), [Column::new("Title")]);
    app.root().add(&table);
    assert_eq!(rows(&app), ["Title", "a", "b"]);
}

#[test]
fn image_views_decode_and_present_images() {
    use opentui::native::{Image, ImageProtocol, SessionOptions};
    use opentui::widget::ImageView;
    let app = TestApp::new(4, 2);
    let red = [255u8, 0, 0, 255];
    let image = Image::from_rgba(app.session().context(), 2, 2, &red.repeat(4)).unwrap();
    assert_eq!(image.info().unwrap().width, 2);
    let view = ImageView::new(&app).protocol(ImageProtocol::Blocks).size(4, 2).image(Some(image));
    app.root().add(&view);
    // Native code turns image placements into glyphs when it encodes output, so captures show blank cells.
    app.render();
    assert!(view.load(b"not an image").is_err());
    view.image(None);
    app.render();

    // Three Kitty uploads of noise, which compresses to nothing, are about 12 KB each and do not fit one frame of a
    // 32 KiB Session. A frame sends those that fit and asks for the next, until none wait.
    let mut options = AppOptions::default();
    options.host.session =
        SessionOptions { chunk_size: 4096, span_capacity: 8, max_bytes: 32 * 1024, control_capacity: 4096 };
    let app = TestApp::with_options(30, 4, options);
    let row = View::new(&app).row().gap(2);
    for seed in 0..3u32 {
        let mut x = 0x9e37_79b9 + seed;
        let noise: Vec<u8> = (0..48 * 48 * 4)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                x as u8
            })
            .collect();
        let image = Image::from_rgba(app.session().context(), 48, 48, &noise).unwrap();
        row.add(&ImageView::new(&app).protocol(ImageProtocol::Kitty).size(8, 4).image(Some(image)));
    }
    app.root().add(&row);
    app.render();
    assert!(app.session().renderer_state().unwrap().image_uploads_pending > 0);
    let mut frames = 1;
    while app.needs_frame() && frames < 8 {
        app.render();
        frames += 1;
    }
    assert!(frames > 1 && !app.needs_frame(), "{frames} frames");
    assert_eq!(app.session().renderer_state().unwrap().image_uploads_pending, 0);
}

#[test]
fn frames_too_large_to_write_are_retried_once_and_reported_once() {
    use opentui::app::FrameDropped;
    use opentui::native::SessionOptions;
    let mut options = AppOptions::default();
    options.host.session =
        SessionOptions { chunk_size: 4096, span_capacity: 8, max_bytes: 16 * 1024, control_capacity: 4096 };
    let app = TestApp::with_options(40, 10, options);
    let dropped = Rc::new(RefCell::new(Vec::new()));
    app.on_frame_dropped({
        let dropped = Rc::clone(&dropped);
        move |_cx, frame: FrameDropped| dropped.borrow_mut().push(frame)
    });
    // Nine rows of cells that each change both colors cost more than the limit; the tenth row stays blank.
    let colorful = |seed: u8| -> Vec<Span<'static>> {
        (0..360u32)
            .map(|cell| {
                let [r, g, b] = [(cell * 7) as u8, (cell * 13) as u8 ^ seed, (cell * 29) as u8];
                Span::styled("x", Style::new().fg(Color::rgb(r, g, b)).bg(Color::rgb(b, r, g)))
            })
            .collect()
    };
    let text = Text::new(&app, "small").width(40);
    app.root().add(&text);
    app.render();
    let limit = app.session().write_limit().unwrap();

    // The diff leaves a row out, so native code does not count it, but repaints in full on the next frame: that one
    // is tried once, fails too, and is reported.
    text.set_text(colorful(0));
    app.render();
    assert!(dropped.borrow().is_empty());
    assert!(app.needs_frame(), "a dropped diff is retried as a full repaint");
    app.render();
    let reported = dropped.borrow().clone();
    assert_eq!(reported.len(), 1);
    assert_eq!(reported[0].limit, limit);
    assert!(u64::from(reported[0].bytes) > limit, "{reported:?}");
    assert!(!app.needs_frame());
    // The same content fails again without a report or another try.
    app.render();
    assert_eq!(dropped.borrow().len(), 1);
    assert!(!app.needs_frame());

    // A frame that fits draws, and the next drop is retried and reported again.
    text.set_text("small");
    app.render();
    assert_eq!(app.render().row(0).trim_end(), "small");
    text.set_text(colorful(1));
    app.render();
    assert!(app.needs_frame());
    app.render();
    assert_eq!(dropped.borrow().len(), 2);
    assert!(!app.needs_frame());
}

#[test]
fn growing_code_and_textareas_keep_their_siblings() {
    use opentui::widget::Code;
    let app = TestApp::new(16, 8);
    let long: String = (0..50).map(|line| format!("line {line}\n")).collect();
    let code = Code::new(&app).set_code(long.as_str()).grow(1.0);
    let area = Textarea::new(&app).set_text(&long).grow(1.0);
    app.root().add(&Text::new(&app, "header")).add(&code).add(&area).add(&Text::new(&app, "footer"));
    let lines = rows(&app);
    assert_eq!(lines[0], "header");
    assert_eq!(lines[1], "line 0");
    assert_eq!(lines[7], "footer");
    // The textarea scrolled to its cursor at the end instead of growing.
    assert_eq!(code.rect().height, 3.0);
    assert_eq!(area.rect().height, 3.0);
}

#[test]
fn changes_made_while_a_frame_runs_show_in_that_frame() {
    let app = TestApp::new(20, 3);
    let label = Text::new(&app, "unknown");
    let panel = View::new(&app).grow(1.0).on_resize({
        let label = label.clone();
        move |_cx, rect| {
            label.set_text(format!("{}x{}", rect.width, rect.height));
        }
    });
    app.root().add(&label).add(&panel);
    assert_eq!(rows(&app)[0], "20x2");
    app.resize(30, 5);
    assert_eq!(rows(&app)[0], "30x4");
    assert!(!app.needs_frame());
}

#[test]
fn markdown_renders_blocks_inline_styles_and_code() {
    use opentui::widget::{Markdown, MarkdownColors};
    let app = TestApp::new(30, 12);
    let doc = Markdown::new(&app).set_markdown(
        "# Title\n\nSome **bold** and `code`.\n\n- first\n- second item wraps here\n\n> a quote\n\n```rust\nfn main() {}\n```",
    );
    app.root().add(&doc.grow(1.0));
    assert_eq!(
        rows(&app),
        [
            "Title",
            "",
            "Some bold and code.",
            "",
            "- first",
            "- second item wraps here",
            "",
            "│ a quote",
            "",
            "fn main() {}",
            "",
            "",
        ]
    );
    let colors = MarkdownColors::from_theme(&app.theme());
    let capture = app.render();
    assert!(capture.cell(0, 0).unwrap().attributes.contains(Attributes::BOLD));
    assert!(capture.cell(5, 2).unwrap().attributes.contains(Attributes::BOLD));
    assert_eq!(capture.cell(14, 2).unwrap().bg, colors.code_bg);
    assert_eq!(capture.cell(1, 9).unwrap().bg, colors.code_bg);
    // The fence's filetype highlights the block.
    let keyword = if cfg!(feature = "tree-sitter") { syntax_fg(&app, "keyword") } else { colors.text };
    assert_eq!(capture.cell(1, 9).unwrap().fg, keyword);
    // A new syntax theme restyles the block; after the app's theme changes, a new document's blocks take its colors.
    doc.syntax_theme(opentui::syntax::SyntaxTheme::new().style("keyword", Style::new().fg(Color::RED)));
    let red = if cfg!(feature = "tree-sitter") { Color::RED } else { colors.text };
    assert_eq!(app.render().cell(1, 9).unwrap().fg, red);
    app.set_theme(opentui::theme::Theme::light());
    doc.detach();
    app.root().add(&Markdown::new(&app).set_markdown("```rust\nfn main() {}\n```"));
    let keyword = if cfg!(feature = "tree-sitter") { syntax_fg(&app, "keyword") } else { app.theme().foreground };
    assert_eq!(app.render().cell(1, 0).unwrap().fg, keyword);
}

#[test]
fn markdown_styles_text_by_syntax_scope() {
    use opentui::syntax::SyntaxTheme;
    use opentui::widget::{Markdown, MarkdownColors};
    let app = TestApp::new(30, 8);
    let [text, heading, italic, label, link, url, escape, conceal] =
        [0x101010, 0x202020, 0x303030, 0x404040, 0x505050, 0x606060, 0x707070, 0x808080].map(Color::hex);
    let syntax = SyntaxTheme::new()
        .style("default", Style::new().fg(text))
        .style("markup.heading", Style::new().fg(heading).bold())
        .style("markup.italic", Style::new().fg(italic).italic())
        .style("markup.link.label", Style::new().fg(label))
        .style("markup.link", Style::new().fg(link))
        .style("markup.link.url", Style::new().fg(url).underline())
        .style("string.escape", Style::new().fg(escape))
        .style("conceal", Style::new().fg(conceal));
    let doc = Markdown::new(&app)
        .syntax_theme(syntax)
        .scope_styles(true)
        .set_markdown("### Deep\n\n*it* [l](https://u.t) \\*\n\n- item\n\n---");
    app.root().add(&doc.grow(1.0));
    assert_eq!(rows(&app)[..5], ["Deep", "", "it l (https://u.t) *", "", "- item"]);
    let fg = |capture: &opentui::native::Capture, x, y| capture.cell(x, y).unwrap().fg;
    let capture = app.render();
    // Every heading level takes its scope, through `markup.heading`.
    assert_eq!(fg(&capture, 0, 0), heading);
    assert!(capture.cell(0, 0).unwrap().attributes.contains(Attributes::BOLD));
    assert_eq!(fg(&capture, 0, 2), italic);
    assert_eq!(fg(&capture, 2, 2), text);
    assert_eq!(fg(&capture, 3, 2), label);
    // A concealed link's URL: a plain space, then the URL in parentheses.
    assert_eq!([4, 5, 6, 17].map(|x| fg(&capture, x, 2)), [text, link, url, link]);
    assert_eq!(fg(&capture, 19, 2), escape);
    // `markup.list` has no style, so the marker takes its color from MarkdownColors.
    assert_eq!(fg(&capture, 0, 4), MarkdownColors::from_theme(&app.theme()).marker);
    assert_eq!(fg(&capture, 0, 6), conceal);

    doc.conceal(false);
    assert_eq!(rows(&app)[2], "*it* [l](https://u.t) \\*");
    let capture = app.render();
    assert_eq!(fg(&capture, 0, 0), heading);
    // As in Core's query, a link's `]` is not part of the link.
    assert_eq!([0, 5, 6, 7, 8, 9].map(|x| fg(&capture, x, 2)), [italic, link, label, text, link, url]);

    // Off, the colors style everything again.
    doc.scope_styles(false).conceal(true);
    let colors = MarkdownColors::from_theme(&app.theme());
    let capture = app.render();
    assert_eq!([fg(&capture, 0, 2), fg(&capture, 5, 2)], [colors.text, colors.link]);
}

#[test]
fn code_without_a_grammar_shows_plain_text() {
    use opentui::widget::Code;
    let app = TestApp::new(20, 2);
    let code = Code::new(&app).filetype("cobol").set_code("MOVE A TO B").grow(1.0);
    app.root().add(&code);
    assert_eq!(app.render().cell(0, 0).unwrap().fg, app.theme().foreground);
    code.fg(Color::RED).append(".");
    assert_eq!(rows(&app)[0], "MOVE A TO B.");
    assert_eq!(app.render().cell(0, 0).unwrap().fg, Color::RED);
}

#[cfg(feature = "tree-sitter")]
#[test]
fn display_math_without_a_renderer_shows_plain_tex() {
    use opentui::widget::{Markdown, MarkdownExtension};
    // Even with a grammar named `math`, which a ```math fence takes, display math shows plain TeX, as in Core.
    opentui::syntax::register_alias("math", "rust");
    let app = TestApp::new(20, 4);
    let doc = Markdown::new(&app).extensions(&[MarkdownExtension::Math]);
    app.root().add(&doc.set_markdown("$$\nfn x\n$$\n\n```math\nfn x\n```").grow(1.0));
    let keyword = syntax_fg(&app, "keyword");
    assert!(app.wait_until(Duration::from_secs(10), || app.render().cell(0, 2).unwrap().fg == keyword));
    assert_eq!(rows(&app)[..3], ["fn x", "", "fn x"]);
    assert_eq!(app.render().cell(0, 0).unwrap().fg, app.theme().foreground);
}

#[cfg(feature = "tree-sitter")]
#[test]
fn highlighted_code_restyles_appends_and_theme_changes() {
    use opentui::syntax::SyntaxTheme;
    use opentui::widget::Code;
    let app = TestApp::new(30, 3);
    let code = Code::new(&app).filetype("rs").grow(1.0);
    app.root().add(&code);
    let other = Code::new(&app).filetype("rs").set_code("let peer;").height(1);
    app.root().add(&other);
    code.append("let a = 1;");
    code.append(" // done");
    let capture = app.render();
    assert_eq!(capture.cell(0, 0).unwrap().fg, syntax_fg(&app, "keyword"));
    assert_eq!(capture.cell(11, 0).unwrap().fg, syntax_fg(&app, "comment"));
    // Once highlighted, text appended or extended shows plain until a worker thread's highlight lands.
    code.set_code("let a = 1; // done\nlet b;");
    let capture = app.render();
    assert_eq!(capture.cell(11, 0).unwrap().fg, syntax_fg(&app, "comment"));
    assert_eq!(capture.cell(0, 1).unwrap().fg, app.theme().foreground);
    let keyword = syntax_fg(&app, "keyword");
    assert!(app.wait_until(Duration::from_secs(10), || app.render().cell(0, 1).unwrap().fg == keyword));
    // Two appends keep the shown highlight: the tail stays plain until the worker's lands.
    code.append(" let c;").append(" let d;");
    assert_eq!(app.render().cell(7, 1).unwrap().fg, app.theme().foreground);
    let mut theme = SyntaxTheme::new().style("keyword", Style::new().fg(Color::RED));
    for i in 0..128 {
        theme.set(format!("unused.{i}"), Style::new());
    }
    let before = allocations::count();
    code.syntax_theme(theme);
    assert!(allocations::count() - before < 128, "restyling copied the unused scopes");
    let capture = app.render();
    assert_eq!(capture.cell(0, 0).unwrap().fg, Color::RED);
    assert_eq!(capture.cell(0, 2).unwrap().fg, keyword);
    assert_eq!(capture.cell(11, 0).unwrap().fg, app.theme().foreground);
    code.filetype(None);
    assert_eq!(app.render().cell(0, 0).unwrap().fg, app.theme().foreground);
}

struct Badge {
    label: String,
}

impl Component for Badge {
    fn paint(&self, painter: &mut Painter<'_>) {
        painter.text(1, 0, &self.label, Style::new());
    }

    fn measure(&self, width: opentui::native::Constraint, height: opentui::native::Constraint) -> (f32, f32) {
        (width.apply(self.label.chars().count() as f32 + 2.0), height.apply(1.0))
    }
}

#[test]
fn measured_components_size_themselves() {
    let app = TestApp::new(20, 2);
    let badge = Custom::measured(&app, Badge { label: "new".into() });
    let after = Text::new(&app, "|");
    app.root().add(&View::new(&app).row().child(&badge).child(&after));
    assert_eq!(rows(&app)[0], " new |");
    assert_eq!(badge.rect().width, 5.0);
    badge.update(|badge| badge.label = "updated".into());
    assert_eq!(rows(&app)[0], " updated |");
}

struct Exploding;

impl Component for Exploding {
    fn paint(&self, _painter: &mut Painter<'_>) {}

    fn measure(&self, _width: opentui::native::Constraint, _height: opentui::native::Constraint) -> (f32, f32) {
        panic!("measure failed");
    }
}

#[test]
fn measurement_panics_resume_after_native_layout() {
    let app = TestApp::new(10, 1);
    app.root().add(&Custom::measured(&app, Exploding));
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| app.render()));
    let message = *result.expect_err("the panic reaches the caller").downcast::<&str>().unwrap();
    assert_eq!(message, "measure failed");
}

#[test]
fn input_max_length_follows_cores_vectors() {
    // Core's Input test runs the same rows.
    let corpus: serde_json::Value =
        serde_json::from_str(include_str!("../../../../core/src/renderables/input-max-length.conformance.json"))
            .unwrap();
    let app = TestApp::new(20, 1);
    for row in corpus["rows"].as_array().unwrap() {
        let (value, max) = (row[1].as_str().unwrap(), row[2].as_u64().unwrap() as usize);
        for input in
            [Input::new(&app).max_length(max).set_value(value), Input::new(&app).set_value(value).max_length(max)]
        {
            app.root().add(&input);
            input.focus();
            for _ in 0..row[3].as_u64().unwrap() {
                app.press("shift+left");
            }
            input.insert(row[4].as_str().unwrap());
            assert_eq!(input.value(), row[5], "{}", row[0]);
        }
    }
    // Not shared: Core's Textarea has no maxLength, and Rust's counts characters.
    assert_eq!(Textarea::new(&app).max_length(2).set_text("😀\n😀").text(), "😀\n");
}

#[test]
fn replacing_an_input_value_respects_the_limit_of_the_new_text_only() {
    let app = TestApp::new(20, 1);
    let input = Input::new(&app).max_length(8).set_value("abc");
    input.set_value("0123456789");
    assert_eq!(input.value(), "01234567");
}

#[test]
fn releasing_outside_a_widget_is_not_a_click() {
    let app = TestApp::new(20, 3);
    let clicks = Rc::new(Cell::new(0));
    let button = Text::new(&app, "[ OK ]").on_click({
        let clicks = clicks.clone();
        move |_cx, _event| clicks.set(clicks.get() + 1)
    });
    app.root().add(&View::new(&app).row().child(&button));
    app.render();
    app.drag((1, 0), (15, 2));
    assert_eq!(clicks.get(), 0);
    app.click(2, 0);
    assert_eq!(clicks.get(), 1);
}

#[test]
fn widget_keys_can_be_rebound_and_unbound() {
    use opentui::widget::{EditorAction, SelectAction};
    let app = TestApp::new(30, 6);
    let input = Input::new(&app).bind("ctrl+s", EditorAction::Submit).unbind("enter");
    let list = Select::new(&app).options(["a", "b", "c"]).show_description(false).height(3);
    list.bind("n", SelectAction::MoveDown).unbind("j");
    app.root().add(&input).add(&list);
    let submitted = Rc::new(RefCell::new(Vec::new()));
    input.on_submit({
        let submitted = Rc::clone(&submitted);
        move |_cx, text| submitted.borrow_mut().push(text.to_owned())
    });
    let app_keys = Rc::new(RefCell::new(Vec::new()));
    app.on_key({
        let app_keys = Rc::clone(&app_keys);
        move |_cx, key| app_keys.borrow_mut().push(Shortcut::from(*key).to_string())
    });
    input.focus();
    app.type_text("hi");
    app.press("enter");
    app.press("ctrl+s");
    assert_eq!(*submitted.borrow(), ["hi"]);
    // An unbound Enter is not consumed, so it reaches the app.
    assert_eq!(*app_keys.borrow(), ["enter"]);

    list.focus();
    app.press("n");
    assert_eq!(list.selected(), 1);
    // "j" no longer moves the list, and a Select does not consume text keys.
    app.press("j");
    assert_eq!(list.selected(), 1);
    assert_eq!(app_keys.borrow().last().map(String::as_str), Some("j"));
    list.perform(SelectAction::Last);
    assert_eq!(list.selected(), 2);
    assert_eq!(list.keymap().lookup("n"), Some(SelectAction::MoveDown));
    assert_eq!(Select::default_keymap().lookup("n"), None);
    let shortcuts: Vec<String> = list.keymap().shortcuts(SelectAction::MoveDown).map(|s| s.to_string()).collect();
    assert_eq!(shortcuts, ["down", "n"]);
}

#[test]
fn directional_actions_pass_keys_across_a_widget() {
    use opentui::widget::SliderAction;
    let app = TestApp::new(20, 3);
    let slider = Slider::new(&app).range(0.0, 10.0).step(1.0).width(10).height(1);
    app.root().add(&slider);
    let passed = Rc::new(Cell::new(0));
    app.on_key({
        let passed = Rc::clone(&passed);
        move |_cx, _key| passed.set(passed.get() + 1)
    });
    slider.focus();
    app.press("right");
    assert_eq!(slider.value(), 1.0);
    // Up and Down are bound, but act only on vertical sliders, so they reach the app here.
    app.press("up");
    assert_eq!((slider.value(), passed.get()), (1.0, 1));
    slider.perform(SliderAction::Max);
    assert_eq!(slider.value(), 10.0);
}

#[test]
fn mouse_selection_spans_widgets_in_reading_order() {
    let app = TestApp::new(24, 4);
    let first = Text::new(&app, "first line");
    let second = Text::new(&app, "second line");
    let label = Text::new(&app, "not selectable").selectable(false);
    app.root().add(&first).add(&second).add(&label);
    app.render();
    let finished = Rc::new(RefCell::new(Vec::new()));
    app.on_selection({
        let finished = Rc::clone(&finished);
        move |_cx, text| finished.borrow_mut().push(text.to_owned())
    });
    app.drag((6, 0), (5, 2));
    assert_eq!(first.selected_text(), "line");
    assert_eq!(second.selected_text(), "second line");
    assert_eq!(label.selected_text(), "");
    assert_eq!(app.selected_text().as_deref(), Some("line\nsecond line"));
    assert_eq!(*finished.borrow(), ["line\nsecond line"]);
    let capture = app.render();
    assert_eq!(capture.cell(0, 1).unwrap().bg, app.theme().selection_bg);
    assert_ne!(capture.cell(0, 2).unwrap().bg, app.theme().selection_bg);

    // Dragging back up releases the widgets the selection no longer covers.
    app.drag((6, 0), (9, 0));
    assert_eq!(second.selected_text(), "");
    assert_eq!(app.selected_text().as_deref(), Some("line"));

    // Ctrl+press extends the selection to the pointer.
    app.event(Event::Mouse(MouseEvent {
        kind: MouseEventKind::Down(MouseButton::Left),
        x: 5,
        y: 1,
        modifiers: Modifiers::CTRL,
    }));
    app.mouse(MouseEventKind::Up(MouseButton::Left), 5, 1);
    assert_eq!(app.selected_text().as_deref(), Some("line\nsecond"));

    // A press on a widget that cannot select ends the selection.
    app.click(3, 2);
    assert_eq!(app.selected_text(), None);
    assert_eq!(first.set_text("first line").selected_text(), "");
}

#[test]
fn double_and_triple_clicks_select_words_and_lines() {
    let app = TestApp::new(24, 2);
    let text = Text::new(&app, "hello brave world");
    app.root().add(&text);
    app.render();
    app.click(8, 0);
    assert_eq!(app.selected_text(), None);
    app.click(8, 0);
    assert_eq!(app.selected_text().as_deref(), Some("brave"));
    app.click(8, 0);
    assert_eq!(app.selected_text().as_deref(), Some("hello brave world"));
    // A slower click starts over with a single cell.
    app.advance(Duration::from_millis(600));
    app.click(8, 0);
    assert_eq!(app.selected_text(), None);
}

// As in Core, a text whose content changes applies the selection again at the same cells of the text, during the
// gesture or after it, even after the text moved, so it selects what a fresh gesture on the new content selects.
#[test]
fn a_selection_follows_its_gesture_when_the_content_changes() {
    use opentui::widget::Code;
    let [down, drag, up] =
        [MouseEventKind::Down, MouseEventKind::Drag, MouseEventKind::Up].map(|kind| kind(MouseButton::Left));
    // Presses at (1, 1) of "ab cd\ncd" in a 4x2 text above "def": a drag to (0, 2) in "def", a double click, a
    // triple click. Each change replaces the text, appends to it, or sets it again after a wrap change, which wraps
    // "cd" of the first line to the second row. Expected: the text's selection and the app's, from Core.
    let changes = [("xab cd\nxcd", WrapMode::None), ("ab cd\ncde", WrapMode::None), ("ab cd\ncd", WrapMode::Word)];
    let rows: [(u16, [&str; 3]); 3] =
        [(1, ["cd", "de", "d\nc"]), (2, ["xcd", "cde", "cd"]), (3, ["xcd", "cde", "ab cd"])];
    for is_code in [false, true] {
        for (presses, expected) in rows {
            for ((content, wrap), expected) in changes.into_iter().zip(expected) {
                // Core's Code ignores equal text, so it keeps the selection made under the old wrap mode.
                if is_code && wrap == WrapMode::Word {
                    continue;
                }
                for when in ["fresh", "after", "during", "moved"] {
                    let app = TestApp::new(8, 4);
                    let first = if when == "fresh" { (content, wrap) } else { ("ab cd\ncd", WrapMode::None) };
                    let text = Text::new(&app, first.0).wrap(first.1).size(4, 2);
                    let code = Code::new(&app).wrap(first.1).size(4, 2).set_code(first.0);
                    let change = || match (when, is_code) {
                        ("fresh", _) => {}
                        (_, false) => drop(text.wrap(wrap).set_text(content)),
                        (_, true) => drop(code.wrap(wrap).set_code(content)),
                    };
                    let root = if is_code { app.root().add(&code) } else { app.root().add(&text) };
                    root.add(&Text::new(&app, "def"));
                    app.render();
                    let (x, y) = if presses == 1 { (0, 2) } else { (1, 1) };
                    for press in 1..=presses {
                        app.mouse(down, 1, 1);
                        if presses == 1 {
                            app.mouse(drag, x, y);
                        }
                        if when == "during" && press == presses {
                            change();
                        }
                        app.mouse(up, x, y);
                    }
                    if when == "moved" {
                        app.root().insert(0, &Text::new(&app, "top"));
                        app.render();
                    }
                    if matches!(when, "after" | "moved") {
                        change();
                    }
                    app.render();
                    let at = format!("code {is_code}, {presses} presses, {content:?} {wrap:?} {when}");
                    assert_eq!(if is_code { code.selected_text() } else { text.selected_text() }, expected, "{at}");
                    assert_eq!(app.selected_text().as_deref(), Some(expected), "{at}");
                }
            }
        }
    }
    // One widget, a gesture at (x, y) (one press: a drag four cells right; three: a triple click), then each step
    // sets the text and the wrap mode, with the app's selection after the next frame, from Core: a followed log,
    // a replace that clamps the scroll, a wrap set after the text, a drag that selected nothing at release (Core
    // paints "ew " but copies nothing; the app copies what is painted), and a line that goes and comes back.
    type Step = (&'static str, Option<WrapMode>, Option<&'static str>);
    let log = "aa\nbb\ncc\ndd";
    let regrow: &[Step] = &[("ab", None, None), ("ab\ntwo words", None, Some("two words"))];
    type Row = (bool, bool, &'static str, (u16, u16), u16, (u16, u16), &'static [Step]);
    let rows: &[Row] = &[
        (true, true, log, (4, 2), 3, (1, 1), &[("aa\nbb\ncc\ndd\nee", None, Some("ee"))]),
        (true, true, log, (4, 2), 3, (1, 0), &[("one\ntwo", None, Some("one"))]),
        (true, false, "ab cd\nxy", (4, 2), 3, (1, 1), &[("xab cd\nxcd", Some(WrapMode::Word), Some("xab cd"))]),
        (false, false, "old", (6, 2), 1, (1, 1), &[("old\nnew stuff", None, Some("ew "))]),
        (true, false, "old", (6, 2), 1, (1, 1), &[("old\nnew stuff", None, Some("ew st"))]),
        (false, false, "ab\ncd", (8, 2), 3, (1, 1), regrow),
        (true, false, "ab\ncd", (8, 2), 3, (1, 1), regrow),
    ];
    for &(is_code, follow, first, (width, height), presses, (x, y), steps) in rows {
        let app = TestApp::new(8, 4);
        let text = Text::new(&app, first).size(width, height);
        let code = Code::new(&app).size(width, height).follow(follow).set_code(first);
        let _ = if is_code { app.root().add(&code) } else { app.root().add(&text) };
        app.render();
        let end = if presses == 1 { x + 4 } else { x };
        for _ in 0..presses {
            app.mouse(down, x, y);
            if presses == 1 {
                app.mouse(drag, end, y);
            }
            app.mouse(up, end, y);
        }
        for &(content, wrap, expected) in steps {
            if is_code {
                code.set_code(content);
                if let Some(wrap) = wrap {
                    code.wrap(wrap);
                }
            } else {
                text.set_text(content);
            }
            app.render();
            assert_eq!(app.selected_text().as_deref(), expected, "code {is_code}, {first:?} then {content:?}");
        }
        // Scrolling afterwards leaves the selection on its text.
        if is_code {
            code.perform(ScrollAction::Up);
            app.render();
            assert_eq!(app.selected_text().as_deref(), steps[steps.len() - 1].2, "{first:?} scrolled");
        }
    }
}

#[test]
fn a_selection_inside_an_overlay_skips_text_beneath_it() {
    let app = TestApp::new(30, 6);
    let background = Text::new(&app, "background ".repeat(12));
    let dialog = View::new(&app).absolute().position(Edge::Left, 4).position(Edge::Top, 1).size(20, 3).z_index(10);
    let message = Text::new(&app, "dialog message");
    dialog.add(&message);
    app.root().add(&background).add(&dialog);
    app.render();
    app.drag((4, 1), (9, 1));
    assert_eq!(message.selected_text(), "dialog");
    assert_eq!(background.selected_text(), "");
    assert_eq!(app.selected_text().as_deref(), Some("dialog"));
}

#[test]
fn code_views_and_textareas_join_a_selection() {
    use opentui::widget::Code;
    let app = TestApp::new(24, 6);
    let title = Text::new(&app, "Title");
    let code = Code::new(&app).line_numbers(true).height(2);
    code.set_code("let a = 1;\nlet b = 2;");
    let notes = Textarea::new(&app).height(2);
    notes.set_text("note one");
    app.root().add(&title).add(&code).add(&notes);
    app.render();
    // The gutter is two cells wide; the drag ends inside the textarea.
    app.drag((0, 0), (3, 3));
    assert_eq!(code.selected_text(), "let a = 1;\nlet b = 2;");
    assert_eq!(notes.selected_text(), "note");
    assert_eq!(app.selected_text().as_deref(), Some("Title\nlet a = 1;\nlet b = 2;\nnote"));
    // Shift+arrow in the textarea keeps only its own part.
    notes.focus();
    app.press("shift+right");
    assert_eq!(code.set_code("let a = 3;").selected_text(), "");
    assert_eq!(title.selected_text(), "");
    assert_eq!(notes.selected_text(), "note ");
}

#[test]
fn theme_mode_changes_reach_handlers_once() {
    let app = TestApp::new(10, 2);
    let seen = Rc::new(RefCell::new(Vec::new()));
    app.on_theme_mode({
        let seen = Rc::clone(&seen);
        move |_cx, mode| seen.borrow_mut().push(mode)
    });
    assert_eq!(app.theme_mode(), None);
    for mode in [ThemeMode::Light, ThemeMode::Light, ThemeMode::Dark] {
        app.event(Event::ThemeMode(mode));
    }
    assert_eq!(*seen.borrow(), [ThemeMode::Light, ThemeMode::Dark]);
    assert_eq!(app.theme_mode(), Some(ThemeMode::Dark));
}

#[test]
fn a_palette_refresh_reports_what_came_once_and_runs_a_queued_refresh_after() {
    use opentui::input::OscColor;
    let app = TestApp::with_options(10, 2, AppOptions { palette_size: 1, ..AppOptions::default() });
    let seen = Rc::new(RefCell::new(Vec::new()));
    app.on_palette({
        let seen = Rc::clone(&seen);
        move |_cx, palette| seen.borrow_mut().push(palette.clone())
    });
    // Colors nobody asked for are ignored.
    app.event(Event::Color(OscColor::Palette(0, Color::rgb(9, 9, 9))));
    app.refresh_palette();
    app.refresh_palette();
    app.event(Event::Color(OscColor::Palette(0, Color::rgb(1, 2, 3))));
    app.event(Event::Color(OscColor::Background(Color::rgb(4, 5, 6))));
    assert!(seen.borrow().is_empty(), "the refresh waits for the rest");
    // No foreground or cursor: the wait ends it with what came, then the queued refresh starts.
    app.advance(Duration::from_secs(1));
    let first = seen.borrow()[0].clone();
    assert_eq!(
        (first.colors, first.background, first.foreground),
        (vec![Some(Color::rgb(1, 2, 3))], Some(Color::rgb(4, 5, 6)), None)
    );
    assert_eq!(app.palette().map(|palette| palette.background), Some(Some(Color::rgb(4, 5, 6))));
    for color in [
        OscColor::Palette(0, Color::rgb(7, 7, 7)),
        OscColor::Foreground(Color::rgb(0, 0, 0)),
        OscColor::Background(Color::rgb(255, 255, 255)),
        OscColor::Cursor(Color::rgb(1, 1, 1)),
    ] {
        app.event(Event::Color(color));
    }
    assert_eq!(seen.borrow().len(), 2, "a complete answer ends the refresh at once");
    // A refresh nobody answers keeps the palette.
    app.refresh_palette();
    app.advance(Duration::from_secs(1));
    assert_eq!(seen.borrow().len(), 2);
    assert_eq!(app.palette().and_then(|palette| palette.background), Some(Color::rgb(255, 255, 255)));
    // Any one color is an answer: the wait ends the refresh with only that color.
    let (rgb, n) = (Color::rgb(1, 2, 3), None);
    let c = Some(rgb);
    for (calls, reply, expected) in [
        (3, OscColor::Palette(0, rgb), (c, n, n, n)),
        (4, OscColor::Foreground(rgb), (n, c, n, n)),
        (5, OscColor::Background(rgb), (n, n, c, n)),
        (6, OscColor::Cursor(rgb), (n, n, n, c)),
    ] {
        app.refresh_palette();
        app.event(Event::Color(reply));
        app.advance(Duration::from_secs(1));
        let palette = app.palette().unwrap();
        let got = (palette.colors[0], palette.foreground, palette.background, palette.cursor);
        assert_eq!((seen.borrow().len(), got), (calls, expected), "{reply:?}");
    }
}

#[test]
fn clipboard_reads_without_a_terminal_report_nothing() {
    use opentui::widget::EditorAction;
    let app = TestApp::new(20, 2);
    let input = Input::new(&app).bind("ctrl+v", EditorAction::Paste);
    app.root().add(&input);
    input.focus();
    let result = Rc::new(RefCell::new(None));
    app.read_clipboard({
        let result = Rc::clone(&result);
        move |_cx, text| *result.borrow_mut() = Some(text)
    });
    assert!(app.wait_until(Duration::from_secs(1), || result.borrow().is_some()));
    assert_eq!(*result.borrow(), Some(None));
    app.press("ctrl+v");
    app.paste_from_clipboard();
    app.advance(Duration::from_millis(10));
    assert_eq!(input.value(), "");
}

#[test]
fn line_numbers_follow_wrapping_signs_and_colors() {
    use opentui::widget::{LineColor, LineNumbers, LineSign};
    let app = TestApp::new(20, 4);
    let editor = Textarea::new(&app).grow(1.0);
    editor.set_text("one\ntwo is long\nthree");
    let numbered = LineNumbers::new(&app, &editor).grow(1.0);
    // Before the first frame the editor has no width, so it wraps nothing.
    assert_eq!(editor.view().info(false).unwrap().total_virtual_line_count, 3);
    app.root().add(&numbered);
    assert_eq!(rows(&app), [" 1 one", " 2 two is long", " 3 three", ""]);
    assert_eq!(app.render().cell(1, 0).unwrap().fg, app.theme().muted);
    // A narrow view wraps line 2; only its first row is numbered.
    app.resize(12, 4);
    assert_eq!(rows(&app), [" 1 one", " 2 two is", "   long", " 3 three"]);
    app.resize(20, 4);
    numbered.line_sign(1, LineSign::before("●", Color::RED)).line_sign(2, LineSign::after("+", Color::GREEN));
    numbered.line_color(0, LineColor::new(Color::BLUE, Color::rgb(10, 20, 30)));
    // The before and after signs widen the gutter by one cell each.
    assert_eq!(rows(&app), ["  1  one", "● 2  two is long", "  3+ three", ""]);
    let capture = app.render();
    assert_eq!(capture.cell(0, 1).unwrap().fg, Color::RED);
    assert_eq!(capture.cell(3, 2).unwrap().fg, Color::GREEN);
    assert_eq!(capture.cell(0, 0).unwrap().bg, Color::BLUE);
    numbered.line_number(2, 42).hide_line_number(0, true).offset(100);
    assert_eq!(rows(&app), ["       one", "● 102  two is long", "   42+ three", ""]);
    // Numbers follow scrolling: replacing the text moves the cursor, and the view, to the end.
    editor.set_text((1..=10).map(|n| format!("line {n}")).collect::<Vec<_>>().join("\n"));
    numbered.clear_line_signs().clear_line_colors().offset(0).hide_line_number(0, false).line_number(2, None);
    assert_eq!(rows(&app), ["  7 line 7", "  8 line 8", "  9 line 9", " 10 line 10"]);
}

#[test]
fn gutter_text_blends_once_into_an_alpha_line_color() {
    use opentui::widget::{LineColor, LineNumbers, LineSign};
    let app = TestApp::new(20, 2);
    let editor = Textarea::new(&app).grow(1.0);
    editor.set_text("one\ntwo");
    let numbered = LineNumbers::new(&app, &editor)
        .grow(1.0)
        .fg(Color::rgba(238, 238, 238, 135))
        .bg(Color::rgb(20, 20, 20))
        .gutter_padding(1);
    numbered.line_color(0, LineColor::new(Color::rgba(184, 0, 73, 51), None));
    numbered.line_sign(0, LineSign::after("-", Color::rgb(252, 107, 131)));
    app.root().add(&numbered);
    let capture = app.render();
    let row: Vec<_> = (0..4).map(|x| capture.cell(x, 0).unwrap().clone()).collect();
    // Core composites its gutter buffer once: the padding, the number, and the sign share one background, and
    // the number's alpha color is blended into it.
    assert!(row.iter().all(|cell| cell.bg == row[0].bg), "{row:?}");
    assert_eq!(row.iter().find(|cell| cell.symbol == "1").unwrap().fg.a, 255, "{row:?}");
}

#[test]
fn a_diff_gutter_blends_alpha_line_colors_over_its_line_number_background() {
    use opentui::widget::{Diff, DiffColors};
    let tint = Color::rgba(184, 0, 73, 51);
    let colors = DiffColors {
        line_number_bg: Color::rgb(20, 20, 20),
        removed_line_number_bg: tint,
        ..DiffColors::from_theme(&Theme::default())
    };
    let app = TestApp::new(30, 2);
    let diff = Diff::new(&app).grow(1.0).colors(colors);
    diff.set_diff("--- a/x\n+++ b/x\n@@ -1,2 +1,1 @@\n a\n-b\n");
    app.root().add(&diff);
    // Core's gutter is a LineNumbers with the line number background: the removed line's tint blends over it.
    let reference = TestApp::new(30, 2);
    let paint = View::new(&reference).bg(Color::rgb(20, 20, 20)).width(1).height(1);
    paint.add(&View::new(&reference).bg(tint).width(1).height(1));
    reference.root().add(&paint);
    assert_eq!(app.render().cell(0, 1).unwrap().bg, reference.render().cell(0, 0).unwrap().bg);
}

#[test]
fn diffs_show_unified_and_split_views_with_numbers_signs_and_colors() {
    use opentui::widget::{Diff, DiffColors, DiffView};
    let app = TestApp::new(50, 8);
    let diff = Diff::new(&app).grow(1.0);
    let patch = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,4 +1,3 @@\n fn main() {\n-    old();\n-    gone();\n+    new();\n }\n\
                 @@ -10,2 +10,3 @@\n a\n+b\n c\n";
    diff.set_diff(patch);
    app.root().add(&diff);
    assert_eq!(
        rows(&app),
        [
            "  1   fn main() {",
            "  2 -     old();",
            "  3 -     gone();",
            "  2 +     new();",
            "  3   }",
            " 10   a",
            " 11 + b",
            " 12   c"
        ]
    );
    assert_eq!(diff.hunk_lines(), [0, 5]);
    let colors = DiffColors::from_theme(&app.theme());
    let capture = app.render();
    assert_eq!(capture.cell(3, 1).unwrap().fg, colors.removed_sign);
    assert_eq!(capture.cell(3, 3).unwrap().fg, colors.added_sign);
    assert_eq!(capture.cell(10, 1).unwrap().bg, colors.removed_bg);
    assert_eq!(capture.cell(30, 3).unwrap().bg, colors.added_bg);
    assert_ne!(capture.cell(10, 0).unwrap().bg, colors.added_bg);

    diff.view(DiffView::Split);
    assert_eq!(
        rows(&app),
        [
            "  1   fn main() {          1   fn main() {",
            "  2 -     old();           2 +     new();",
            "  3 -     gone();",
            "  4   }                    3   }",
            " 10   a                   10   a",
            "                          11 + b",
            " 11   c                   12   c",
            "",
        ]
    );
    assert_eq!(diff.hunk_lines(), [0, 4]);

    // The two columns scroll together.
    app.resize(50, 3);
    app.render();
    let (left, right) = diff.code_views();
    left.scroll_to(3);
    assert_eq!(right.scroll_position(), 3);
    app.scroll(30, 1, false);
    assert_eq!((left.scroll_position(), right.scroll_position()), (2, 2));

    diff.set_diff("@@ broken\n");
    assert_eq!(rows(&app)[0], "Error parsing diff: unknown hunk header on line 1:");

    // Same displayed text: changing every marker adds map buckets, not a string allocation per row.
    diff.view(DiffView::Unified);
    let context = format!("@@ -1,128 +1,128 @@\n{}", " x\n".repeat(128));
    diff.set_diff(&context);
    let rebuild = |patch: &str| {
        let before = allocations::count();
        diff.set_diff(patch);
        allocations::count() - before
    };
    for (ranges, line) in [("-0,0 +1,128", "+x\n"), ("-1,128 +0,0", "-x\n")] {
        let signed = format!("@@ {ranges} @@\n{}", line.repeat(128));
        assert!(rebuild(&signed) < rebuild(&context) + 128, "each {line:?} row allocated its own sign");
    }
}

#[test]
fn macos_scroll_acceleration_ramps_up_in_bursts() {
    use opentui::widget::{MacOsScroll, ScrollAcceleration};
    let mut acceleration = MacOsScroll::default();
    let start = std::time::Instant::now();
    let at = |ms: u64| start + Duration::from_millis(ms);
    assert_eq!(acceleration.tick(at(0)), 1.0);
    let quick: Vec<f64> = [10, 20, 30, 40].iter().map(|&ms| acceleration.tick(at(ms))).collect();
    assert!(quick.windows(2).all(|pair| pair[1] >= pair[0]), "{quick:?}");
    assert_eq!(*quick.last().unwrap(), 6.0);
    // A duplicate step from the same notch counts as one, and a pause starts over.
    assert_eq!(acceleration.tick(at(43)), 1.0);
    assert_eq!(acceleration.tick(at(400)), 1.0);
    assert!(acceleration.tick(at(500)) < 1.5);
}

fn scroll_box_with_lines(app: &TestApp, lines: usize) -> ScrollBox {
    let scroll = ScrollBox::new(app).grow(1.0);
    for line in 0..lines {
        scroll.add(&Text::new(app, format!("line {line}")));
    }
    app.root().add(&scroll);
    app.render();
    scroll
}

#[test]
fn accelerated_wheel_bursts_scroll_further() {
    use opentui::widget::MacOsScroll;
    let app = TestApp::new(20, 5);
    let scroll = scroll_box_with_lines(&app, 200).scroll_acceleration(MacOsScroll::default());
    for _ in 0..5 {
        app.scroll(2, 2, true);
        app.advance(Duration::from_millis(20));
    }
    assert!(scroll.scroll_position().1 > 10.0, "{:?}", scroll.scroll_position());
    // Keys reset the burst: a slow step scrolls one row.
    scroll.perform(ScrollAction::Top);
    app.advance(Duration::from_millis(300));
    app.scroll(2, 2, true);
    assert_eq!(scroll.scroll_position().1, 1.0);
}

// Core's offsets: a sticky box follows only its start edge, and stays stuck after a scroll in a range of one cell.
#[test]
fn sticky_boxes_follow_only_the_edge_they_start_at() {
    use opentui::widget::ScrollEdge::{self, *};
    // Edge, content size, explicit scroll, grown size, offset after growing with and without a frame in between.
    let cases: [(ScrollEdge, u16, f64, u16, [f64; 2]); 11] = [
        (Bottom, 3, 0.0, 6, [4.0, 4.0]),
        (Bottom, 4, 1.0, 6, [1.0, 1.0]),
        (Bottom, 6, 0.0, 7, [0.0, 0.0]),
        (Bottom, 6, 2.0, 7, [2.0, 2.0]),
        (Bottom, 6, f64::INFINITY, 7, [5.0, 5.0]),
        (Top, 3, 1.0, 6, [0.0, 0.0]),
        (Top, 3, f64::INFINITY, 6, [0.0, 0.0]),
        (Top, 6, f64::INFINITY, 7, [4.0, 5.0]),
        (Top, 6, 2.0, 7, [2.0, 2.0]),
        (Right, 3, 0.0, 6, [4.0, 4.0]),
        (Left, 6, f64::INFINITY, 7, [4.0, 5.0]),
    ];
    for ((edge, before, to, after, expected), frame) in cases.into_iter().flat_map(|case| [(case, 0), (case, 1)]) {
        let (app, x) = (TestApp::new(4, 2), matches!(edge, Left | Right));
        let scroll = ScrollBox::new(&app).size(2, 2).axes(x, !x).scrollbars(false).sticky(true).sticky_start(edge);
        let size =
            |view: &View, length: u16| if x { view.width(length).height(2) } else { view.width(2).height(length) };
        let content = size(&View::new(&app).shrink(0.0), before);
        app.root().add(&scroll.child(&content));
        app.render();
        scroll.scroll_to(if x { to } else { 0.0 }, if x { 0.0 } else { to });
        if frame == 0 {
            app.render();
        }
        size(&content, after);
        app.render();
        let (offset_x, offset_y) = scroll.scroll_position();
        assert_eq!(if x { offset_x } else { offset_y }, expected[frame], "{edge:?} {before} {to} {after} {frame}");
    }
    // Both axes: x has no edge, and setting one edge leaves the other axis's follow alone.
    let app = TestApp::new(4, 2);
    let scroll = ScrollBox::new(&app).size(2, 2).axes(true, true).scrollbars(false).sticky(true);
    let content = View::new(&app).shrink(0.0).width(6).height(8);
    app.root().add(&scroll.child(&content));
    app.render();
    scroll.scroll_to(f64::INFINITY, 3.0);
    app.render();
    content.width(8).height(4);
    app.render();
    assert_eq!(scroll.scroll_position(), (4.0, 2.0));
    scroll.sticky_start(Right);
    app.render();
    content.height(8);
    app.render();
    assert_eq!(scroll.scroll_position(), (6.0, 2.0));
}

#[test]
fn scrollbar_arrows_scroll_and_repeat_while_held() {
    let app = TestApp::new(20, 10);
    let scroll = scroll_box_with_lines(&app, 100).scrollbar_arrows(true);
    app.render();
    let capture = app.render();
    assert_eq!((capture.row(0).chars().last(), capture.row(9).chars().last()), (Some('▲'), Some('▼')));
    app.mouse(MouseEventKind::Down(MouseButton::Left), 19, 9);
    assert_eq!(scroll.scroll_position().1, 5.0);
    app.advance(Duration::from_millis(499));
    assert_eq!(scroll.scroll_position().1, 5.0);
    app.advance(Duration::from_millis(1));
    assert_eq!(scroll.scroll_position().1, 10.0);
    app.advance(Duration::from_millis(200));
    app.advance(Duration::from_millis(200));
    assert_eq!(scroll.scroll_position().1, 14.0);
    app.mouse(MouseEventKind::Up(MouseButton::Left), 19, 9);
    app.advance(Duration::from_millis(1000));
    assert_eq!(scroll.scroll_position().1, 14.0);
}

#[test]
fn dragging_a_selection_past_the_edge_scrolls_and_extends_it() {
    let app = TestApp::new(20, 6);
    let scroll = scroll_box_with_lines(&app, 50);
    app.mouse(MouseEventKind::Down(MouseButton::Left), 0, 0);
    app.mouse(MouseEventKind::Drag(MouseButton::Left), 3, 5);
    for _ in 0..30 {
        app.advance(Duration::from_millis(16));
        app.render();
    }
    let position = scroll.scroll_position().1;
    assert!(position >= 5.0, "{position}");
    app.mouse(MouseEventKind::Up(MouseButton::Left), 3, 5);
    let selected = app.selected_text().unwrap_or_default();
    assert!(selected.starts_with("line 0\nline 1\n"), "{selected:?}");
    assert!(selected.lines().count() > 6, "{selected:?}");
    // Once released, it stops.
    app.advance(Duration::from_millis(500));
    app.render();
    assert_eq!(scroll.scroll_position().1, position);
}

#[test]
fn markdown_renders_nested_lists_quotes_and_tables() {
    use opentui::widget::Markdown;
    let app = TestApp::new(30, 18);
    let doc = Markdown::new(&app).set_markdown(
        "- one\n  - nested\n    1. deep\n- [ ] todo\n\n> quote\n> - inside\n\n| Name | Size |\n| :--- | ---: |\n| a | 1 |\n| bb | 22 |",
    );
    app.root().add(&doc);
    assert_eq!(
        rows(&app),
        [
            "- one",
            "  - nested",
            "    1. deep",
            "- ☐ todo",
            "",
            "│ quote",
            "│",
            "│ - inside",
            "",
            "┌──────────────┬─────────────┐",
            "│Name          │         Size│",
            "├──────────────┼─────────────┤",
            "│a             │            1│",
            "├──────────────┼─────────────┤",
            "│bb            │           22│",
            "└──────────────┴─────────────┘",
            "",
            "",
        ]
    );
    // The header row is bold.
    assert!(app.render().cell(1, 10).unwrap().attributes.contains(Attributes::BOLD));
    // A document taller than its parent overflows instead of squeezing its rows together.
    app.resize(30, 6);
    assert_eq!(rows(&app)[..4], ["- one", "  - nested", "    1. deep", "- ☐ todo"]);
}

#[test]
fn streamed_markdown_keeps_finished_blocks_and_updates_the_last_in_place() {
    use opentui::widget::Markdown;
    for streaming in [false, true] {
        let app = TestApp::new(30, 8);
        let doc = Markdown::new(&app).streaming(streaming).set_markdown("# Title\n\nStreaming");
        app.root().add(&doc);
        app.render();
        let (title, paragraph) = (app.widget_at(0, 0).unwrap(), app.widget_at(0, 2).unwrap());
        doc.append(" text arrives");
        assert_eq!(rows(&app)[2], "Streaming text arrives");
        assert_eq!((app.widget_at(0, 0).unwrap(), app.widget_at(0, 2).unwrap()), (title.clone(), paragraph.clone()));
        doc.append("\n\n```rust\nfn a() {}");
        app.render();
        let code = app.widget_at(1, 4).unwrap();
        doc.append("\nfn b() {}\n```\n\nDone.");
        assert_eq!(rows(&app)[4..8], ["fn a() {}", "fn b() {}", "", "Done."]);
        assert_eq!(app.widget_at(1, 4).unwrap(), code);
        assert_eq!(app.widget_at(0, 2).unwrap(), paragraph);
        // Finishing the stream parses the whole document again and keeps every widget.
        doc.streaming(false);
        assert_eq!((app.widget_at(0, 0).unwrap(), app.widget_at(1, 4).unwrap()), (title, code));
    }
}

#[test]
fn atomic_extmarks_move_with_edits_and_act_as_one_unit() {
    use opentui::widget::ExtmarkOptions;
    let app = TestApp::new(30, 2);
    let input = Input::new(&app).width(30);
    app.root().add(&input);
    input.focus();
    app.type_text("see ");
    let start = input.cursor_offset();
    input.insert("@main.rs");
    let mention = input.add_extmark(
        start..input.cursor_offset(),
        ExtmarkOptions::default().atomic().style(Style::new().bg(Color::BLUE)),
    );
    app.type_text(" now");
    assert_eq!(input.extmark(mention).unwrap().range(), 4..12);
    let capture = app.render();
    assert_eq!((capture.cell(4, 0).unwrap().bg, capture.cell(11, 0).unwrap().bg), (Color::BLUE, Color::BLUE));
    assert_ne!(capture.cell(12, 0).unwrap().bg, Color::BLUE);

    // The cursor jumps over the mark as Core's does: left from its end to one before its start, right from there or
    // from its start to its end.
    for _ in 0..4 {
        app.press("left");
    }
    assert_eq!(input.cursor_offset(), 12);
    app.press("left");
    assert_eq!(input.cursor_offset(), 3);
    app.press("right");
    assert_eq!(input.cursor_offset(), 12);
    input.set_cursor_offset(4);
    app.press("right");
    assert_eq!(input.cursor_offset(), 12);
    // An offset inside moves to the nearer edge.
    assert_eq!(input.set_cursor_offset(5).cursor_offset(), 4);
    // Text typed before the mark moves it.
    app.type_text("a ");
    assert_eq!(input.value(), "see a @main.rs now");
    let saved = input.extmark(mention).unwrap();
    assert_eq!(saved.range(), 6..14);
    assert_eq!(input.extmarks_at(10).len(), 1);
    // Backspace at its end deletes all of it as one edit.
    input.set_cursor_offset(14);
    app.press("backspace");
    assert_eq!(input.value(), "see a  now");
    assert_eq!(input.extmark(mention), None);
    // Undo brings the mark back with the text, its options included, and redo removes it again (473).
    app.press("ctrl+-");
    assert_eq!(input.value(), "see a @main.rs now");
    assert_eq!(input.extmark(mention), Some(saved));
    app.press("ctrl+.");
    assert_eq!((input.value().as_str(), input.extmark(mention)), ("see a  now", None));
    app.press("ctrl+-");
    // Delete at the start of a mark does the same; replacing the value removes every mark.
    let again = input.add_extmark(6..14, ExtmarkOptions::default().atomic());
    input.set_cursor_offset(6);
    app.press("delete");
    assert_eq!((input.value().as_str(), input.extmark(again)), ("see a  now", None));
    input.add_extmark(0..3, ExtmarkOptions::default());
    input.set_value("fresh");
    assert!(input.extmarks().is_empty());
}

#[test]
fn moves_into_an_atomic_extmark_go_to_its_nearer_edge() {
    use opentui::widget::ExtmarkOptions;
    // As Core's: nearer the start goes to the start of the character before it, even a wide one or a tab, or with
    // none to the end of the line above; halfway or nearer the end to the end. The mark is on row 1 after `char`, at
    // 11 + width..19 + width.
    for (char, width) in [("a", 1), ("日", 2), ("👍", 2), ("\t", 2), ("", 0)] {
        let app = TestApp::new(20, 4);
        let area = Textarea::new(&app).grow(1.0);
        area.set_text(format!("0123456789\n{char}@main.rs\nxxxxxxxxxx"));
        app.root().add(&area);
        area.focus();
        area.add_extmark(11 + width..19 + width, ExtmarkOptions::default().atomic());
        app.render();
        let before = if width == 0 { 10 } else { 11 };
        for (key, from, to) in [
            ("left", 19 + width, before),
            ("down", width + 1, before),
            ("up", 20 + width + width + 1, before),
            ("down", width + 4, 19 + width),
            ("down", width + 6, 19 + width),
        ] {
            area.set_cursor_offset(from);
            app.press(key);
            assert_eq!(area.cursor_offset(), to, "{key} from {from} after {char:?}");
        }
    }
    // Down never goes back: when the start of the character before the mark is where it started, it goes to the end,
    // and past marks that overlap that end, but not past one that starts there.
    let wrapped = "日@mainrsxyzuvwABCDEFGHIJKL";
    for (text, columns, from, marks, to) in [
        ("a\n\n@main.rs\nb", 20, 2, &[(3, 11)][..], 11),
        (wrapped, 6, 0, &[(2, 15)], 15),
        (wrapped, 6, 0, &[(2, 15), (14, 19), (18, 23), (22, 27)], 27),
        (wrapped, 6, 0, &[(2, 15), (15, 17)], 15),
    ] {
        let app = TestApp::new(columns, 4);
        let area = Textarea::new(&app).grow(1.0);
        area.set_text(text);
        app.root().add(&area);
        area.focus();
        for &(start, end) in marks {
            area.add_extmark(start..end, ExtmarkOptions::default().atomic());
        }
        app.render();
        area.set_cursor_offset(from);
        app.press("down");
        assert_eq!(area.cursor_offset(), to, "down from {from} with {marks:?}");
    }
    // Overlapping marks: Up and Backspace take the mark added first, whatever its position.
    let app = TestApp::new(20, 4);
    let area = Textarea::new(&app).grow(1.0);
    area.set_text("0123456789\n0123456789\n0123456789");
    app.root().add(&area);
    area.focus();
    for (start, end) in [(14, 20), (11, 16)] {
        area.add_extmark(start..end, ExtmarkOptions::default().atomic());
    }
    app.render();
    area.set_cursor_offset(26);
    app.press("up");
    assert_eq!(area.cursor_offset(), 11);
    area.set_text("abcd");
    for (start, end) in [(1, 4), (0, 4)] {
        area.add_extmark(start..end, ExtmarkOptions::default().atomic());
    }
    area.set_cursor_offset(4);
    app.press("backspace");
    assert_eq!(area.text(), "a");
    // One mark at a time: chips whose separator spaces were deleted are stepped over and deleted one by one; an older
    // mark around the cursor does not hide a newer one whose edge is there; the second cell of a wide character is
    // not a stop; Up from the end of a wrapped mark does not stay there. The cursor is set before the marks.
    for (text, columns, marks, from, keys, to, after) in [
        ("xx @a@b@c yy", 20, &[(3, 5), (5, 7), (7, 9)][..], 2, &["right", "delete", "backspace"][..], 3, "xx @c yy"),
        ("abcdefghijklmno", 20, &[(1, 8), (3, 6)], 3, &["delete"], 3, "abcghijklmno"),
        ("abcdefghijklmno", 20, &[(1, 8), (3, 6)], 6, &["backspace"], 3, "abcghijklmno"),
        ("a日b", 20, &[], 2, &[], 1, "a日b"),
        (wrapped, 6, &[(2, 15)], 15, &["up"], 0, wrapped),
    ] {
        let app = TestApp::new(columns, 4);
        let area = Textarea::new(&app).grow(1.0);
        area.set_text(text);
        app.root().add(&area);
        area.focus();
        app.render();
        area.set_cursor_offset(from);
        for &(start, end) in marks {
            area.add_extmark(start..end, ExtmarkOptions::default().atomic());
        }
        keys.iter().for_each(|key| app.press(key));
        assert_eq!((area.cursor_offset(), area.text().as_str()), (to, after), "{keys:?} from {from} in {text:?}");
    }
}

#[test]
fn mouse_and_wheel_leave_the_cursor_outside_atomic_extmarks() {
    use opentui::widget::ExtmarkOptions;
    // One row of a 24x2 app; a click on row 1 clears a selection left. While a selection is left the cursor and the
    // selection are `held`. A press's handlers see the pressed cell; then a pointer leaves the cursor at the nearer
    // outer edge of the marks around it, a cleared drag at the side it came from, the wheel and the setter at the edge
    // they moved toward. "press" drags through its other cells and types Z before the release. `then` is a key, a wheel step or an offset after the gesture.
    let one = &[(2, 7)][..];
    let pasted = "x [Pasted ~20 lines] y";
    // Rows "@file ", "abcdefghijklmnopqrstuvwx", "yzabcdefghijklmnopqrstuv", "wxyz", "q": a wheel step lands on "wxyz".
    let wrapped = "@file abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz\nq";
    for (text, marks, from, gesture, held, to) in [
        ("x @file y", one, 9, "click 2", None, 2),
        ("x @file y", one, 9, "click 3", None, 2),
        ("x @file y", one, 9, "click 5", None, 7),
        ("x @file y", one, 9, "press 3", None, 3),
        ("x @file y", one, 9, "press 3 5 3", None, 3),
        (pasted, &[(2, 20)], 22, "click 15", None, 20),
        ("x @file y", one, 9, "double-click 4", Some((4, (2, 7))), 2),
        ("x @file y", one, 9, "double-click 4, offset 3", None, 2),
        ("x @file y", one, 9, "drag 0 4", Some((4, (0, 5))), 2),
        ("x @file y", one, 9, "drag 8 4", Some((4, (4, 9))), 7),
        ("x @file y", one, 9, "drag 8 6", Some((6, (6, 9))), 7),
        ("x @file y", one, 9, "drag 0 4, right", None, 7),
        ("x @file y", one, 9, "drag 8 6, shift+left", Some((2, (2, 9))), 2),
        ("x @file y", one, 9, "offset 1, shift+right", Some((7, (1, 8))), 7),
        ("x @file y", one, 9, "drag 0 1, shift+right", Some((2, (0, 3))), 2),
        ("b ca", &[(0, 3), (0, 4)], 4, "click 2", None, 4),
        ("b ca", &[(0, 4), (0, 3)], 4, "click 2", None, 4),
        ("abcdefgh", &[(0, 6), (2, 8)], 8, "click 3", None, 0),
        ("abcdefgh", &[(2, 8), (0, 6)], 8, "click 3", None, 0),
        ("b ca", &[(0, 3), (0, 4)], 0, "offset 2", None, 4),
        ("b ca", &[(0, 4), (0, 3)], 4, "offset 2", None, 0),
        ("abcd", &[(2, 4), (1, 3), (0, 2)], 0, "offset 1", None, 4),
        ("ab\n@file\nc", &[(3, 8)], 2, "wheel down", None, 8),
        ("ab\n@file\nc", &[(3, 8)], 10, "wheel up", None, 3),
        (wrapped, &[(0, 5)], 60, "wheel up", None, 55),
        ("abcd\n@file\nc", &[(5, 10)], 0, "double-click 2, wheel down", Some((7, (0, 4))), 5),
    ] {
        let app = TestApp::new(24, 2);
        let area = Textarea::new(&app).set_text(text).height(1);
        app.root().add(&area);
        area.focus();
        for &(start, end) in marks {
            area.add_extmark(start..end, ExtmarkOptions::default().atomic());
        }
        area.set_cursor_offset(from);
        app.render();
        // As OpenCode's prompt: after a press, look up the mark under the cursor.
        let pressed = Rc::new(Cell::new(None));
        area.on_mouse({
            let (area, pressed) = (area.clone(), Rc::clone(&pressed));
            move |cx, event| {
                if event.kind == MouseEventKind::Down(MouseButton::Left) {
                    let (area, pressed) = (area.clone(), Rc::clone(&pressed));
                    cx.app().defer(move |_| pressed.set(Some(area.cursor_offset())));
                }
            }
        });
        let (first, then) = gesture.split_once(", ").unwrap_or((gesture, ""));
        let n: Vec<u16> = first.split(' ').filter_map(|n| n.parse().ok()).collect();
        match first.split(' ').next().unwrap() {
            "click" => app.click(n[0], 0),
            "press" => {
                app.mouse(MouseEventKind::Down(MouseButton::Left), n[0], 0);
                n[1..].iter().for_each(|&x| app.mouse(MouseEventKind::Drag(MouseButton::Left), x, 0));
                app.type_text("Z");
                app.mouse(MouseEventKind::Up(MouseButton::Left), n[n.len() - 1], 0);
                assert_eq!(area.text(), "x Z@file y", "{gesture}: typed before the release");
            }
            "double-click" => (0..2).for_each(|_| app.click(n[0], 0)),
            "drag" => app.drag((n[0], 0), (n[1], 0)),
            "offset" => drop(area.set_cursor_offset(u32::from(n[0]))),
            _ => app.scroll(0, 0, first.ends_with("down")),
        }
        if first.starts_with("click") || first.starts_with("press") {
            assert_eq!(pressed.get(), Some(u32::from(n[0])), "{gesture}: the press's handler");
        }
        match then.split_once(' ') {
            Some(("wheel", way)) => app.scroll(0, 0, way == "down"),
            Some(("offset", at)) => drop(area.set_cursor_offset(at.parse().unwrap())),
            _ if !then.is_empty() => app.press(then),
            _ => {}
        }
        let selection = area.view().selection().unwrap().filter(|(start, end)| start != end);
        assert_eq!(selection.map(|range| (area.cursor_offset(), range)), held, "{gesture} in {text:?} with {marks:?}");
        if selection.is_some() {
            app.click(0, 1);
        }
        assert_eq!(area.cursor_offset(), to, "{gesture} from {from} in {text:?} with {marks:?}");
    }
    // An undo that brings back the only mark leaves the cursor outside it, as other edits do.
    let app = TestApp::new(24, 2);
    let area = Textarea::new(&app).set_text("x ABCD y").height(1);
    app.root().add(&area);
    area.focus();
    area.add_extmark(2..6, ExtmarkOptions::default().atomic());
    app.render();
    app.drag((0, 0), (3, 0));
    app.press("backspace");
    assert_eq!(area.text(), "CD y");
    app.press("ctrl+-");
    assert_eq!((area.text().as_str(), area.cursor_offset()), ("x ABCD y", 6));
}

#[test]
fn styled_extmarks_follow_text_across_lines_and_grow_inside() {
    use opentui::widget::ExtmarkOptions;
    let app = TestApp::new(20, 4);
    let area = Textarea::new(&app).grow(1.0);
    area.set_text("one\ntwo\nthree");
    app.root().add(&area);
    let style = Style::new().bg(Color::RED);
    let mark = area.add_extmark(4..7, ExtmarkOptions::default().style(style));
    assert_eq!(app.render().cell(0, 1).unwrap().bg, Color::RED);
    area.focus();
    area.set_cursor_offset(0);
    app.type_text("zero");
    app.press("enter");
    assert_eq!(area.extmark(mark).unwrap().range(), 9..12);
    let capture = app.render();
    assert_eq!((capture.cell(0, 2).unwrap().bg, capture.cell(2, 2).unwrap().bg), (Color::RED, Color::RED));
    assert_ne!(capture.cell(0, 1).unwrap().bg, Color::RED);
    // Typing inside a plain mark grows it; deleting all of its text removes it.
    area.set_cursor_offset(10);
    app.type_text("w");
    assert_eq!(area.extmark(mark).unwrap().range(), 9..13);
    area.set_cursor_offset(13);
    for _ in 0..4 {
        app.press("backspace");
    }
    assert_eq!(area.text(), "zero\none\n\nthree");
    assert_eq!(area.extmark(mark), None);
}

#[test]
fn hovered_widgets_choose_the_pointer_shape() {
    let app = TestApp::new(20, 3);
    let input = Input::new(&app).width(20);
    let button = View::new(&app).height(1).mouse_pointer(MousePointer::POINTER).child(&Text::new(&app, "Click me"));
    app.root().add(&input).add(&button);
    app.render();
    assert_eq!(app.mouse_pointer(), MousePointer::DEFAULT);
    app.hover(3, 0);
    assert_eq!(app.mouse_pointer(), MousePointer::TEXT);
    // The text inside the button has no shape of its own, so the button's applies.
    app.hover(3, 1);
    assert_eq!(app.mouse_pointer(), MousePointer::POINTER);
    app.hover(3, 2);
    assert_eq!(app.mouse_pointer(), MousePointer::DEFAULT);
}

#[test]
fn the_debug_overlay_toggles_and_frames_keep_painting() {
    use opentui::app::Corner;
    let app = TestApp::new(60, 12);
    app.root().add(&Text::new(&app, "content"));
    assert_eq!(app.debug_overlay(), None);
    app.toggle_debug_overlay();
    assert_eq!(app.debug_overlay(), Some(Corner::TopRight));
    // Native code draws the overlay while encoding output, after frames are captured, so only painting is checked.
    for _ in 0..3 {
        app.advance(Duration::from_millis(16));
        assert_eq!(rows(&app)[0], "content");
    }
    app.set_debug_overlay(Some(Corner::BottomLeft));
    app.toggle_debug_overlay();
    assert_eq!(app.debug_overlay(), None);
}

#[test]
fn the_console_shows_messages_from_any_thread() {
    use opentui::console::{ConsoleColors, ConsolePosition, LogLevel};
    let app = TestApp::new(40, 10);
    app.root().add(&Text::new(&app, "app content"));
    let console = app.console();
    console.log(LogLevel::Info, "starting");
    let sender = console.sender();
    std::thread::spawn(move || sender.warn("from a worker\nsecond line")).join().unwrap();
    // A message from another thread arrives once the app runs queued work.
    assert!(app.wait_until(Duration::from_secs(1), || console.entries().len() == 2));
    assert_eq!(console.entries()[1].level, LogLevel::Warn);
    assert!(!console.is_visible());
    assert_eq!(rows(&app)[0], "app content");

    console.show();
    let screen = rows(&app);
    // Docked to the bottom 30%: a title bar and two rows that follow the latest messages.
    assert!(screen[7].starts_with(" Console (2)"), "{screen:?}");
    assert!(screen[8].ends_with("WARN  from a worker"), "{screen:?}");
    assert_eq!(screen[9], "  second line");
    let capture = app.render();
    let colors = ConsoleColors::default();
    let message_x = screen[8].find("from").unwrap() as u32;
    assert_eq!(capture.cell(message_x, 8).unwrap().fg, colors.warn);

    // Following new messages; moving and resizing; Escape hides it.
    console.log(LogLevel::Error, "failed");
    assert!(rows(&app)[9].ends_with("ERROR failed"));
    // Scrolled up, it keeps its place as messages arrive.
    console.focus();
    app.press("home");
    console.log(LogLevel::Info, "later");
    assert!(rows(&app)[8].ends_with("starting"), "{:?}", rows(&app));
    console.position(ConsolePosition::Right).size_percent(50.0);
    assert!(rows(&app)[0].starts_with("app content         "), "{:?}", rows(&app));
    console.focus();
    app.press("escape");
    assert!(!console.is_visible());
    assert!(console.text().contains("WARN  from a worker\n  second line"));
}

#[test]
fn drags_report_targets_and_drops() {
    let app = TestApp::new(30, 3);
    let label = Text::new(&app, "card").selectable(false);
    let card = View::new(&app).width(8).height(1).child(&label);
    let left = View::new(&app).width(10).height(3).border(BorderStyle::Single);
    let right = View::new(&app).width(10).height(3).border(BorderStyle::Single);
    app.root().add(&View::new(&app).row().child(&card).child(&left).child(&right));
    let log = Rc::new(RefCell::new(Vec::new()));
    for (name, target) in [("left", &left), ("right", &right)] {
        let over_log = Rc::clone(&log);
        let drop_log = Rc::clone(&log);
        // As in Core, the source is the widget the drag started on: the deepest one under the pointer.
        let card_id = label.id();
        target.on_drag_over(move |_cx, source, over| {
            assert_eq!(source.id(), card_id);
            over_log.borrow_mut().push(format!("{name} {}", if over { "over" } else { "out" }));
        });
        target.on_drop(move |_cx, source, event| {
            assert_eq!(source.id(), card_id);
            drop_log.borrow_mut().push(format!("drop on {name} at {}", event.x));
        });
    }
    app.render();
    // From the card, across the left box, onto the right one.
    app.drag((1, 0), (22, 1));
    assert_eq!(*log.borrow(), ["left over", "left out", "right over", "right out", "drop on right at 22"]);
    // Releasing over the card itself is no drop, and text selection drags are no drags.
    log.borrow_mut().clear();
    app.drag((1, 0), (3, 0));
    assert!(log.borrow().is_empty());
    // A press during a drag means the drag's release was lost: the press ends the drag, with its leaves before its own
    // handlers and no drop, on the old target, elsewhere or on the source, and a drag it starts is its own.
    let reenter = Rc::new(Cell::new(false));
    app.root().on_mouse({
        let (log, reenter) = (Rc::clone(&log), Rc::clone(&reenter));
        move |cx, event| {
            if event.kind == MouseEventKind::Down(MouseButton::Left) {
                log.borrow_mut().push("press".to_owned());
                if reenter.get() {
                    let drag = MouseEvent { kind: MouseEventKind::Drag(MouseButton::Left), x: 22, y: 1, ..*event };
                    cx.app().dispatch(Event::Mouse(drag));
                }
            }
        }
    });
    for ((x, y), (to_x, to_y), drag) in [((22, 1), (23, 1), true), ((12, 1), (13, 1), true), ((1, 0), (22, 1), false)] {
        log.borrow_mut().clear();
        app.mouse(MouseEventKind::Down(MouseButton::Left), 1, 0);
        app.mouse(MouseEventKind::Drag(MouseButton::Left), 22, 1);
        app.mouse(MouseEventKind::Down(MouseButton::Left), x, y);
        if drag {
            app.mouse(MouseEventKind::Drag(MouseButton::Left), to_x, to_y);
        }
        app.mouse(MouseEventKind::Up(MouseButton::Left), to_x, to_y);
        assert_eq!(*log.borrow(), ["press", "right over", "right out", "press"]);
    }
    // A drag that the press's handler starts is the new gesture's: its own release ends it, with a drop.
    log.borrow_mut().clear();
    app.mouse(MouseEventKind::Down(MouseButton::Left), 1, 0);
    app.mouse(MouseEventKind::Drag(MouseButton::Left), 22, 1);
    reenter.set(true);
    app.mouse(MouseEventKind::Down(MouseButton::Left), 1, 0);
    app.mouse(MouseEventKind::Up(MouseButton::Left), 22, 1);
    let ends = ["press", "right over", "right out", "press", "right over", "right out", "drop on right at 22"];
    assert_eq!(*log.borrow(), ends);
}

#[test]
fn editor_cursor_options_borders_and_fast_steps() {
    use opentui::native::CursorStyle;
    use opentui::widget::SelectAction;
    let app = TestApp::new(20, 6);
    let input = Input::new(&app).width(20).cursor_style(CursorStyle::Line, false).cursor_color(Color::RED);
    let moves = Rc::new(RefCell::new(Vec::new()));
    input.on_cursor_change({
        let moves = Rc::clone(&moves);
        move |_cx, row, col| moves.borrow_mut().push((row, col))
    });
    let boxed = View::new(&app)
        .size(6, 3)
        .border(BorderStyle::Single)
        .border_chars(Some(['+', '+', '+', '+', '-', '|', '+', '+', '+', '+', '+']));
    let list =
        Select::new(&app).options((0..10).map(|n| n.to_string())).show_description(false).height(2).fast_scroll_step(3);
    app.root().add(&input).add(&boxed).add(&list);
    input.focus();
    app.type_text("ab");
    app.press("left");
    assert_eq!(*moves.borrow(), [(0, 1), (0, 2), (0, 1)]);
    assert_eq!(&rows(&app)[1..4], ["+----+", "|    |", "+----+"]);
    list.perform(SelectAction::MoveDownFast);
    assert_eq!(list.selected(), 3);
}

#[test]
fn frame_buffers_show_drawn_cells_and_follow_their_size() {
    use opentui::widget::FrameBuffer;
    let app = TestApp::new(12, 5);
    let canvas = FrameBuffer::new(&app, 6, 2);
    let behind = View::new(&app).size(6, 1).bg(Color::RED);
    let overlay = FrameBuffer::with_alpha(&app, 6, 1).absolute();
    behind.add(&overlay);
    app.root().add(&Text::new(&app, "top")).add(&canvas).add(&behind);
    let draws = Rc::new(Cell::new(0));
    canvas.on_resize({
        let (canvas, draws) = (canvas.clone(), Rc::clone(&draws));
        move |_cx, rect| {
            draws.set(draws.get() + 1);
            canvas.draw(|buffer| buffer.text(0, 1, &format!("w={}", rect.width), Style::new()));
        }
    });
    canvas.draw(|buffer| buffer.text(1, 0, "hello", Style::new().fg(Color::GREEN)));
    overlay.draw(|buffer| buffer.text(0, 0, "over", Style::new().fg(Color::WHITE)));
    let capture = app.render();
    assert_eq!(capture.row(1).trim_end(), " hello");
    assert_eq!(capture.cell(1, 1).unwrap().fg, Color::GREEN);
    assert_eq!(capture.row(2).trim_end(), "w=6");
    // A transparent background blends with what is under it.
    assert_eq!(capture.row(3).trim_end(), "over");
    assert_eq!(capture.cell(0, 3).unwrap().bg, Color::RED);
    assert_eq!(capture.cell(5, 3).unwrap().bg, Color::RED);
    // A new size clears the cells; the resize handler draws again.
    canvas.width(10);
    assert_eq!(rows(&app)[1..3], ["", "w=10"]);
    assert_eq!(canvas.buffer().unwrap().size(), (10, 2));
    assert_eq!(draws.get(), 2);
}

#[test]
fn wheel_steps_that_code_and_tables_cannot_take_scroll_the_box_around_them() {
    use opentui::widget::{Code, Column, Table};
    let app = TestApp::new(20, 4);
    let scroll = ScrollBox::new(&app).scrollbars(false).grow(1.0);
    let short = Code::new(&app).set_code("one\ntwo").height(3);
    let table = Table::new(&app).set_columns([Column::new("Name")]).set_rows([["a"], ["b"]]).height(3);
    let lines: Vec<String> = (0..10).map(|line| format!("line {line}")).collect();
    let long = Code::new(&app).set_code(lines.join("\n")).height(3);
    scroll.add(&short).add(&table).add(&long);
    for line in 0..10 {
        scroll.add(&Text::new(&app, format!("text {line}")));
    }
    app.root().add(&scroll);
    app.render();
    app.scroll(2, 0, true);
    assert_eq!((scroll.scroll_position().1, short.scroll_position()), (1.0, 0));
    app.render();
    app.scroll(2, 0, false);
    assert_eq!(scroll.scroll_position().1, 0.0);
    // So does a table whose rows all fit.
    scroll.scroll_to(0.0, 3.0);
    app.render();
    app.scroll(2, 1, true);
    assert_eq!(scroll.scroll_position().1, 4.0);
    // A code view with more lines than fit scrolls itself until it reaches an end.
    scroll.scroll_to(0.0, 6.0);
    app.render();
    app.scroll(2, 0, true);
    assert_eq!((scroll.scroll_position().1, long.scroll_position()), (6.0, 1));
    app.scroll(2, 0, false);
    app.scroll(2, 0, false);
    assert_eq!((scroll.scroll_position().1, long.scroll_position()), (5.0, 0));
}

#[test]
fn tab_skips_markdown_code_blocks() {
    use opentui::widget::Markdown;
    let app = TestApp::new(30, 8);
    let before = Input::new(&app);
    let doc = Markdown::new(&app).set_markdown("Text\n\n```rust\nfn main() {}\n```\n\n    indented");
    let after = Input::new(&app);
    app.root().add(&before).add(&doc).add(&after);
    app.render();
    app.press("tab");
    assert!(before.is_focused());
    app.press("tab");
    assert!(after.is_focused());
}

#[test]
fn diffs_keep_their_code_views_and_focus_as_they_change() {
    use opentui::widget::{Diff, DiffColors, DiffView};
    let app = TestApp::new(40, 4);
    let diff = Diff::new(&app).set_diff("@@ -1,2 +1,2 @@\n a\n-b\n+c\n").grow(1.0);
    app.root().add(&diff);
    app.render();
    let (left, right) = diff.code_views();
    left.focus();
    diff.set_diff("@@ -1,2 +1,2 @@\n a\n-b\n+d\n");
    diff.colors(DiffColors { added_sign: Color::RED, ..DiffColors::from_theme(&app.theme()) });
    diff.filetype("rust").syntax_theme(opentui::syntax::SyntaxTheme::default());
    diff.wrap(WrapMode::Word).line_numbers(false).line_numbers(true);
    assert!(left.is_focused());
    // The old file's view stays across views; the new file's leaves with the split view.
    diff.view(DiffView::Split);
    assert!(left.is_focused());
    right.focus();
    diff.view(DiffView::Unified);
    assert_eq!(app.focused(), None);
    assert_eq!(rows(&app), [" 1   a", " 2 - b", " 2 + d", ""]);
    assert_eq!(app.render().cell(3, 2).unwrap().fg, Color::RED);
}

#[cfg(feature = "tree-sitter")]
#[test]
fn markdown_diffs_highlight_a_new_files_heading_and_emphasis() {
    use opentui::syntax::SyntaxTheme;
    use opentui::widget::{Diff, DiffView};
    let app = TestApp::new(40, 2);
    let theme = SyntaxTheme::new()
        .style("text.title", Style::new().fg(Color::RED))
        .style("text.strong", Style::new().fg(Color::GREEN));
    // The added side is `# Lexer` with no line ending after it.
    let diff = Diff::new(&app).filetype("markdown").syntax_theme(theme).view(DiffView::Split).grow(1.0);
    diff.set_diff("@@ -1,1 +1,1 @@\n-Some **bold**\n+# Lexer\n");
    app.root().add(&diff);
    assert_eq!(rows(&app), [" 1 - Some **bold**   1 + # Lexer", ""]);
    let fg = |x| app.render().cell(x, 0).unwrap().fg;
    assert!(app.wait_until(Duration::from_secs(10), || fg(27) == Color::RED), "{:?}", fg(27));
    assert_eq!(fg(10), Color::GREEN);
}

#[test]
fn diffs_without_a_height_show_their_lines_in_one_gutter() {
    use opentui::widget::{Diff, DiffGutter, DiffView};
    let app = TestApp::new(30, 7);
    // As OpenCode's patch view: one diff per hunk, sharing the gutter of the widest line number.
    let gutter = DiffGutter { padding_left: 2, min_digits: Some(2) };
    let first = Diff::new(&app).set_diff("@@ -1,2 +1,2 @@\n a\n-b\n+c\n").gutter(gutter);
    // No signs in this hunk: the sign column stays.
    let second = Diff::new(&app).set_diff("@@ -10,1 +10,1 @@\n x\n").gutter(gutter);
    app.root().add(&first).add(&second).add(&Text::new(&app, "after"));
    assert_eq!(rows(&app), ["   1   a", "   2 - b", "   2 + c", "  10   x", "after", "", ""]);
    // The default gutter sizes to the diff's own numbers.
    first.gutter(DiffGutter::default());
    assert_eq!(rows(&app)[..2], [" 1   a", " 2 - b"]);
    // Split columns still share the width, and the diff is as tall as its rows.
    first.view(DiffView::Split);
    assert_eq!(rows(&app)[..4], [" 1   a          1   a", " 2 - b          2 + c", "  10   x", "after"]);
    first.view(DiffView::Unified);
    assert_eq!(rows(&app)[3..5], ["  10   x", "after"]);
}

#[test]
fn diff_setters_work_from_code_view_handlers() {
    use opentui::widget::{Diff, DiffColors};
    let app = TestApp::new(40, 3);
    let lines: String = (0..10).map(|line| format!(" line {line}\n")).collect();
    let diff = Diff::new(&app).set_diff(format!("@@ -1,10 +1,10 @@\n{lines}")).grow(1.0);
    app.root().add(&diff);
    app.render();
    let (left, _) = diff.code_views();
    left.scroll_to(5);
    let colors = DiffColors { added_sign: Color::RED, ..DiffColors::from_theme(&app.theme()) };
    left.on_scroll({
        let diff = diff.clone();
        move |_cx, row| {
            if row == 0 {
                diff.colors(colors);
            }
        }
    });
    // The shorter diff scrolls the view back while the diff changes; the handler's colors win.
    diff.set_diff("@@ -1,1 +1,1 @@\n-a\n+b\n");
    assert_eq!(left.scroll_position(), 0);
    assert_eq!(rows(&app), [" 1 - a", " 1 + b", ""]);
    assert_eq!(app.render().cell(3, 1).unwrap().fg, Color::RED);
}

#[test]
fn tables_ignore_out_of_range_selections_and_take_body_colors() {
    use opentui::widget::{Column, Table};
    let app = TestApp::new(10, 4);
    let table = Table::new(&app).set_columns([Column::new("Name")]).set_rows([["a"], ["b"], ["c"]]).grow(1.0);
    app.root().add(&table);
    table.select(Some(1)).select(Some(3));
    assert_eq!(table.selected(), Some(1));
    table.select(None);
    assert_eq!(table.selected(), None);
    table.fg(Color::GREEN).striped(true).stripe_color(Color::BLUE);
    let capture = app.render();
    assert_eq!(capture.cell(0, 1).unwrap().fg, Color::GREEN);
    assert_eq!(capture.cell(5, 2).unwrap().bg, Color::BLUE);
    assert_ne!(capture.cell(5, 1).unwrap().bg, Color::BLUE);
}
