//! Both bindings drive the same graph of user actions and observe every prefix on a fresh app.
//! They also drop, repeat or swap one event of two normal cycles and check the next cycle recovers.
use opentui::input::{Event, MouseButton::Left, MouseEventKind, MouseEventKind::*};
use opentui::native::CursorStyle;
use opentui::prelude::*;
use opentui::sys;
use opentui::testing::TestApp;
use opentui::widget::ScrollEdge;
use serde_json::Value;
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;
use std::time::Duration;

const CORPUS: &str = include_str!("../../../../core/src/tests/fixtures/interaction-machines.json");

/// Known failures stay exact: the same symptom (on the same paths) must recur. `OTUI_FSM_STRICT=1`, or a
/// record number, reports them again.
struct ExpectedFailures {
    known: BTreeSet<String>,
    seen: BTreeSet<String>,
}

impl ExpectedFailures {
    fn new(rows: &Value) -> Self {
        let strict = std::env::var("OTUI_FSM_STRICT").unwrap_or_default();
        let mut known = BTreeSet::new();
        for row in rows.as_array().unwrap() {
            let field = |i: usize| row[i].as_str();
            if field(0) != Some("rust") || strict == "1" || field(1) == Some(strict.as_str()) {
                continue;
            }
            let symptom = field(2).unwrap();
            match field(3) {
                Some(paths) => known.extend(paths.split(' ').map(|path| format!("{path} {symptom}"))),
                None => {
                    known.insert(symptom.to_owned());
                }
            }
        }
        Self { known, seen: BTreeSet::new() }
    }

    fn has(&mut self, key: &str) -> bool {
        if !self.known.contains(key) {
            return false;
        }
        self.seen.insert(key.to_owned());
        true
    }

    fn check(&self) {
        let unseen: Vec<_> = self.known.difference(&self.seen).collect();
        assert!(unseen.is_empty(), "expected failure disappeared: {unseen:?}");
    }
}

/// Removes chunks, largest first, while the same failure remains.
fn shrink<T: Clone>(mut path: Vec<T>, mut fails: impl FnMut(&[T]) -> bool) -> Vec<T> {
    for size in (1..=path.len()).rev() {
        for start in (0..=path.len().saturating_sub(size)).rev() {
            if start + size > path.len() {
                continue;
            }
            let mut candidate = path.clone();
            candidate.drain(start..start + size);
            if fails(&candidate) {
                path = candidate;
            }
        }
    }
    path
}

fn cursor(app: &TestApp) -> String {
    let mut c = sys::ot_scene_cursor_state {
        struct_size: size_of::<sys::ot_scene_cursor_state>() as u32,
        abi_version: sys::OT_CONTEXT_ABI_VERSION,
        ..Default::default()
    };
    // The session and exact-sized output both remain live for the call.
    assert_eq!(
        unsafe { sys::ot_scene_get_cursor_state(app.session().context().as_raw(), &app.session().handle(), &mut c) },
        0
    );
    if c.visible == 0 {
        return "hidden".into();
    }
    let style = match c.style {
        sys::OT_CURSOR_STYLE_BLOCK => "block",
        sys::OT_CURSOR_STYLE_LINE => "line",
        _ => "other",
    };
    format!("{style}:{}@{},{}", c.blinking != 0, c.x, c.y)
}

fn selection(app: &TestApp) -> impl Fn(&str) -> String + '_ {
    let text = Text::new(app, "abc").height(1);
    app.root().add(&text);
    move |op| {
        app.advance(Duration::from_millis(600));
        match op {
            "mount" => (),
            "press" => app.mouse(MouseEventKind::Down(Left), 0, 0),
            "extend" => app.mouse(MouseEventKind::Drag(Left), 1, 0),
            "release" => app.mouse(MouseEventKind::Up(Left), 1, 0),
            "drag" => app.drag((0, 0), (1, 0)),
            "line" => {
                for _ in 0..3 {
                    app.click(0, 0)
                }
            }
            "replace" => {
                text.set_text("abcd");
            }
            "disable" | "enable" => {
                text.selectable(op == "enable");
            }
            "clear" => app.clear_selection(),
            _ => unreachable!("{op}"),
        }
        app.present().unwrap();
        format!("{}/{}", text.selected_text(), app.selected_text().unwrap_or_default())
    }
}

fn editor<'a>(app: &'a TestApp, kind: &'a str) -> impl Fn(&str) -> String + 'a {
    let group = View::new(app).height(1);
    let a = Textarea::new(app).height(1);
    let b = Textarea::new(app).height(1);
    group.add(&a);
    app.root().add(&group).add(&b);
    if kind == "textarea" {
        a.focus();
        a.set_text("ab").set_cursor_offset(2);
    }
    move |op| {
        match op {
            "mount" => (),
            "a" | "focus" => a.focus(),
            "b" => b.focus(),
            "blur" => app.blur(),
            "hideGroup" | "showGroup" => {
                group.visible(op == "showGroup");
            }
            "disableA" | "enableA" => {
                a.focusable(op == "enableA");
            }
            "hide" | "show" => {
                a.show_cursor(op == "show");
            }
            "line" => {
                a.cursor_style(CursorStyle::Line, false);
            }
            "block" => {
                a.cursor_style(CursorStyle::Block, true);
            }
            "left" | "right" => app.press(op),
            "shiftLeft" => app.press("shift+left"),
            "insert" => app.type_text("x"),
            "newline" => app.press("enter"),
            "pasteNewline" => app.paste("\n"),
            "pauseKeys" => {
                a.set_keymap(Default::default());
            }
            "resumeKeys" => {
                a.set_keymap(Textarea::default_keymap());
            }
            "reset" => {
                a.set_text("ab").set_cursor_offset(2);
            }
            _ => unreachable!("{op}"),
        }
        app.present().unwrap();
        match kind {
            "textarea" => format!("{}@{}/{}", a.text(), a.cursor_offset(), a.selected_text()),
            "focus" => {
                let owner = match app.focused().map(|w| w.id()) {
                    Some(id) if id == a.id() => "A",
                    Some(id) if id == b.id() => "B",
                    None => "-",
                    _ => "other",
                };
                let flags = match (a.is_focused(), b.is_focused()) {
                    (true, true) => "AB",
                    (true, false) => "A",
                    (false, true) => "B",
                    _ => "-",
                };
                let before = (a.text(), b.text());
                app.type_text("x");
                let recipient = match (before.0 != a.text(), before.1 != b.text()) {
                    (true, true) => "AB",
                    (true, false) => "A",
                    (false, true) => "B",
                    _ => "-",
                };
                format!("{owner}/{flags}/{recipient}")
            }
            "cursor" => cursor(app),
            _ => unreachable!(),
        }
    }
}

fn scroll<'a>(app: &'a TestApp, kind: &str, horizontal: bool) -> impl Fn(&str) -> String + 'a {
    let edge = match (horizontal, kind == "scroll-top") {
        (true, true) => ScrollEdge::Left,
        (true, false) => ScrollEdge::Right,
        (false, true) => ScrollEdge::Top,
        (false, false) => ScrollEdge::Bottom,
    };
    let scroller = ScrollBox::new(app).size(2, 2).axes(horizontal, !horizontal).scrollbars(false);
    scroller.sticky(true).sticky_start(edge);
    let child =
        Text::new(app, if horizontal { "0123456" } else { "0\n1\n2\n3\n4\n5\n6" }).wrap(WrapMode::None).shrink(0.0);
    let extent = move |n| if horizontal { child.width(n) } else { child.height(n) };
    scroller.add(&extent(3));
    app.root().add(&scroller);
    move |op| {
        let to = |offset| if horizontal { scroller.scroll_to(offset, 0.) } else { scroller.scroll_to(0., offset) };
        match op {
            "mount" => (),
            "shrink" | "grow" | "growAgain" => {
                extent(if op == "shrink" {
                    3
                } else if op == "grow" {
                    6
                } else {
                    7
                });
            }
            "top" | "middle" | "end" => {
                to(if op == "top" {
                    0.
                } else if op == "middle" {
                    2.
                } else {
                    f64::INFINITY
                });
            }
            _ => unreachable!("{op}"),
        }
        let frame = app.render();
        let (x, y) = scroller.scroll_position();
        let offset = (if horizontal { x } else { y }).to_string();
        let cell = &frame.cell(0, 0).unwrap().symbol;
        if cell == &offset { offset } else { format!("offset={offset}, painted={cell}") }
    }
}

fn traces<'a>(corpus: &Value, m: &'a Value) -> Vec<Vec<&'a str>> {
    fn visit<'a>(m: &'a Value, state: &str, path: &mut Vec<&'a str>, depth: usize, out: &mut Vec<Vec<&'a str>>) {
        let edges = m["states"][state][1].as_object().unwrap();
        if path.len() == depth || edges.is_empty() {
            out.push(path.clone());
            return;
        }
        for (op, next) in edges {
            path.push(op);
            visit(m, next.as_str().unwrap(), path, depth, out);
            path.pop();
        }
    }
    let mut out = Vec::new();
    let initial = m["initial"].as_str().unwrap();
    visit(m, initial, &mut Vec::new(), corpus["depth"].as_u64().unwrap() as usize, &mut out);
    for seed in 0..corpus["seeds"].as_u64().unwrap() as u32 {
        let (mut state, mut n, mut path) = (initial, seed, Vec::new());
        for _ in 0..corpus["steps"].as_u64().unwrap() {
            let edges = m["states"][state][1].as_object().unwrap();
            if edges.is_empty() {
                break;
            }
            n = n.wrapping_mul(1664525).wrapping_add(1013904223);
            let mut keys: Vec<_> = edges.keys().collect();
            keys.sort_unstable();
            let op = keys[(n >> 16) as usize % keys.len()].as_str();
            path.push(op);
            state = edges[op].as_str().unwrap();
        }
        out.push(path);
    }
    out
}

fn check_axis(kind: &str, horizontal: bool) {
    let corpus: Value = serde_json::from_str(CORPUS).unwrap();
    let m = &corpus["machines"][kind];
    let mut known = ExpectedFailures::new(&m["xfail"]);
    let mut replay = |path: &[&str]| {
        let app = TestApp::with_options(8, 2, AppOptions { copy_on_select: false, ..Default::default() });
        let step: Box<dyn Fn(&str) -> String> = match kind {
            "selection" => Box::new(selection(&app)),
            "scroll-top" | "scroll-bottom" => Box::new(scroll(&app, kind, horizontal)),
            _ => Box::new(editor(&app, kind)),
        };
        let mut state = m["initial"].as_str().unwrap();
        for op in ["mount"].into_iter().chain(path.iter().copied()) {
            let next = if op == "mount" { state } else { m["states"][state][1][op].as_str()? };
            let expected = m["states"][next][0].as_str().unwrap();
            let actual = step(op);
            if actual != expected {
                if known.has(&format!("{state} {op} {actual}")) {
                    return None;
                }
                return Some(format!("{state} + {op}: expected {expected:?}, got {actual:?}"));
            }
            state = next;
        }
        None
    };
    for path in traces(&corpus, m) {
        let Some(failure) = replay(&path) else { continue };
        let path = shrink(path, |candidate| replay(candidate).as_ref() == Some(&failure));
        panic!("{kind} {path:?}: {failure}");
    }
    known.check();
}

fn check(kind: &str) {
    check_axis(kind, false);
    if kind.starts_with("scroll-") {
        check_axis(kind, true);
    }
}

#[test]
fn text_selection() {
    check("selection");
}
#[test]
fn focus() {
    check("focus");
}
#[test]
fn editor_cursor() {
    check("cursor");
}
#[test]
fn sticky_bottom() {
    check("scroll-bottom");
}
#[test]
fn sticky_top() {
    check("scroll-top");
}
#[test]
fn textarea() {
    check("textarea");
}

type Step<'a> = Box<dyn FnMut(char) -> String + 'a>;

/// Two complete normal cycles. Each trial drops, repeats or swaps one event, including across the cycle
/// boundary. It then probes the unaltered second cycle if it survived, or otherwise a full first cycle.
fn trials(cycles: &[String]) -> BTreeSet<(String, String)> {
    let mut out = BTreeSet::new();
    for a in cycles {
        for b in cycles {
            let normal = format!("{a}{b}");
            for i in 0..normal.len() {
                let event = &normal[i..=i];
                let mut edits = vec![(1, String::new()), (1, event.repeat(2))];
                if i + 1 < normal.len() {
                    edits.push((2, format!("{}{event}", &normal[i + 1..=i + 1])));
                }
                for (take, replacement) in edits {
                    let intact = i + take <= a.len();
                    let end = if intact { a.len() } else { normal.len() };
                    out.insert((
                        format!("{}{replacement}{}", &normal[..i], &normal[i + take..end]),
                        if intact { b } else { &cycles[0] }.clone(),
                    ));
                }
            }
        }
    }
    out
}

fn pointer(app: &TestApp) -> Step<'_> {
    let events = Rc::new(RefCell::new(String::new()));
    let drag_over = Rc::new(Cell::new(false));
    let a = View::new(app).width(5).height(1);
    let b = View::new(app).width(5).height(1);
    for (id, w) in [('a', &a), ('b', &b)] {
        app.root().add(w);
        let log = Rc::clone(&events);
        w.on_mouse(move |_, e| {
            if matches!(e.kind, Down(Left) | Drag(Left)) {
                log.borrow_mut().push(id)
            }
        });
    }
    let state = Rc::clone(&drag_over);
    b.on_drag_over(move |_, _, over| state.set(over));
    let log = Rc::clone(&events);
    let source = a.id();
    b.on_drop(move |_, w, _| log.borrow_mut().push(if w.id() == source { 'A' } else { 'B' }));
    Box::new(move |op| {
        events.borrow_mut().clear();
        let kind = match op {
            'u' => Up(Left),
            'd' => Drag(Left),
            'a' | 'b' => Down(Left),
            _ => unreachable!(),
        };
        app.mouse(kind, 0, u16::from(op != 'a'));
        // Keep drag-over separate from ordinary hover. Replacing the source must balance the old enter.
        if op == 'u' { format!("{}/{}", events.borrow(), drag_over.get()) } else { events.borrow().clone() }
    })
}

fn faults<'a>(app: &'a TestApp, kind: &str) -> Step<'a> {
    match kind {
        "pointer" => pointer(app),
        "selection" | "consumed" => {
            let text = Textarea::new(app).width(8).height(1).set_text("abcdef");
            if kind == "consumed" {
                text.on_mouse(|cx, e| {
                    if e.kind == Down(Left) {
                        cx.prevent_default()
                    }
                });
            }
            app.root().add(&text);
            text.focus();
            Box::new(move |op| {
                if matches!(op, 'a' | 'b') {
                    app.advance(Duration::from_millis(600))
                }
                let (kind, x) = match op {
                    'a' => (Down(Left), 0),
                    'b' => (Down(Left), 3),
                    'd' => (Drag(Left), 4),
                    'u' => (Up(Left), 4),
                    _ => unreachable!(),
                };
                app.mouse(kind, x, 0);
                format!("{}:{}/{}", app.is_selecting(), app.selected_text().unwrap_or_default(), text.selected_text())
            })
        }
        "edge" => {
            let s = ScrollBox::new(app).width(8).height(6).scrollbar_arrows(true);
            s.add(&Text::new(app, "line\n".repeat(99)).shrink(0.0));
            app.root().add(&s).add(&View::new(app).width(8).height(1));
            Box::new(move |op| {
                if matches!(op, 'a' | 'b') {
                    app.advance(Duration::from_millis(600));
                }
                let kind = match op {
                    'u' | 'v' => Up(Left),
                    'd' => Drag(Left),
                    _ => Down(Left),
                };
                app.mouse(
                    kind,
                    2,
                    match op {
                        'a' => 0,
                        'b' | 'v' => 6,
                        _ => 5,
                    },
                );
                let before = s.scroll_position().1;
                app.advance(Duration::from_millis(160));
                app.render();
                (s.scroll_position().1 > before).to_string()
            })
        }
        "release" => {
            let log = Rc::new(RefCell::new(String::new()));
            Box::new(move |op| {
                log.borrow_mut().clear();
                if op == 'f' {
                    app.event(Event::Wake)
                } else {
                    let tasks = Rc::clone(&log);
                    app.release_terminal(move |_| tasks.borrow_mut().push(op));
                }
                log.borrow().clone()
            })
        }
        _ => unreachable!("{kind}"),
    }
}

fn observe(kind: &str, prefix: &str, cycle: &str, next: &str) -> [Vec<String>; 2] {
    let app = TestApp::with_options(8, 7, AppOptions { copy_on_select: false, ..Default::default() });
    let mut step = faults(&app, kind);
    app.render();
    app.render();
    for op in prefix.chars() {
        step(op);
    }
    [cycle, next].map(|word| word.chars().map(&mut step).collect())
}

fn check_faults(kind: &str) {
    let corpus: Value = serde_json::from_str(CORPUS).unwrap();
    let fault = &corpus["faults"][kind];
    let cs: Vec<String> = serde_json::from_value(fault["cycles"].clone()).unwrap();
    let fresh: BTreeMap<_, _> = cs.iter().map(|c| (c.clone(), observe(kind, "", c, &cs[0]))).collect();
    // A broken hit map, inert timer or disabled input must not become its own fresh oracle.
    let (word, control): (&str, &[&str]) = match kind {
        "pointer" => ("adu", &["a", "a", "A/false"]),
        "selection" | "consumed" => ("bdu", &["true:/", "true:de/de", "false:de/de"]),
        "edge" => ("adu", &["false", "true", "false"]),
        "release" => ("bf", &["", "b"]),
        _ => unreachable!(),
    };
    assert_eq!(fresh[word][0], control, "healthy cycle did not exercise {kind}");
    let mut known = ExpectedFailures::new(&fault["xfail"]);
    let difference = |prefix: &str, cycle: &str| {
        let actual = observe(kind, prefix, cycle, &cs[0]);
        let mut result = Vec::new();
        for (n, expected) in [&fresh[cycle][0], &fresh[&cs[0]][0]].into_iter().enumerate() {
            if let Some(i) = expected.iter().zip(&actual[n]).position(|(a, b)| a != b) {
                let op = (if n == 0 { cycle } else { &cs[0] }).as_bytes()[i] as char;
                result.push(format!("{}:{op} {} -> {}", n + 1, expected[i], actual[n][i]));
            }
        }
        result
    };
    let cases = trials(&cs);
    let mut failures = BTreeMap::new();
    for (prefix, cycle) in &cases {
        for problem in difference(prefix, cycle) {
            if !known.has(&format!("{prefix}/{cycle} {problem}")) {
                failures.entry(problem).or_insert((prefix.clone(), cycle, 0)).2 += 1;
            }
        }
    }
    for (problem, (prefix, cycle, n)) in &failures {
        let path: String = shrink(prefix.chars().collect(), |candidate| {
            difference(&candidate.iter().collect::<String>(), cycle).contains(problem)
        })
        .into_iter()
        .collect();
        eprintln!("{kind} {n}/{} {path}|{cycle}: {problem}", cases.len());
    }
    assert!(failures.is_empty());
    known.check();
}

#[test]
fn pointer_recovery() {
    check_faults("pointer")
}
#[test]
fn selection_recovery() {
    check_faults("selection")
}
#[test]
fn consumed_selection_recovery() {
    check_faults("consumed")
}
#[test]
fn edge_recovery() {
    check_faults("edge")
}
#[test]
fn release_recovery() {
    check_faults("release")
}
