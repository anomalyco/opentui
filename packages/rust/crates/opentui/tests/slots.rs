//! The slot tree: Core's resolver conformance table, and mounted slots drawn without a terminal.

use opentui::prelude::*;
use opentui::slot::{self, ClaimId, Kind, Mount, MountError, Placement};
use opentui::testing::TestApp;
use serde_json::{Value, json};
use std::cell::{Cell, RefCell};
use std::rc::Rc;

#[path = "support/allocations.rs"]
mod allocations;

#[test]
fn the_resolver_passes_cores_conformance_table() {
    let table: Value =
        serde_json::from_str(include_str!("../../../../core/src/plugins/slots.conformance.json")).unwrap();
    for row in table["contains"].as_array().unwrap() {
        let (ancestor, path) = (row[0].as_str().unwrap(), row[1].as_str().unwrap());
        assert_eq!(slot::contains(ancestor, path), row[2] == true, "{row}");
    }
    for row in table["rows"].as_array().unwrap() {
        let paths: Vec<&str> = table["paths"][row[1].as_str().unwrap()]
            .as_array()
            .unwrap()
            .iter()
            .map(|path| path.as_str().unwrap())
            .collect();
        let claims: Vec<Placement> = row[2]
            .as_array()
            .unwrap()
            .iter()
            .map(|claim| {
                let kind = match claim[0].as_str().unwrap() {
                    "before" => Kind::Before,
                    "prepend" => Kind::Prepend,
                    "append" => Kind::Append,
                    "after" => Kind::After,
                    _ => Kind::Replace,
                };
                Placement::new(kind, claim[1].as_str().unwrap())
            })
            .collect();
        let resolution = slot::resolve(&paths, &claims);
        let mut placed = serde_json::Map::new();
        for (path, slotted) in &resolution.placed {
            let mut entry = serde_json::Map::new();
            let lists = [
                ("before", &slotted.before),
                ("prepend", &slotted.prepend),
                ("append", &slotted.append),
                ("after", &slotted.after),
            ];
            for (kind, list) in lists.into_iter().filter(|(_, list)| !list.is_empty()) {
                entry.insert(kind.into(), json!(list));
            }
            if let Some(replace) = slotted.replace {
                entry.insert("replace".into(), json!(replace));
            }
            placed.insert(path.clone(), entry.into());
        }
        let actual = json!({ "placed": placed, "suppressed": resolution.suppressed, "degraded": resolution.degraded });
        assert_eq!(actual, row[3], "{}", row[0]);
    }
}

/// The mounts made (`+label`) and dropped (`-label`).
type Log = Rc<RefCell<Vec<String>>>;

/// A mounted claim: a widget, logged as it mounts and drops, what its drop runs, and what takes a new input.
struct Shown {
    root: AnyWidget,
    label: String,
    log: Log,
    then: Option<Box<dyn FnOnce()>>,
    input: Option<SetInput>,
}

type SetInput = Box<dyn Fn(&String) -> bool>;

impl Mount<String> for Shown {
    fn root(&self) -> AnyWidget {
        self.root.clone()
    }

    fn set_input(&self, input: &String) -> bool {
        self.input.as_ref().is_some_and(|set| set(input))
    }
}

impl Drop for Shown {
    fn drop(&mut self) {
        self.log.borrow_mut().push(format!("-{}", self.label));
        if let Some(then) = self.then.take() {
            then();
        }
    }
}

type Tree = slot::Tree<String, Shown>;
type WeakSlot = slot::WeakSlot<String, Shown>;

fn shown(log: &Log, label: &str, root: AnyWidget) -> Shown {
    log.borrow_mut().push(format!("+{label}"));
    Shown { root, label: label.to_owned(), log: log.clone(), then: None, input: None }
}

/// A claim's render: a text of `label`.
fn text(log: &Log, label: &'static str) -> impl Fn(&App, &String, WeakSlot) -> Shown + use<> {
    let log = log.clone();
    move |app, _, _| shown(&log, label, Text::new(app, label).as_any())
}

fn setup() -> (TestApp, Log, Rc<Tree>, View) {
    let app = TestApp::new(16, 8);
    let tree = Tree::new();
    let parent = View::new(&app).column();
    app.root().add(&parent);
    (app, Log::default(), tree, parent)
}

/// The rows drawn, without blank ones, after the settle the tree deferred, if any.
fn rows(app: &TestApp) -> Vec<String> {
    app.text().lines().map(str::trim_end).filter(|row| !row.is_empty()).map(str::to_owned).collect()
}

/// The log since the last call.
fn take(log: &Log) -> Vec<String> {
    std::mem::take(&mut *log.borrow_mut())
}

#[test]
fn a_slot_shows_its_claims_around_its_content_and_settles_in_place() {
    let (app, log, tree, parent) = setup();
    let (a, b) = (tree.owner("a"), tree.owner("b"));
    a.claim(Placement::append("footer"), text(&log, "a0")).unwrap();
    a.claim(Placement::before("footer"), text(&log, "a1")).unwrap();
    b.claim(Placement::prepend("footer"), text(&log, "b0")).unwrap();
    b.claim(Placement::after("footer"), text(&log, "b1")).unwrap();
    b.claim(Placement::append("footer"), text(&log, "b2")).unwrap();
    let footer = tree.mount(&app, "footer", String::new());
    let content = Text::new(&app, "content");
    footer.content().add(&content);
    parent.add(&footer);
    assert_eq!(rows(&app), ["a1", "b0", "content", "a0", "b2", "b1"]);
    assert_eq!(take(&log), ["+a1", "+b0", "+a0", "+b2", "+b1"]);

    // A replacement takes the content and the claims inside; the claims outside keep their mounts.
    let c = tree.owner("c");
    let replace = c.claim(Placement::replace("footer"), text(&log, "c0")).unwrap();
    assert_eq!(rows(&app), ["a1", "c0", "b1"]);
    assert_eq!(take(&log), ["-b0", "-a0", "-b2", "+c0"]);
    assert_eq!(tree.resolution().placed["footer"].replace, Some(replace));
    c.reset();
    assert_eq!(rows(&app), ["a1", "b0", "content", "a0", "b2", "b1"]);
    assert_eq!(take(&log), ["-c0", "+b0", "+a0", "+b2"]);
    assert!(footer.content().children()[0].is(&content), "the content keeps its widgets");

    // A hot reload keeps the owner's place; `order` moves owners, and only what moved mounts again.
    a.reset();
    a.claim(Placement::append("footer"), text(&log, "A0")).unwrap();
    assert_eq!(rows(&app), ["b0", "content", "A0", "b2", "b1"]);
    tree.order(&["b", "a", "b"]);
    assert_eq!(rows(&app), ["b0", "content", "b2", "A0", "b1"]);
    assert_eq!(take(&log), ["-a1", "-a0", "+A0"]);

    tree.owner("e").claim(Placement::prepend("footer"), text(&log, "e0")).unwrap();
    assert_eq!(rows(&app), ["b0", "e0", "content", "b2", "A0", "b1"]);
    let mut each = Vec::new();
    footer.each(|mount| each.push(mount.label.clone()));
    assert_eq!(each, ["b1", "b0", "b2", "A0", "e0"]);
    let before = allocations::count();
    footer.each(|_| ());
    assert_eq!(allocations::count() - before, 0, "a second walk allocated");
    // A change that leaves the slot as it shows syncs it without allocating, once the claims resolved.
    tree.owner("e").claim(Placement::append("elsewhere"), text(&log, "x")).unwrap();
    tree.resolution();
    let before = allocations::count();
    tree.settle();
    assert_eq!(allocations::count() - before, 0, "a settle that changes nothing here allocated");

    // A widget is a mount.
    let widgets = slot::Tree::<String>::new();
    widgets.owner("o").claim(Placement::append("w"), |app, _, _| Text::new(app, "w").as_any()).unwrap();
    parent.add(&widgets.mount(&app, "w", String::new()));
    assert_eq!(rows(&app).last().map(String::as_str), Some("w"));
}

#[test]
fn a_callback_may_change_the_tree_it_is_called_from() {
    // Each change runs inside `each` on `footer`, whose new claim `b` is not shown yet.
    type Change = fn(&TestApp, &Rc<Tree>, &slot::Slot<String, Shown>);
    let cases: [(&str, Change, &[&str]); 2] = [
        ("each mounts a slot", |app, tree, _| drop(tree.mount(app, "other", String::new())), &["a", "b"]),
        ("each sets the input", |_, _, footer| footer.set_input("new".into()), &["a", "b"]),
    ];
    for (name, change, expected) in cases {
        let (app, log, tree, parent) = setup();
        let owner = tree.owner("o");
        owner.claim(Placement::append("footer"), text(&log, "a")).unwrap();
        let footer = tree.mount(&app, "footer", String::new());
        parent.add(&footer);
        owner.claim(Placement::append("footer"), text(&log, "b")).unwrap();
        footer.each(|_| change(&app, &tree, &footer));
        assert_eq!(rows(&app), expected, "{name}");
    }

    // A render that sets its slot's input: every claim shows the new one.
    let (app, log, tree, parent) = setup();
    let owner = tree.owner("o");
    for label in ["a", "b"] {
        let log = log.clone();
        owner
            .claim(Placement::append("footer"), move |app: &App, input: &String, slot: WeakSlot| {
                if label == "a" && input.is_empty() {
                    slot.upgrade().unwrap().set_input("2".into());
                }
                shown(&log, label, Text::new(app, format!("{label}{input}")).as_any())
            })
            .unwrap();
    }
    parent.add(&tree.mount(&app, "footer", String::new()));
    assert_eq!(rows(&app), ["a2", "b2"]);

    // A mount whose drop removes a claim that is not shown yet: the claim never renders.
    let (app, log, tree, parent) = setup();
    let (weak, logged) = (Rc::downgrade(&tree), log.clone());
    tree.owner("a")
        .claim(Placement::append("footer"), move |app: &App, _: &String, _: WeakSlot| {
            let mut mount = shown(&logged, "a", Text::new(app, "a").as_any());
            let weak = weak.clone();
            mount.then = Some(Box::new(move || weak.upgrade().unwrap().owner("b").reset()));
            mount
        })
        .unwrap();
    parent.add(&tree.mount(&app, "footer", String::new()));
    take(&log);
    tree.owner("a").reset();
    tree.owner("b").claim(Placement::append("footer"), text(&log, "b")).unwrap();
    assert_eq!((rows(&app), take(&log)), (vec![], strings(&["-a"])));

    // A mount that, as it gets a new input, drops its own claim or sets another input, and asks to render again: the
    // claim renders once the slot syncs again, if it still shows.
    for (reset, expected) in [(true, &["-a"][..]), (false, &["+a", "-a"])] {
        let (app, log, tree, parent) = setup();
        let (weak, logged) = (Rc::downgrade(&tree), log.clone());
        tree.owner("a")
            .claim(Placement::append("footer"), move |app: &App, _: &String, slot: WeakSlot| {
                let mut mount = shown(&logged, "a", Text::new(app, "a").as_any());
                let weak = weak.clone();
                mount.input = Some(Box::new(move |_| match reset {
                    true => (weak.upgrade().unwrap().owner("a").reset(), false).1,
                    false => (slot.upgrade().unwrap().set_input("again".into()), false).1,
                }));
                mount
            })
            .unwrap();
        let footer = tree.mount(&app, "footer", String::new());
        parent.add(&footer);
        take(&log);
        footer.set_input("new".into());
        assert_eq!(take(&log), expected, "reset: {reset}");
    }
}

#[test]
fn a_change_outside_a_slot_shows_at_the_next_frame() {
    let (app, log, tree, parent) = setup();
    let side = tree.mount(&app, "side", String::new());
    let a = RefCell::new(Some(side.mount("side.a", String::new()).unwrap()));
    side.content().add(a.borrow().as_ref().unwrap());
    parent.add(&side);
    let (o, p) = (tree.owner("o"), tree.owner("p"));
    let claim = |owner: &slot::Owner<String, Shown>, placement, label| {
        owner.claim(placement, text(&log, label)).unwrap();
    };
    // Each change, whether it mounted claims at once, and the rows the next frame draws.
    type Case<'a> = (&'a str, &'a dyn Fn(), bool, &'a [&'a str]);
    let cases: [Case; 6] = [
        ("a claim", &|| claim(&o, Placement::append("side.a"), "a"), false, &["a"]),
        (
            "two claims",
            &|| (claim(&o, Placement::append("side.a"), "b"), claim(&p, Placement::before("side"), "p")).0,
            false,
            &["p", "a", "b"],
        ),
        ("an order", &|| tree.order(&["p", "o"]), false, &["p", "a", "b"]),
        ("a new input", &|| a.borrow().as_ref().unwrap().set_input("x".into()), true, &["p", "a", "b"]),
        ("the last slot of a path drops", &|| drop((side.content().clear(), a.take())), false, &["p", "a", "b"]),
        ("an owner removed", &|| tree.owner("p").remove(), false, &["a", "b"]),
    ];
    for (name, change, at_once, expected) in cases {
        change();
        assert_eq!(take(&log).iter().any(|entry| entry.starts_with('+')), at_once, "{name}");
        assert_eq!(rows(&app), expected, "{name}");
        take(&log);
    }
    assert!(!side.is_empty(), "the claims degrade onto `side`");

    // A tree that outlives its app while a settle is deferred defers the next one to the app it mounts on next.
    let (first, tree) = (TestApp::new(16, 8), Tree::new());
    drop(tree.mount(&first, "footer", String::new()));
    tree.owner("o").claim(Placement::append("footer"), text(&log, "a")).unwrap();
    drop(first);
    let second = TestApp::new(16, 8);
    second.root().add(&tree.mount(&second, "footer", String::new()));
    tree.owner("o").claim(Placement::append("footer"), text(&log, "b")).unwrap();
    assert_eq!(rows(&second), ["a", "b"]);
    take(&log);

    // Two claims that set each other's slot input stop at the pass bound, keep no replaced mount, and the next change
    // shows.
    let (app, log, tree, parent) = setup();
    let (owner, next) = (tree.owner("o"), Rc::new(Cell::new(0)));
    let slots: Rc<RefCell<Vec<WeakSlot>>> = Rc::default();
    for (label, at, other) in [("x", "p", 1), ("y", "q", 0)] {
        let (slots, next, log) = (slots.clone(), next.clone(), log.clone());
        owner
            .claim(Placement::append(at), move |app: &App, _: &String, _: WeakSlot| {
                next.set(next.get() + 1);
                let other = slots.borrow().get(other).and_then(WeakSlot::upgrade);
                other.inspect(|other| other.set_input(next.get().to_string()));
                shown(&log, label, Text::new(app, label).as_any())
            })
            .unwrap();
    }
    let (p, q) = (tree.mount(&app, "p", String::new()), tree.mount(&app, "q", String::new()));
    parent.add(&p).add(&q);
    slots.borrow_mut().extend([p.downgrade(), q.downgrade()]);
    take(&log);
    p.set_input("go".into());
    let made = take(&log);
    let count = |sign: char| made.iter().filter(|entry| entry.starts_with(sign)).count();
    assert_eq!((count('+') > 2, count('-')), (true, count('+')), "each replaced mount ends: {made:?}");
    owner.reset();
    assert_eq!((rows(&app), take(&log)), (vec![], strings(&["-x", "-y"])));

    // A render or a batch that panics, which the app catches: the tree goes on settling.
    for batched in [false, true] {
        let (app, log, tree, parent) = setup();
        parent.add(&tree.mount(&app, "footer", String::new()));
        let owner = tree.owner("o");
        let panics = std::panic::AssertUnwindSafe(|| match batched {
            true => tree.batch(|| panic!("batch")),
            false => {
                owner.claim(Placement::append("footer"), |_, _, _| panic!("render")).unwrap();
                tree.settle();
            }
        });
        assert!(std::panic::catch_unwind(panics).is_err());
        owner.reset();
        owner.claim(Placement::append("footer"), text(&log, "ok")).unwrap();
        assert_eq!(rows(&app), ["ok"], "batched: {batched}");
    }
}

#[test]
fn owners_keep_their_order_and_claims_their_mounts() {
    let (app, log, tree, parent) = setup();
    // An order names owners before they open: each opens before the first open owner listed after it, and again
    // once it was removed; no other owner moves.
    tree.order(&["b", "a"]);
    let a = tree.owner("a");
    let x = a.claim(Placement::append("footer"), text(&log, "x")).unwrap();
    a.claim(Placement::append("footer"), text(&log, "y")).unwrap();
    let footer = tree.mount(&app, "footer", String::new());
    parent.add(&footer);
    tree.owner("c").claim(Placement::append("footer"), text(&log, "c")).unwrap();
    let b = tree.owner("b");
    assert_eq!(rows(&app), ["x", "y", "c"], "an empty owner opened");
    b.claim(Placement::append("footer"), text(&log, "b")).unwrap();
    assert_eq!(rows(&app), ["b", "x", "y", "c"]);
    take(&log);
    tree.owner("b").remove();
    tree.owner("b").claim(Placement::append("footer"), text(&log, "B")).unwrap();
    // A removed owner's handles do nothing, also once it opens again.
    b.claim(Placement::append("footer"), text(&log, "stale")).unwrap();
    b.reset();
    assert_eq!((rows(&app), take(&log)), (strings(&["B", "x", "y", "c"]), strings(&["-b", "+B"])));
    let before = allocations::count();
    tree.order(&["b", "a", "b"]);
    drop(tree.owner("a"));
    assert_eq!(allocations::count() - before, 0, "the same order and an open owner allocate nothing");
    // An order that adds an open owner in its place, or drops one, takes the ids the tree has.
    tree.order(&["b", "a", "c"]);
    tree.order(&["b", "a"]);
    assert_eq!(allocations::count() - before, 0, "an order of open owners in place allocated");

    // `unclaim` drops one claim; the others keep their mounts.
    assert!(a.unclaim(x) && !a.unclaim(x));
    assert_eq!((rows(&app), take(&log)), (strings(&["B", "y", "c"]), strings(&["-x"])));

    // A mount that takes a new input in place keeps it; the others render again, each new mount before its old one.
    let logged = log.clone();
    tree.owner("e")
        .claim(Placement::append("footer"), move |app: &App, input: &String, _: WeakSlot| {
            let text = Text::new(app, input.clone());
            let mut mount = shown(&logged, "e", text.as_any());
            mount.input = Some(Box::new(move |input| (text.set_text(input.clone()), true).1));
            mount
        })
        .unwrap();
    rows(&app);
    take(&log);
    footer.set_input("new".into());
    assert_eq!(rows(&app), ["B", "y", "c", "new"]);
    assert_eq!(take(&log), ["+B", "-B", "+y", "-y", "+c", "-c"]);

    // `clear` removes every owner; the order stays.
    tree.clear();
    a.claim(Placement::append("footer"), text(&log, "stale")).unwrap();
    assert!(rows(&app).is_empty());
    tree.owner("c").claim(Placement::append("footer"), text(&log, "C")).unwrap();
    tree.owner("a").claim(Placement::append("footer"), text(&log, "A")).unwrap();
    tree.owner("b").claim(Placement::append("footer"), text(&log, "B")).unwrap();
    assert_eq!(rows(&app), ["C", "B", "A"]);
}

fn strings(list: &[&str]) -> Vec<String> {
    list.iter().map(|item| (*item).to_owned()).collect()
}

#[test]
fn a_batch_mounts_a_parent_before_its_children_without_degrading() {
    for (batched, expected) in [(false, &["+s", "-s", "+s"][..]), (true, &["+s"])] {
        let (app, log, tree, parent) = setup();
        tree.owner("o").claim(Placement::append("footer.status"), text(&log, "s")).unwrap();
        let mount = || {
            let footer = tree.mount(&app, "footer", String::new());
            let status = footer.mount("footer.status", String::new()).unwrap();
            footer.content().add(&status);
            parent.add(&footer);
            footer
        };
        let _footer = if batched { tree.batch(mount) } else { mount() };
        assert_eq!(rows(&app), ["s"]);
        assert_eq!(take(&log), expected, "batched: {batched}");
    }
}

/// A render of `f`: a row with the slot `footer.status` in it unless its input is "hide".
fn nesting(log: &Log) -> impl Fn(&App, &String, WeakSlot) -> Shown + use<> {
    let log = log.clone();
    move |app, input, slot| {
        let row = View::new(app).row().child(&Text::new(app, "footer "));
        if input != "hide" {
            row.add(&slot.mount("footer.status", input.clone()).unwrap());
        }
        shown(&log, "f", row.as_any())
    }
}

#[test]
fn nested_slots_take_their_claims_from_the_slot_they_degrade_to() {
    let (app, log, tree, parent) = setup();
    let (f, s) = (tree.owner("f"), tree.owner("s"));
    f.claim(Placement::append("footer"), nesting(&log)).unwrap();
    let status: ClaimId = s.claim(Placement::append("footer.status"), text(&log, "status")).unwrap();
    let footer = tree.mount(&app, "footer", String::new());
    footer.content().add(&Text::new(&app, "content"));
    parent.add(&footer);
    assert_eq!(rows(&app), ["content", "footer status"]);
    assert_eq!(take(&log), ["+f", "+status"], "never shown on `footer` on the way");

    footer.set_input("hide".into());
    assert_eq!(rows(&app), ["content", "footer", "status"]);
    assert_eq!(tree.resolution().degraded, [(status, "footer".to_owned())]);
    footer.set_input("show".into());
    assert_eq!(rows(&app), ["content", "footer status"]);
    // A new input renders `f` again: its new mount begins before the old one ends, so `footer.status` stays mounted.
    take(&log);
    footer.set_input("again".into());
    assert_eq!(take(&log), ["+f", "-f", "-status", "+status"]);
    footer.set_input("again".into());
    assert_eq!(take(&log), Vec::<String>::new(), "the same input renders nothing");

    // A slot mounts inside another only where its path extends the other's.
    let nested = |path: &str| footer.mount(path, String::new()).map(|_| ());
    let refused = |path: &str, within: &str| Err(MountError::NotContained { path: path.into(), within: within.into() });
    assert_eq!(nested("footer.status"), Ok(()));
    assert_eq!(nested("footerx.status"), refused("footerx.status", "footer"));
    assert_eq!(nested("footer"), refused("footer", "footer"));
    // A path with an empty name is no path, whether or not it extends the slot's: a claim or a nested mount on it
    // fails, as Core throws, and changes nothing. The host's own `Tree::mount` panics.
    for bad in ["footer.", "footer..x", "footerx..y", ""] {
        let invalid = Err(MountError::InvalidPath { path: bad.into() });
        assert_eq!(nested(bad), invalid, "{bad:?}");
        assert_eq!(s.claim(Placement::append(bad), text(&log, "bad")).map(|_| ()), invalid, "{bad:?}");
        let mount = std::panic::AssertUnwindSafe(|| drop(tree.mount(&app, bad, String::new())));
        assert!(std::panic::catch_unwind(mount).is_err(), "{bad:?}");
    }
    assert_eq!(rows(&app), ["content", "footer status"]);

    // A path stays mounted while any of its slots lives.
    let first = tree.mount(&app, "side.a", String::new());
    let second = tree.mount(&app, "side.a", String::new());
    let side = tree.mount(&app, "side", String::new());
    tree.owner("s").claim(Placement::append("side.a"), text(&log, "a")).unwrap();
    tree.settle();
    assert!(side.is_empty() && !first.is_empty() && !second.is_empty());
    drop(first);
    tree.settle();
    assert!(side.is_empty());
    drop(second);
    tree.settle();
    assert!(!side.is_empty(), "the claim degrades once the last slot of its path drops");

    // A mount keeps its slot weakly, and nests a slot in it after its render returns, while the slot is mounted.
    let kept: Rc<RefCell<Option<WeakSlot>>> = Rc::default();
    let (keep, render) = (kept.clone(), text(&log, "w"));
    tree.owner("w")
        .claim(Placement::append("late"), move |app, input, slot| {
            *keep.borrow_mut() = Some(slot.clone());
            render(app, input, slot)
        })
        .unwrap();
    let late = tree.mount(&app, "late", String::new());
    let weak = kept.take().unwrap();
    assert_eq!(weak.mount("late.x", String::new()).map(|_| ()), Ok(()));
    drop(late);
    assert!(weak.upgrade().is_none(), "a weak slot keeps no slot mounted");
    let unmounted = MountError::Unmounted { path: "late.x".into(), within: "late".into() };
    assert_eq!(weak.mount("late.x", String::new()).map(|_| ()), Err(unmounted));
    let invalid = MountError::InvalidPath { path: "late..x".into() };
    assert_eq!(weak.mount("late..x", String::new()).map(|_| ()), Err(invalid));

    // A settle does not sync a nested slot that a dropped claim took down on the way.
    take(&log);
    f.reset();
    tree.owner("t").claim(Placement::append("footer.status"), text(&log, "t")).unwrap();
    tree.settle();
    assert_eq!(take(&log), ["-f", "-status", "+status", "+t"]);
}
