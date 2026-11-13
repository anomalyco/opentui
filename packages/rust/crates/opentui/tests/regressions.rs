//! Regression tests for bugs found in a review of the framework layer. Each test is named after the bug it guards
//! against; its comment gives the expected behavior and what happened before the fix.

use opentui::prelude::*;
use opentui::testing::TestApp;
use opentui::widget::{Code, Column, Diff, DiffView, ExtmarkOptions, Markdown, ScrollAction, SelectAction, Table};
use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

fn rows(app: &TestApp) -> Vec<String> {
    let capture = app.render();
    (0..capture.height).map(|y| capture.row(y).trim_end().to_owned()).collect()
}

fn table(app: &TestApp, count: usize) -> Table {
    Table::new(app).set_columns([Column::new("Name")]).set_rows((0..count).map(|index| [format!("row {index}")]))
}

// Expected: a change handler may update its own table, as Select, TabSelect, Slider, and Input allow.
// Actual: panics with "RefCell already borrowed"; `TableInner::select` holds a `state` borrow while emitting.
#[test]
fn table_change_handler_that_mutates_the_table_panics() {
    let app = TestApp::new(20, 5);
    let files = table(&app, 5).grow(1.0);
    files.on_change({
        let files = files.clone();
        move |_cx, _index| {
            files.push_row(["added"]);
        }
    });
    app.root().add(&files);
    files.focus();
    app.press("down");
    assert_eq!(files.row_count(), 6);
}

// Expected: clicking the first body row, which shows "row 3", selects row 3.
// Actual: clicks map rows with the stored offset (5), not the clamped offset paint uses (3), so the click lands on
// the selected row 5 and activates it instead.
#[test]
fn table_click_uses_the_unclamped_scroll_offset() {
    let app = TestApp::new(20, 4);
    let activated = Rc::new(RefCell::new(Vec::new()));
    let files = table(&app, 6).grow(1.0).select(Some(5)).on_select({
        let activated = activated.clone();
        move |_cx, index| activated.borrow_mut().push(index)
    });
    app.root().add(&files);
    assert_eq!(rows(&app)[1], "row 3");
    app.click(2, 1);
    assert_eq!(files.selected(), Some(3));
    assert!(activated.borrow().is_empty(), "activated {:?}", activated.borrow());
}

// Expected: Page Down stops at the last option even with wrap_selection, per the comment in `SelectInner::key`.
// Actual: a page of up to five rows counts as a "fast step" and wraps to the first option.
#[test]
fn select_page_down_wraps_around() {
    let app = TestApp::new(20, 4);
    let list = Select::new(&app)
        .options((0..10).map(|index| format!("option {index}")))
        .show_description(false)
        .wrap_selection(true)
        .height(3);
    app.root().add(&list);
    list.focus();
    app.render();
    list.select(8);
    app.press("pagedown");
    assert_eq!(list.selected(), 9);
}

// Expected: a click on the blank row below the last visible option does nothing.
// Actual: it selects option 2, which was not on screen.
#[test]
fn select_click_below_the_last_visible_option_selects_a_hidden_option() {
    let app = TestApp::new(20, 6);
    let list = Select::new(&app).options([("a", "1"), ("b", "2"), ("c", "3"), ("d", "4")]).height(5);
    app.root().add(&list);
    assert_eq!(rows(&app)[4], "");
    app.click(3, 4);
    assert_eq!(list.selected(), 0);
}

// Expected: a widget inside a hidden parent cannot take focus ("if it is focusable and visible"); Tab order and
// hiding already treat it as hidden.
// Actual: it takes focus and receives keys.
#[test]
fn focus_lands_on_a_widget_inside_a_hidden_parent() {
    let app = TestApp::new(20, 2);
    let input = Input::new(&app);
    app.root().add(&View::new(&app).visible(false).child(&input));
    input.focus();
    app.type_text("x");
    assert_eq!(input.value(), "");
    assert!(!input.is_focused());
}

// Expected: moving the focused widget into a hidden parent clears focus, as hiding its parent would.
// Actual: it keeps focus and keeps receiving keys.
#[test]
fn focused_widget_moved_into_a_hidden_parent_keeps_focus() {
    let app = TestApp::new(20, 2);
    let input = Input::new(&app);
    let hidden = View::new(&app).visible(false);
    app.root().add(&input).add(&hidden);
    input.focus();
    hidden.add(&input);
    app.type_text("x");
    assert_eq!(input.value(), "");
    assert!(!input.is_focused());
}

// Expected: making the focused widget unfocusable blurs it, as Core's `focusable` setter does.
// Actual: it stays focused and keeps typing.
#[test]
fn focusable_false_does_not_blur_the_focused_widget() {
    let app = TestApp::new(20, 2);
    let input = Input::new(&app);
    app.root().add(&input);
    input.focus();
    input.focusable(false);
    app.type_text("x");
    assert_eq!(input.value(), "");
    assert!(!input.is_focused());
}

// Expected: a very long delay schedules a timer that never fires.
// Actual: panics with "overflow when adding duration to instant".
#[test]
fn set_timeout_with_a_huge_delay_panics() {
    let app = TestApp::new(20, 1);
    app.set_timeout(Duration::MAX, |_cx| {});
    app.advance(Duration::from_secs(1));
}

// Expected: follow stops after the user scrolls up, so new text or a resize keeps the view where the user left it,
// and a view at the end stays there.
// Actual: `CodeInner::resized`, and later `Code::set_code` (record 647), jumped to the bottom whenever follow is on.
#[test]
fn followed_code_jumps_to_the_bottom_after_the_user_scrolled_up() {
    let changes: [fn(&TestApp, &Code); 4] = [
        |_, log| drop(log.append("\nmore")),
        |_, log| drop(log.set_code(log.code() + "\nmore")),
        |_, log| drop(log.set_code(["other"; 12].join("\n"))),
        |app, _| app.resize(14, 3),
    ];
    for (index, scrolled_up) in (0..changes.len()).flat_map(|index| [(index, false), (index, true)]) {
        let app = TestApp::new(12, 3);
        let log = Code::new(&app).follow(true).grow(1.0).set_code(["line"; 10].join("\n"));
        app.root().add(&log);
        app.render();
        if scrolled_up {
            log.scroll_to(3);
        }
        changes[index](&app, &log);
        app.render();
        let row = log.scroll_position();
        let end = log.perform(ScrollAction::Bottom).scroll_position();
        assert_eq!(row, if scrolled_up { 3 } else { end }, "change {index}, scrolled up: {scrolled_up}");
    }
}

// Expected: Home scrolls to the top and keeps the horizontal position, as End does and as Core's vertical
// scrollbar does.
// Actual: Home also resets the horizontal position to 0.
#[test]
fn scroll_box_home_resets_the_horizontal_position() {
    let app = TestApp::new(10, 4);
    let scroll = ScrollBox::new(&app).axes(true, true).scrollbars(false).grow(1.0);
    for line in 0..10 {
        scroll.add(&Text::new(&app, format!("line {line} with a long tail")).width(25));
    }
    app.root().add(&scroll);
    app.render();
    scroll.scroll_to(5.0, 3.0);
    scroll.focus();
    app.press("end");
    assert_eq!(scroll.scroll_position(), (5.0, 6.0));
    app.press("home");
    assert_eq!(scroll.scroll_position(), (5.0, 0.0));
}

// Expected: inserting a widget into its own descendant is rejected and leaves the tree as it was.
// Actual: the Rust side detaches the widget from its parent before the native insert fails, so the Rust tree no
// longer matches the native one: `outer` has no parent here but is still drawn under the root.
#[test]
fn rejected_insert_detaches_the_child_from_the_rust_tree() {
    let app = TestApp::new(20, 3);
    let outer = View::new(&app);
    let inner = View::new(&app);
    outer.add(&inner);
    app.root().add(&outer);
    app.render();
    inner.add(&outer);
    assert!(app.try_render().is_err());
    assert_eq!(outer.parent().map(|parent| parent.id()), Some(app.root().id()));
}

// Expected: one widget's blur handler cannot cancel another widget's focus notification.
// Actual: both notifications share one `Cx`, so stop_propagation in the blur handler skips B's focus handler.
#[test]
fn blur_handler_stop_propagation_suppresses_another_widgets_focus_event() {
    let app = TestApp::new(20, 2);
    let log = Rc::new(RefCell::new(Vec::new()));
    let a = Input::new(&app).on_focus(|cx, focused| {
        if !focused {
            cx.stop_propagation();
        }
    });
    let b = Input::new(&app).on_focus({
        let log = log.clone();
        move |_cx, focused| log.borrow_mut().push(focused)
    });
    app.root().add(&a).add(&b);
    a.focus();
    app.render();
    b.focus();
    app.render();
    assert_eq!(*log.borrow(), [true]);
}

// Expected: one widget's hover handler cannot cancel another widget's hover notification.
// Actual: all enter and leave notifications share one `Cx`, so stop_propagation in A's leave handler skips B's
// enter handler.
#[test]
fn hover_handler_stop_propagation_suppresses_another_widgets_hover_event() {
    let app = TestApp::new(20, 2);
    let log = Rc::new(RefCell::new(Vec::new()));
    let a = Text::new(&app, "aaaa").on_hover(|cx, _hovered| cx.stop_propagation());
    let b = Text::new(&app, "bbbb").on_hover({
        let log = log.clone();
        move |_cx, hovered| log.borrow_mut().push(hovered)
    });
    app.root().add(&View::new(&app).row().gap(1).child(&a).child(&b));
    app.render();
    app.hover(1, 0);
    app.hover(6, 0);
    assert_eq!(*log.borrow(), [true]);
}

// Expected: a widget that detaches itself on mouse press does not take focus.
// Actual: focus-on-click walks the path computed before the handlers ran and focuses the detached widget.
#[test]
fn click_focuses_a_widget_its_own_mouse_handler_detached() {
    let app = TestApp::new(20, 3);
    let chip = View::new(&app).focusable(true).size(6, 1).child(&Text::new(&app, "[x]"));
    chip.on_mouse({
        let chip = chip.clone();
        move |_cx, event| {
            if matches!(event.kind, MouseEventKind::Down(MouseButton::Left)) {
                chip.detach();
            }
        }
    });
    app.root().add(&chip);
    app.render();
    app.click(1, 0);
    assert!(chip.parent().is_none());
    assert_eq!(app.focused(), None);
}

// Expected: a task that ends without output (here, it panics) releases its completion handler.
// Actual: the handler, and everything it captures, stays in the app's task map until the app ends.
#[cfg(feature = "tokio")]
#[test]
fn panicking_task_keeps_its_completion_handler_alive() {
    let app = TestApp::new(20, 1);
    let sentinel = Rc::new(());
    let task = app.spawn(async { panic!("task failed") }, {
        let sentinel = sentinel.clone();
        move |_cx, ()| {
            let _ = &sentinel;
        }
    });
    assert!(app.wait_until(Duration::from_secs(5), || task.is_finished()));
    app.wait_until(Duration::from_millis(50), || false);
    assert_eq!(Rc::strong_count(&sentinel), 1);
}

fn numbered_lines(count: usize) -> String {
    (0..count).map(|n| format!("line {n}")).collect::<Vec<_>>().join("\n")
}

fn ten_options(app: &TestApp) -> Select {
    let list = Select::new(app).options((0..10).map(|n| n.to_string())).show_description(false).height(4);
    app.root().add(&list);
    app.render();
    list.select(5)
}

// Expected: `fast_scroll_step(n)` makes MoveDownFast move n options toward the end ("how far MoveUpFast and
// MoveDownFast move"); a step past the end stops at the last option, or wraps when wrapping is on.
// Actual: `SelectInner::run` casts the step with `fast_step as isize`, so `usize::MAX` becomes -1 and MoveDownFast
// moves one option up.
#[test]
fn select_fast_scroll_step_past_isize_max_moves_the_wrong_way() {
    let app = TestApp::new(20, 6);
    let list = ten_options(&app).fast_scroll_step(usize::MAX);
    list.perform(SelectAction::MoveDownFast);
    assert_eq!(list.selected(), 9);
}

// Expected: any step from `fast_scroll_step` clamps (or wraps) at the ends. The comment in `SelectInner::step`
// claims steps stay within ±isize::MAX / 2.
// Actual: a step of `isize::MAX` reaches `state.selected as isize + steps` unchecked and panics with "attempt to add
// with overflow" (it wraps silently in release builds).
#[test]
fn select_fast_scroll_step_of_isize_max_overflows() {
    let app = TestApp::new(20, 6);
    let list = ten_options(&app).fast_scroll_step(isize::MAX as usize);
    list.perform(SelectAction::MoveDownFast);
    assert_eq!(list.selected(), 9);
}

// Expected: replacing a scrolled Code view's text with shorter text keeps the view within the new text, so the text
// shows; `Diff::set_diff` relies on this for every new diff.
// Actual: `Code::set_code` re-renders but never clamps `scroll`; the viewport stays at row 50 of a 2-line text, the
// view is blank, and `scroll_position()` still says 50, until the next wheel step clamps it.
#[test]
fn code_set_code_with_shorter_text_leaves_the_view_scrolled_past_the_end() {
    let app = TestApp::new(20, 4);
    let code = Code::new(&app).grow(1.0);
    code.set_code(numbered_lines(100));
    app.root().add(&code);
    app.render();
    code.scroll_to(50);
    assert_eq!(rows(&app)[0], "line 50");
    code.set_code("a\nb");
    assert_eq!(rows(&app)[..2], ["a", "b"]);
    assert_eq!(code.scroll_position(), 0);
}

// Expected: like every other setter, `Code::wrap` schedules a frame ("Changes go to native code at once and schedule
// a frame").
// Actual: it only calls `view.set_wrap`, without `request_redraw`, so a running app keeps showing unwrapped text until
// something else changes.
#[test]
fn code_wrap_does_not_schedule_a_frame() {
    let app = TestApp::new(10, 4);
    let code = Code::new(&app).grow(1.0);
    code.set_code("a long line of code");
    app.root().add(&code);
    app.render();
    assert!(!app.needs_frame());
    code.wrap(WrapMode::Word);
    assert!(app.needs_frame());
}

// Expected: Bottom (End, G) on a Code view with padding shows the last line, as it does without padding; before
// milestone 3 the scroll limit used the text column's height.
// Actual: `CodeInner::height` now prefers `laid_out_height`, which `resized` takes from the outer element, padding
// included, so the scroll limit is short by the padding and the last lines can never be scrolled into view.
#[test]
fn code_with_padding_cannot_scroll_to_its_last_lines() {
    let app = TestApp::new(20, 6);
    let code = Code::new(&app).padding_y(1).grow(1.0);
    code.set_code(numbered_lines(10));
    app.root().add(&code);
    app.render();
    code.perform(ScrollAction::Bottom);
    assert_eq!(rows(&app)[1..5], ["line 6", "line 7", "line 8", "line 9"]);
}

// Expected: typing "X" between "a" and "b" leaves a mark on "a" in place ("text typed right after a mark stays
// outside it") and moves a mark on "b" right; offsets count as the cursor's do.
// Actual: the edit found by comparing texts landed early or late, so one mark covered the typed "X".
// `extmarks::boundaries` counted a tab (two columns by default) as one and measured each `char` of the family emoji
// (three emoji joined by ZWJ, two columns natively) alone, as six. The editor measured a control character put in
// through `buffer()` as one column or none, not as its notation (`^L` two cells, `<85>` four).
#[test]
fn extmark_tracking_measures_text_as_the_cursor_does() {
    for (lead, width) in [("\t", 2), ("👨\u{200d}👩\u{200d}👧", 2), ("\x0c", 2), ("\u{85}", 4)] {
        let app = TestApp::new(30, 3);
        let area = Textarea::new(&app).grow(1.0);
        app.root().add(&area);
        area.buffer().set_text(&format!("{lead}ab"), false).unwrap();
        let marks = [width, width + 1].map(|start| area.add_extmark(start..start + 1, ExtmarkOptions::default()));
        area.focus();
        app.press("end");
        assert_eq!(area.cursor_offset(), width + 2, "{lead:?}");
        app.press("left");
        app.type_text("X");
        assert_eq!(area.text(), format!("{lead}aXb"));
        let ranges = marks.map(|mark| area.extmark(mark).unwrap().range());
        assert_eq!(ranges, [width..width + 1, width + 2..width + 3], "{lead:?}");
    }
}

// Expected: as in Core, an edit ends any selection, so the view follows the cursor to the line the edit moved it to.
// Actual: a click left a zero-width selection that Enter, Backspace and the word deletes kept, and the view does not
// follow the cursor while a selection exists: the cursor stayed above or below the one visible row.
#[test]
fn edits_after_a_click_leave_the_cursor_outside_the_view() {
    use opentui::widget::EditorAction as A;
    let [down, drag, up] =
        [MouseEventKind::Down, MouseEventKind::Drag, MouseEventKind::Up].map(|kind| kind(MouseButton::Left));
    let gestures: [&[_]; 3] =
        [&[(down, 0), (up, 0)], &[(down, 0), (drag, 1), (drag, 0), (up, 0)], &[(down, 0), (drag, 1), (up, 1)]];
    // The text after a click, or a drag back to where it started, at the start of "cd"; then after a drag over "cd".
    let actions = [
        (A::Newline, "ab\n\ncd\nef", "ab\n\n\nef"),
        (A::Backspace, "abcd\nef", "ab\n\nef"),
        (A::Delete, "ab\nd\nef", "ab\n\nef"),
        (A::DeleteWordForward, "ab\nef", "ab\n\nef"),
        (A::DeleteWordBackward, "abcd\nef", "ab\n\nef"),
    ];
    let cases = gestures.iter().enumerate().flat_map(|(index, events)| {
        actions.map(|(action, unselected, selected)| ("ab\ncd\nef", *events, action, [unselected, selected][index / 2]))
    });
    // A line of only a combining mark has no cells; the click's empty selection must not delete it.
    for (text, events, action, expected) in cases.chain([("\u{301}", gestures[0], A::Newline, "\n\u{301}")]) {
        let app = TestApp::new(10, 1);
        let area = Textarea::new(&app).set_text(text).grow(1.0);
        app.root().add(&area);
        area.focus();
        app.render();
        app.press("up");
        app.render();
        for &(kind, x) in events {
            app.mouse(kind, x, 0);
        }
        area.perform(action);
        app.render();
        let at = format!("{text:?}, {events:?}, {action:?}");
        assert_eq!(area.text(), expected, "{at}");
        let (row, viewport) = (area.cursor().0, area.view().viewport().unwrap());
        assert!((viewport.y..viewport.y + viewport.height).contains(&row), "{at}: row {row}, {viewport:?}");
    }
}

// Expected: as in Core, a left press that ends a selection without starting one also resets the click count
// (`clearSelection` sets `lastClick = null`), so click on text, click elsewhere, click on the text again is three
// single clicks.
// Actual: `App::clear_selection` leaves `last_click` alone, so the third press counts as a double-click on the
// text and selects the word "hello".
#[test]
fn a_press_elsewhere_does_not_reset_the_double_click_count() {
    let app = TestApp::new(20, 3);
    let text = Text::new(&app, "hello world");
    let button = View::new(&app).height(1).width(6).child(&Text::new(&app, "button").selectable(false));
    app.root().add(&text).add(&button);
    app.render();
    app.click(1, 0);
    app.advance(Duration::from_millis(50));
    app.click(1, 1);
    app.advance(Duration::from_millis(50));
    app.click(1, 0);
    assert_eq!(app.selected_text(), None);
}

// Expected: `*a **b** c*` is italic text with a bold word, as CommonMark and Core's `marked` render it.
// Actual: `inline` takes the first `*` after the opener as the closer, rejects `a ` for ending in a space, and
// falls back to printing the asterisks literally.
#[test]
fn markdown_emphasis_around_strong_text_shows_literal_asterisks() {
    let app = TestApp::new(30, 3);
    let doc = Markdown::new(&app).set_markdown("*a **b** c*");
    app.root().add(&doc);
    assert_eq!(rows(&app)[0], "a b c");
}

// Expected: a diff with an absurd but parseable line number shows its lines (or an error), never panics; the
// parser accepts any u64.
// Actual: `unified` (and `split`) step the line counters with `new += 1`, which overflows after line
// 18446744073709551615 and panics in `set_diff`.
#[test]
fn diff_line_numbers_overflow_at_u64_max() {
    let app = TestApp::new(80, 4);
    let diff = Diff::new(&app).grow(1.0);
    app.root().add(&diff);
    diff.set_diff("@@ -0,0 +18446744073709551615 @@\n+x\n");
    assert!(rows(&app).iter().any(|row| row.ends_with('x')), "{:?}", rows(&app));
    diff.view(DiffView::Split);
    assert!(rows(&app).iter().any(|row| row.ends_with('x')), "{:?}", rows(&app));
}

// Expected: releasing the mouse button stops a held scrollbar arrow from repeating ("holding repeats").
// Actual: the repeat timer is only cancelled by a release that reaches the arrow. Hiding the scrollbar while the
// button is held (here the content shrinks to fit) clears the pointer capture, so the release goes elsewhere and the
// interval runs for the rest of the app, scrolling the box by itself once content grows again.
#[test]
fn a_held_scrollbar_arrow_keeps_repeating_after_release_once_hidden() {
    let app = TestApp::new(20, 10);
    let scroll = ScrollBox::new(&app).grow(1.0).scrollbar_arrows(true);
    let fill = |scroll: &ScrollBox| {
        for line in 0..100 {
            scroll.add(&Text::new(&app, format!("line {line}")));
        }
    };
    fill(&scroll);
    app.root().add(&scroll);
    app.render();
    app.render();
    app.mouse(MouseEventKind::Down(MouseButton::Left), 19, 9);
    assert_eq!(scroll.scroll_position().1, 5.0);
    scroll.clear();
    app.render();
    app.render();
    app.mouse(MouseEventKind::Up(MouseButton::Left), 19, 9);
    fill(&scroll);
    app.render();
    let released = scroll.scroll_position();
    for _ in 0..20 {
        app.advance(Duration::from_millis(100));
        app.render();
    }
    assert_eq!(scroll.scroll_position(), released);
}

// Expected: `toggle_debug_overlay` "shows the debug overlay in its last corner", as Core's `toggleDebugOverlay` keeps
// its corner.
// Actual: hiding stores `corner: None`, so the corner is forgotten and showing again uses the default, TopRight.
#[test]
fn toggling_the_debug_overlay_forgets_its_corner() {
    use opentui::app::Corner;
    let app = TestApp::new(20, 4);
    app.set_debug_overlay(Some(Corner::BottomLeft));
    app.toggle_debug_overlay();
    assert_eq!(app.debug_overlay(), None);
    app.toggle_debug_overlay();
    assert_eq!(app.debug_overlay(), Some(Corner::BottomLeft));
}

// Expected: an `App` that is dropped without `run` (for example after an early `?` while building the UI) stops
// receiving console messages; a message logged on this thread goes to the live app running on it, as `console::log`
// documents ("the app running on the calling thread, or else the most recently created one").
// Actual: only `teardown` unregisters an app from the global console sink. The dropped app's target stays in the
// static `SINK` with its proxy, and this thread's `LOCAL` id still names it, so the live app never gets the message
// (and each such app leaks a target of up to 2,000 entries for the life of the process).
#[test]
fn an_app_dropped_without_running_keeps_receiving_console_messages() {
    let app = TestApp::new(20, 4);
    let abandoned = App::new(AppOptions::default().with_theme(Theme::dark())).expect("an app without a terminal");
    drop(abandoned);
    opentui::console::info("for the live app");
    assert!(app.wait_until(Duration::from_millis(200), || app.console().entries().len() == 1));
}

// Expected: `on_drag_over` is "called with `false` when it leaves or the drag ends".
// Actual: when the dragged widget is destroyed mid-drag (a common pattern: remove the card while dragging it), the
// release finds `source.upgrade()` empty and returns before telling the widgets under the drag, so the target
// keeps its drag-over state forever.
#[test]
fn drag_over_targets_never_hear_the_end_when_the_source_is_destroyed() {
    let app = TestApp::new(30, 3);
    let log = Rc::new(RefCell::new(Vec::new()));
    let card = View::new(&app).width(8).height(1).child(&Text::new(&app, "card").selectable(false));
    let target = View::new(&app).width(10).height(3).border(BorderStyle::Single);
    app.root().add(&View::new(&app).row().child(&card).child(&target));
    target.on_drag_over({
        let log = Rc::clone(&log);
        move |_cx, _source, over| log.borrow_mut().push(over)
    });
    app.render();
    app.mouse(MouseEventKind::Down(MouseButton::Left), 1, 0);
    app.mouse(MouseEventKind::Drag(MouseButton::Left), 12, 1);
    assert_eq!(*log.borrow(), [true]);
    card.detach();
    drop(card);
    app.render();
    app.mouse(MouseEventKind::Up(MouseButton::Left), 12, 1);
    assert_eq!(*log.borrow(), [true, false]);
}

// Expected: "A detached widget is destroyed when its last handle drops" (README), so a Diff that is removed and
// dropped releases its code views, their text buffers, and their native nodes.
// Actual: `Diff::new` gives each code view an `on_scroll` handler holding a strong handle to the other view; the two
// views keep each other alive until the app ends, so every replaced Diff leaks while the app runs.
#[test]
fn a_dropped_diff_leaks_its_code_views() {
    let app = TestApp::new(30, 4);
    let marker = Rc::new(());
    {
        let diff = Diff::new(&app).grow(1.0);
        diff.set_diff("@@ -1 +1 @@\n-a\n+b\n");
        app.root().add(&diff);
        app.render();
        let (left, _right) = diff.code_views();
        let held = Rc::clone(&marker);
        left.on_scroll(move |_cx, _row| {
            let _ = &held;
        });
        diff.detach();
    }
    app.render();
    assert_eq!(Rc::strong_count(&marker), 1);
}

// Expected: as in Core, dragging a selection to the edge of a scroll box scrolls it, wherever the selection started:
// Core sends selection drags to the widget under the pointer, and they bubble to the scroll box ("Dragging a text
// selection near an edge scrolls toward it").
// Actual: drags go to the captured widget only, and `ScrollInner::mouse` starts auto-scrolling only when it is an
// ancestor of that widget, so a selection started on text above the box never scrolls it.
#[test]
fn dragging_a_selection_into_a_scroll_box_from_outside_does_not_auto_scroll() {
    let app = TestApp::new(20, 7);
    let scroll = ScrollBox::new(&app).grow(1.0);
    for line in 0..50 {
        scroll.add(&Text::new(&app, format!("line {line}")));
    }
    app.root().add(&Text::new(&app, "header")).add(&scroll);
    app.render();
    app.mouse(MouseEventKind::Down(MouseButton::Left), 0, 0);
    app.mouse(MouseEventKind::Drag(MouseButton::Left), 2, 4);
    app.mouse(MouseEventKind::Drag(MouseButton::Left), 3, 6);
    for _ in 0..30 {
        app.advance(Duration::from_millis(16));
        app.render();
    }
    assert!(scroll.scroll_position().1 > 0.0, "{:?}", scroll.scroll_position());
}

// Expected: as in Core, Ctrl+press extends a selection but starts none: with nothing selected it is a plain press
// for handlers.
// Actual: with no selection, Ctrl+press started one like a plain press.
#[test]
fn ctrl_press_without_a_selection_starts_one() {
    use opentui::input::{Event, MouseEvent};
    let app = TestApp::new(20, 3);
    app.root().add(&Text::new(&app, "hello world"));
    app.render();
    let at = |kind, x| Event::Mouse(MouseEvent { kind, x, y: 0, modifiers: Modifiers::CTRL });
    app.event(at(MouseEventKind::Down(MouseButton::Left), 0));
    app.event(at(MouseEventKind::Drag(MouseButton::Left), 4));
    app.event(at(MouseEventKind::Up(MouseButton::Left), 4));
    assert_eq!(app.selected_text(), None);
    // With a selection, Ctrl+press extends it.
    app.drag((0, 0), (2, 0));
    app.event(at(MouseEventKind::Down(MouseButton::Left), 4));
    app.event(at(MouseEventKind::Up(MouseButton::Left), 4));
    assert_eq!(app.selected_text().as_deref(), Some("hello"));
}

// Expected: as Core's `getSelection()?.isDragging`, press and release handlers can tell that a selection drag is
// under way, before it has selected text. OpenCode's dialog backdrop relies on this.
// Actual: only `selected_text()` was public, which is `None` until a drag selects something.
#[test]
fn press_and_release_handlers_see_a_selection_drag() {
    use std::cell::RefCell;
    use std::rc::Rc;
    let app = TestApp::new(20, 3);
    let column = View::new(&app).column();
    let text = Text::new(&app, "hello world");
    let blank = View::new(&app).height(1);
    column.add(&text).add(&blank);
    app.root().add(&column);
    app.render();
    let seen = Rc::new(RefCell::new(Vec::new()));
    let handle = app.app().clone();
    let record = Rc::clone(&seen);
    column.on_mouse(move |_cx, event| {
        if let MouseEventKind::Down(MouseButton::Left) | MouseEventKind::Up(MouseButton::Left) = event.kind {
            record.borrow_mut().push((handle.is_selecting(), handle.selected_text()));
        }
    });
    assert!(!app.is_selecting());
    // A press on text starts a drag that has selected nothing yet; the release still sees it, and then it ends.
    app.mouse(MouseEventKind::Down(MouseButton::Left), 1, 0);
    app.mouse(MouseEventKind::Drag(MouseButton::Left), 4, 0);
    app.mouse(MouseEventKind::Up(MouseButton::Left), 4, 0);
    assert!(!app.is_selecting());
    // A press during a drag means the drag's release was lost: the press starts a new selection. Then, after another
    // lost release, a press on no text is no drag, also when its handler keeps the selection.
    blank.on_mouse(|cx, _event| cx.prevent_default());
    for (kind, x, y) in [(0, 3, 0), (1, 4, 0), (0, 6, 0), (1, 8, 0), (0, 1, 1), (1, 2, 1), (2, 2, 1)] {
        let kinds = [MouseEventKind::Down, MouseEventKind::Drag, MouseEventKind::Up];
        app.mouse(kinds[kind](MouseButton::Left), x, y);
    }
    let (ello, wor) = (Some("ello".to_owned()), Some("wor".to_owned()));
    let selections = [(true, None), (true, ello), (true, None), (true, None), (false, wor.clone()), (false, wor)];
    assert_eq!(*seen.borrow(), selections);
}

// The tests below guard against bugs found in a review of the public API.

// Expected: `row()` and `gap()` on a scroll box arrange its children, the way they do on a view.
// Actual: they acted on the outer box, which holds the viewport and the scrollbar, so children stayed stacked.
#[test]
fn scroll_box_row_and_gap_arrange_the_scrollbar_instead_of_the_children() {
    let app = TestApp::new(20, 3);
    let scroll = ScrollBox::new(&app).row().gap(1).grow(1.0);
    scroll.add(&Text::new(&app, "a")).add(&Text::new(&app, "b"));
    app.root().add(&scroll);
    assert_eq!(rows(&app)[0], "a b");
}

// Expected: scrolling to the bottom right after adding content reaches the new bottom once it is laid out.
// Actual: the scroll was clamped to the previous frame's content, so a box that is not sticky stayed where it was.
#[test]
fn scroll_to_bottom_before_a_frame_stops_at_the_old_content() {
    let app = TestApp::new(20, 3);
    let scroll = ScrollBox::new(&app).grow(1.0);
    app.root().add(&scroll);
    app.render();
    for line in 0..10 {
        scroll.add(&Text::new(&app, format!("line {line}")));
    }
    scroll.scroll_to_bottom();
    assert!(rows(&app)[2].starts_with("line 9"));
    assert_eq!(scroll.scroll_position(), (0.0, 7.0));
    // The request applies to one frame only: scrolling away afterwards sticks.
    scroll.scroll_to(0.0, 2.0);
    app.render();
    scroll.add(&Text::new(&app, "line 10"));
    assert!(rows(&app)[0].starts_with("line 2"));
}

// Expected: a NaN scroll position is ignored.
// Actual: it was stored and passed to native code, and every later relative scroll stayed NaN.
#[test]
fn scroll_box_accepts_a_nan_position() {
    let app = TestApp::new(20, 3);
    let scroll = ScrollBox::new(&app).grow(1.0);
    for line in 0..10 {
        scroll.add(&Text::new(&app, format!("line {line}")));
    }
    app.root().add(&scroll);
    app.render();
    scroll.scroll_to(f64::NAN, 2.0).scroll_by(0.0, f64::NAN).scroll_by(0.0, 1.0);
    assert_eq!(scroll.scroll_position(), (0.0, 1.0));
}

// Expected: a border keeps a color set before it.
// Actual: `border` replaced the color with the theme's when the view had no border yet.
#[test]
fn border_color_before_border_is_replaced_by_the_theme() {
    let app = TestApp::new(6, 3);
    app.root().add(&View::new(&app).size(6, 3).border_color(Color::RED).border(BorderStyle::Single));
    assert_eq!(app.render().cell(0, 0).map(|cell| cell.fg), Some(Color::RED));
}

// Expected: a height set on a tab row lasts until the rows it shows change.
// Actual: every setter, `select` included, reset the height to the rows it shows.
#[test]
fn tab_select_setters_reset_the_height() {
    let app = TestApp::new(20, 6);
    let tabs = TabSelect::new(&app).options(["a", "b"]).height(4);
    app.root().add(&tabs);
    app.render();
    tabs.select(1).colors(Color::RED, Color::BLUE);
    app.render();
    assert_eq!(tabs.rect().height, 4.0);
}

// Expected: a range with a NaN bound is ignored, and reversed bounds are swapped.
// Actual: NaN bounds panicked in `f64::clamp`, and a reversed range pinned the value to its minimum.
#[test]
fn slider_range_panics_on_nan_and_pins_reversed_bounds() {
    let app = TestApp::new(20, 1);
    let slider = Slider::new(&app).range(f64::NAN, f64::NAN).range(10.0, 0.0).set_value(4.0);
    assert_eq!(slider.value(), 4.0);
    app.root().add(&slider);
    slider.focus();
    app.press("end");
    assert_eq!(slider.value(), 10.0);
}

// Expected: `TestApp::advance` runs an interval once for every tick it passes.
// Actual: one advance ran each interval at most once, so tests had to step the clock in small increments.
#[test]
fn advance_collapses_interval_ticks() {
    let app = TestApp::new(10, 1);
    let ticks = Rc::new(RefCell::new(0));
    app.set_interval(Duration::from_millis(100), {
        let ticks = Rc::clone(&ticks);
        move |_cx| *ticks.borrow_mut() += 1
    });
    app.advance(Duration::from_millis(1050));
    assert_eq!(*ticks.borrow(), 10);
}

// Expected: a timeout may move a value out of its closure, since it runs once.
// Actual: `set_timeout` took `FnMut`, so this did not compile.
#[test]
fn set_timeout_cannot_consume_its_captures() {
    let app = TestApp::new(10, 1);
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let owned = String::from("done");
    app.set_timeout(Duration::from_millis(10), move |_cx| sender.send(owned).unwrap());
    app.advance(Duration::from_millis(10));
    assert_eq!(receiver.try_recv().as_deref(), Ok("done"));
}

// Expected: `insert` calls change handlers, as its docs ("an undoable edit") and `on_change` ("every edit") say.
// Actual: only typing, pasting, and actions did.
#[test]
fn insert_does_not_call_change_handlers() {
    let app = TestApp::new(20, 1);
    let changes = Rc::new(RefCell::new(Vec::new()));
    let input = Input::new(&app).on_change({
        let changes = Rc::clone(&changes);
        move |_cx, text| changes.borrow_mut().push(text.to_owned())
    });
    input.insert("@main.rs").set_value("replaced");
    assert_eq!(*changes.borrow(), ["@main.rs"]);
}

// Expected: `set_theme` changes the theme new widgets start with and the background behind them.
// Actual: the theme was fixed when the app was created, so `on_theme_mode` handlers could not follow the terminal.
#[test]
fn the_theme_cannot_change_after_the_app_starts() {
    let app = TestApp::with_options(4, 1, AppOptions::default().with_theme(Theme::dark()));
    app.set_theme(Theme::light());
    assert_eq!(app.theme(), Theme::light());
    assert_eq!(app.render().cell(0, 0).map(|cell| cell.bg), Some(Theme::light().background));
}

// Expected: an app's own error can end `App::run`, with its message.
// Actual: `Error` had no variant for it; apps squeezed errors into `io::Error` or a static string.
#[test]
fn app_errors_cannot_carry_their_own_errors() {
    let app = TestApp::new(4, 1);
    app.fail(Error::other("no config file"));
    let error = app.try_render().unwrap_err();
    assert_eq!(error.to_string(), "no config file");
}

// Expected: widget handles of any kind can key a set, as drag-and-drop sources do.
// Actual: `AnyWidget` had `PartialEq` but neither `Eq` nor `Hash`.
#[test]
fn any_widget_cannot_key_a_set() {
    let app = TestApp::new(4, 1);
    let text = Text::new(&app, "a");
    let widgets: std::collections::HashSet<AnyWidget> = [text.as_any(), text.as_any(), app.root().as_any()].into();
    assert_eq!(widgets.len(), 2);
}

/// A handler that records `name` in `log`.
fn record<A: ?Sized>(
    log: &Rc<RefCell<Vec<&'static str>>>,
    name: &'static str,
) -> impl FnMut(&mut Cx<'_>, &A) + 'static {
    let log = Rc::clone(log);
    move |_cx, _argument| log.borrow_mut().push(name)
}

// Expected: `remove_handler` removes an app handler, which then no longer runs.
// Actual: app handlers could not be removed; each ran until the app ended.
#[test]
fn app_handlers_cannot_be_removed() {
    let app = TestApp::new(4, 1);
    let log = Rc::new(RefCell::new(Vec::new()));
    let first = app.on_key(record(&log, "first"));
    app.on_key(record(&log, "second"));
    app.press("a");
    assert!(app.remove_handler(first));
    app.press("a");
    assert_eq!(*log.borrow(), ["first", "second", "second"]);
}

// Expected: a handler that an earlier handler of the same event removes does not run for that event.
// Actual: handlers could not be removed, and an event runs a copy of the handler list taken before any handler runs.
#[test]
fn a_handler_removed_during_its_event_still_runs() {
    let app = TestApp::new(4, 1);
    let log = Rc::new(RefCell::new(Vec::new()));
    let later = Rc::new(RefCell::new(None));
    app.on_key({
        let later = Rc::clone(&later);
        move |cx, _key| {
            if let Some(id) = later.borrow_mut().take() {
                cx.remove_handler(id);
            }
        }
    });
    *later.borrow_mut() = Some(app.on_key(record(&log, "removed")));
    app.press("a");
    app.press("a");
    assert!(log.borrow().is_empty());
}

// Expected: every `on_message` handler for a type gets each message, as other `on_*` handlers add up.
// Actual: a second `on_message` for the same type silently replaced the first.
#[test]
fn a_second_message_handler_replaces_the_first() {
    let app = TestApp::new(4, 1);
    let log = Rc::new(RefCell::new(Vec::new()));
    let first = app.on_message::<u8>(record(&log, "first"));
    app.on_message::<u8>(record(&log, "second"));
    app.proxy().send(1u8).unwrap();
    app.render();
    assert_eq!(*log.borrow(), ["first", "second"]);
    assert!(app.remove_handler(first));
    app.proxy().send(2u8).unwrap();
    app.render();
    assert_eq!(*log.borrow(), ["first", "second", "second"]);
}

// Expected: `remove_handler` returns false for a handler that is not registered: one already removed, or another
// app's.
// Actual: there was no way to remove a handler.
#[test]
fn remove_handler_reports_unknown_handlers() {
    let (app, other) = (TestApp::new(4, 1), TestApp::new(4, 1));
    let id = app.on_paste(|_cx, _text| {});
    assert!(!other.remove_handler(id));
    assert!(app.remove_handler(id));
    assert!(!app.remove_handler(id));
}
