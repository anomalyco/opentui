//! Tests ported from `@opentui/keymap`: `src/tests/keymap.*.test.ts`, the universal and OpenTUI addon tests, and
//! the extras tests. Targets are `u32` ids; a focus path lists the focused id, then its ancestors.

use super::addons::{self, ManagedTextarea};
use super::extras::{
    BindingItem, BindingLookup, BindingValue, FormatOptions, format_command_bindings, format_key_sequence,
};
use super::*;
use crate::input::{KeyCode, KeyEvent, KeyEventKind, Modifiers};
use crate::widget::EditorAction;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::time::{Duration, Instant};

type Calls = Rc<RefCell<Vec<String>>>;

fn calls() -> Calls {
    Rc::default()
}

fn taken(calls: &Calls) -> Vec<String> {
    std::mem::take(&mut calls.borrow_mut())
}

fn record(calls: &Calls, name: &str) -> Command<u32> {
    let calls = calls.clone();
    let label = name.to_owned();
    Command::new(name, move |_| calls.borrow_mut().push(label.clone()))
}

fn event(key: &str) -> KeyEvent {
    KeyEvent::from_shortcut(key).unwrap_or_else(|| panic!("test key {key:?}"))
}

fn press(keymap: &Keymap<u32>, key: &str) -> KeyResult {
    keymap.handle_key(&event(key))
}

fn active_names(keymap: &Keymap<u32>) -> Vec<String> {
    let mut names: Vec<_> =
        keymap.active_keys(ActiveKeyOptions::default()).into_iter().map(|key| key.stroke.name).collect();
    names.sort();
    names
}

fn pending(keymap: &Keymap<u32>) -> Vec<String> {
    keymap.pending_sequence().into_iter().map(|part| part.display).collect()
}

fn diagnostics(keymap: &Keymap<u32>) -> Rc<RefCell<Vec<String>>> {
    let messages: Rc<RefCell<Vec<String>>> = Rc::default();
    let sink = messages.clone();
    keymap.on_diagnostic(move |diagnostic| sink.borrow_mut().push(diagnostic.message.clone())).forget();
    messages
}

fn leader(keymap: &Keymap<u32>) {
    keymap.register_token("leader", Stroke::new("x").ctrl()).forget();
}

// keymap.layers-and-dispatch.test.ts

#[test]
fn target_layers_follow_focus_within() {
    let keymap = Keymap::new();
    let calls = calls();
    keymap.register_layer(Layer::new().command(record(&calls, "parent-action"))).forget();
    keymap.register_layer(Layer::new().target(1).binding(Binding::new("x").cmd("parent-action"))).forget();
    keymap.set_focus(vec![2, 1, 0]);
    press(&keymap, "x");
    assert_eq!(taken(&calls), ["parent-action"]);
}

#[test]
fn focus_layers_ignore_focused_descendants() {
    let keymap = Keymap::new();
    let calls = calls();
    keymap.register_layer(Layer::new().command(record(&calls, "focus-only"))).forget();
    keymap
        .register_layer(
            Layer::new().target(1).target_mode(TargetMode::Focus).binding(Binding::new("x").cmd("focus-only")),
        )
        .forget();
    keymap.set_focus(vec![2, 1, 0]);
    press(&keymap, "x");
    assert!(taken(&calls).is_empty());
    keymap.set_focus(vec![1, 0]);
    press(&keymap, "x");
    assert_eq!(taken(&calls), ["focus-only"]);
}

#[test]
fn newer_layers_win_and_fallthrough_continues() {
    let keymap = Keymap::new();
    let calls = calls();
    keymap
        .register_layer(Layer::new().commands([
            record(&calls, "global"),
            record(&calls, "local"),
            record(&calls, "fallthrough-local"),
        ]))
        .forget();
    keymap
        .register_layer(Layer::new().bindings([Binding::new("x").cmd("global"), Binding::new("y").cmd("global")]))
        .forget();
    keymap
        .register_layer(
            Layer::new().target(1).bindings([
                Binding::new("x").cmd("local"),
                Binding::new("y").cmd("fallthrough-local").fallthrough(true),
            ]),
        )
        .forget();
    keymap.set_focus(vec![1]);
    press(&keymap, "x");
    press(&keymap, "y");
    assert_eq!(taken(&calls), ["local", "fallthrough-local", "global"]);
}

#[test]
fn priority_outranks_registration_order() {
    let keymap = Keymap::new();
    let calls = calls();
    keymap.register_layer(Layer::new().commands([record(&calls, "high"), record(&calls, "low")])).forget();
    keymap.register_layer(Layer::new().priority(10).binding(Binding::new("x").cmd("high"))).forget();
    keymap.register_layer(Layer::new().binding(Binding::new("x").cmd("low"))).forget();
    press(&keymap, "x");
    assert_eq!(taken(&calls), ["high"]);
}

#[test]
fn prevent_default_and_fallthrough_are_orthogonal() {
    let keymap = Keymap::new();
    let calls = calls();
    for (key, prevent_default, fallthrough) in
        [("a", true, false), ("b", false, false), ("c", true, true), ("d", false, true)]
    {
        keymap
            .register_layer(
                Layer::new()
                    .commands([record(&calls, &format!("primary-{key}")), record(&calls, &format!("followup-{key}"))]),
            )
            .forget();
        keymap
            .register_layer(
                Layer::new().bindings([
                    Binding::new(key)
                        .cmd(format!("primary-{key}"))
                        .prevent_default(prevent_default)
                        .fallthrough(fallthrough),
                    Binding::new(key).cmd(format!("followup-{key}")).prevent_default(prevent_default),
                ]),
            )
            .forget();
    }
    let consumed: Vec<bool> = ["a", "b", "c", "d"].iter().map(|key| press(&keymap, key).stop_propagation).collect();
    assert_eq!(taken(&calls), ["primary-a", "primary-b", "primary-c", "followup-c", "primary-d", "followup-d"]);
    assert_eq!(consumed, [true, false, true, false]);
}

#[test]
fn unmatched_keys_pass_through() {
    let keymap = Keymap::<u32>::new();
    let result = press(&keymap, "q");
    assert_eq!(
        result,
        KeyResult { handled: false, reason: KeyReason::NoMatch, prevent_default: false, stop_propagation: false }
    );
}

#[test]
fn duplicate_command_names_across_layers_dedupe_by_name() {
    let keymap = Keymap::new();
    let calls = calls();
    keymap.register_layer(Layer::new().command(record(&calls, "save").title("Old"))).forget();
    keymap.register_layer(Layer::new().command(record(&calls, "save").title("New"))).forget();
    let reachable = keymap.commands(&CommandQuery::default());
    assert_eq!(reachable.len(), 1);
    assert_eq!(reachable[0].title.as_deref(), Some("New"));
    assert_eq!(keymap.commands(&CommandQuery::visibility(Visibility::Active)).len(), 2);
    assert_eq!(keymap.commands(&CommandQuery::visibility(Visibility::Registered)).len(), 2);
    // Past 20 entries, where an unstable sort stops keeping equal names in their order.
    for index in 0..12 {
        let commands = [record(&calls, "save").title(index.to_string()), record(&calls, &format!("z{}", index % 3))];
        keymap.register_layer(Layer::new().commands(commands)).forget();
    }
    let reachable = keymap.commands(&CommandQuery::default());
    let names: Vec<_> = reachable.iter().map(|command| format!("{}:{:?}", command.name, command.title)).collect();
    assert_eq!(names, ["save:Some(\"11\")", "z2:None", "z1:None", "z0:None"]);
}

#[test]
fn duplicate_command_names_in_one_layer_are_errors() {
    let keymap = Keymap::new();
    let messages = diagnostics(&keymap);
    let calls = calls();
    keymap.register_layer(Layer::new().commands([record(&calls, "save"), record(&calls, "save")])).forget();
    assert_eq!(*messages.borrow(), ["Duplicate keymap command \"save\" in the same layer"]);
    assert_eq!(keymap.commands(&CommandQuery::default()).len(), 1);
}

// keymap.core-and-commands.test.ts

#[test]
fn bindings_resolve_when_their_command_registers_later() {
    let keymap = Keymap::new();
    let calls = calls();
    keymap.register_layer(Layer::new().binding(Binding::new("x").cmd("late"))).forget();
    assert!(!press(&keymap, "x").handled);
    assert!(active_names(&keymap).is_empty());
    keymap.register_layer(Layer::new().command(record(&calls, "late"))).forget();
    assert_eq!(active_names(&keymap), ["x"]);
    assert!(press(&keymap, "x").handled);
    assert_eq!(taken(&calls), ["late"]);
}

#[test]
fn inline_handlers_run_and_reject() {
    let keymap = Keymap::new();
    let calls = calls();
    let first = calls.clone();
    let second = calls.clone();
    keymap
        .register_layer(Layer::new().bindings([
            Binding::new("x").run(move |_| {
                first.borrow_mut().push("rejecting".into());
                false
            }),
            Binding::new("x").run(move |context: &CommandContext<u32>| {
                second.borrow_mut().push(format!("handled {}", context.event.is_some()));
            }),
        ]))
        .forget();
    assert_eq!(press(&keymap, "x").reason, KeyReason::BindingHandled);
    assert_eq!(taken(&calls), ["rejecting", "handled true"]);
}

#[test]
fn dispatch_and_run_command_report_why_a_command_did_not_run() {
    let keymap = Keymap::new();
    let calls = calls();
    let enabled = Rc::new(Cell::new(false));
    let gate = enabled.clone();
    keymap.register_layer(Layer::new().target(5).command(record(&calls, "targeted"))).forget();
    keymap
        .register_layer(Layer::new().command(record(&calls, "gated").enabled(Condition::when(move || gate.get()))))
        .forget();
    keymap.register_layer(Layer::new().command(Command::new("refuses", |_| false))).forget();
    assert_eq!(keymap.dispatch_command("missing"), RunResult::NotFound);
    assert_eq!(keymap.dispatch_command("  "), RunResult::InvalidArgs);
    assert_eq!(keymap.dispatch_command("targeted"), RunResult::Inactive);
    assert_eq!(keymap.dispatch_command("gated"), RunResult::Disabled);
    assert_eq!(keymap.dispatch_command("refuses"), RunResult::Rejected);
    assert!(taken(&calls).is_empty());
    assert_eq!(keymap.run_command("targeted"), RunResult::Ok);
    assert_eq!(keymap.run_command("gated"), RunResult::Ok);
    enabled.set(true);
    keymap.set_focus(vec![5]);
    assert_eq!(keymap.dispatch_command("targeted"), RunResult::Ok);
    assert_eq!(keymap.dispatch_command("gated"), RunResult::Ok);
    assert_eq!(taken(&calls), ["targeted", "gated", "targeted", "gated"]);
}

#[test]
fn rejecting_commands_fall_through_to_the_next_of_the_same_name() {
    let keymap = Keymap::new();
    let calls = calls();
    let global = calls.clone();
    let local = calls.clone();
    keymap
        .register_layer(Layer::new().command(Command::new("save", move |_| global.borrow_mut().push("global".into()))))
        .forget();
    keymap
        .register_layer(Layer::new().target(1).command(Command::new("save", move |_| {
            local.borrow_mut().push("local".into());
            false
        })))
        .forget();
    keymap.register_layer(Layer::new().binding(Binding::new("ctrl+s").cmd("save"))).forget();
    keymap.set_focus(vec![1]);
    assert!(press(&keymap, "ctrl+s").handled);
    assert_eq!(taken(&calls), ["local", "global"]);
    assert_eq!(keymap.dispatch_command("save"), RunResult::Ok);
    assert_eq!(taken(&calls), ["local", "global"]);
}

#[test]
fn command_contexts_carry_targets_input_and_focus() {
    let keymap = Keymap::new();
    let seen = Rc::new(RefCell::new(None));
    let sink = seen.clone();
    keymap
        .register_layer(Layer::new().target(1).command(Command::new(
            "inspect",
            move |context: &CommandContext<u32>| {
                *sink.borrow_mut() =
                    Some((context.target, context.focused, context.input.clone(), context.event.is_some()));
            },
        )))
        .forget();
    keymap.register_layer(Layer::new().binding(Binding::new("i").cmd("inspect"))).forget();
    keymap.set_focus(vec![2, 1]);
    press(&keymap, "i");
    assert_eq!(seen.take(), Some((Some(1), Some(2), "inspect".to_owned(), true)));
    keymap.dispatch_command("inspect");
    assert_eq!(seen.take(), Some((Some(1), Some(2), "inspect".to_owned(), false)));
}

#[test]
fn commands_can_change_data_for_later_fallthrough_bindings() {
    let keymap = Keymap::new();
    let calls = calls();
    keymap
        .register_layer(Layer::new().command(Command::new("enter-visual", |context: &CommandContext<u32>| {
            context.keymap.set_data("mode", "visual");
        })))
        .forget();
    keymap.register_layer(Layer::new().require("mode", "visual").command(record(&calls, "visual-only"))).forget();
    keymap
        .register_layer(
            Layer::new().bindings([
                Binding::new("v").cmd("enter-visual").fallthrough(true),
                Binding::new("v").cmd("visual-only"),
            ]),
        )
        .forget();
    press(&keymap, "v");
    assert_eq!(taken(&calls), ["visual-only"]);
    assert_eq!(keymap.data("mode").as_deref(), Some("visual"));
}

#[test]
fn commands_can_reenter_the_keymap() {
    let keymap = Keymap::new();
    let calls = calls();
    let nested = calls.clone();
    keymap
        .register_layer(Layer::new().command(record(&calls, "inner")).command(Command::new(
            "outer",
            move |context: &CommandContext<u32>| {
                nested.borrow_mut().push("outer".into());
                assert_eq!(context.keymap.dispatch_command("inner"), RunResult::Ok);
                let more = nested.clone();
                context
                    .keymap
                    .register_layer(
                        Layer::new().binding(Binding::new("z").run(move |_| more.borrow_mut().push("z".into()))),
                    )
                    .forget();
            },
        )))
        .forget();
    keymap.register_layer(Layer::new().binding(Binding::new("o").cmd("outer"))).forget();
    press(&keymap, "o");
    press(&keymap, "z");
    assert_eq!(taken(&calls), ["outer", "inner", "z"]);
}

#[derive(Clone, Copy, Debug)]
enum Ending {
    Dispose,
    Drop,
    Forget,
}

#[test]
fn a_disposer_undoes_its_registration_unless_forgotten() {
    for (ending, kept) in [(Ending::Dispose, false), (Ending::Drop, false), (Ending::Forget, true)] {
        let keymap = Keymap::new();
        let calls = calls();
        let states = Rc::new(Cell::new(0));
        keymap.register_layer(Layer::new().commands([record(&calls, "layer"), record(&calls, "token")])).forget();
        keymap.register_layer(Layer::new().binding(Binding::new("<leader>t").cmd("token"))).forget();
        let intercepted = calls.clone();
        let count = states.clone();
        let disposers = [
            keymap.register_layer(Layer::new().binding(Binding::new("r").cmd("layer"))),
            keymap.register_token("leader", "ctrl+x"),
            Disposer::all(vec![
                keymap.intercept_key(0, false, move |context| {
                    if context.stroke.name == "q" {
                        intercepted.borrow_mut().push("intercept".into());
                    }
                }),
                keymap.on_state(move || count.set(count.get() + 1)),
            ]),
        ];
        for disposer in disposers {
            match ending {
                Ending::Dispose => disposer.dispose(),
                Ending::Drop => drop(disposer),
                Ending::Forget => disposer.forget(),
            }
        }
        states.set(0);
        for key in ["r", "ctrl+x", "t", "q"] {
            press(&keymap, key);
        }
        let expected: &[&str] = if kept { &["layer", "token", "intercept"] } else { &[] };
        assert_eq!(taken(&calls), expected, "{ending:?}");
        assert_eq!(states.get() > 0, kept, "{ending:?}");
    }
}

#[test]
fn disposing_a_registration_drops_the_disposers_it_owns() {
    let keymap = Keymap::new();
    let calls = calls();
    keymap.register_layer(Layer::new().command(record(&calls, "inner"))).forget();
    keymap.register_layer(Layer::new().binding(Binding::new("<leader>t").cmd("inner"))).forget();
    let layer = RefCell::new(Some(keymap.register_layer(Layer::new().binding(Binding::new("i").cmd("inner")))));
    let token = RefCell::new(Some(keymap.register_token("leader", "ctrl+x")));
    let outer = keymap.register_layer(Layer::new().command(Command::new("outer", move |_| layer.borrow().is_some())));
    let listener = keymap.on_state(move || assert!(token.borrow().is_some()));
    assert!(press(&keymap, "i").handled);
    outer.dispose();
    assert!(!press(&keymap, "i").handled);
    assert!(press(&keymap, "ctrl+x").handled);
    keymap.clear_pending_sequence();
    drop(listener);
    assert!(!press(&keymap, "ctrl+x").handled);
    assert_eq!(taken(&calls), ["inner"]);
}

#[test]
fn a_command_can_drop_its_own_layer() {
    let keymap = Keymap::new();
    let calls = calls();
    let slot: Rc<RefCell<Option<Disposer>>> = Rc::default();
    let own = slot.clone();
    let ran = calls.clone();
    *slot.borrow_mut() = Some(keymap.register_layer(Layer::new().binding(Binding::new("c").run(move |_| {
        ran.borrow_mut().push("close".into());
        own.borrow_mut().take();
    }))));
    assert!(press(&keymap, "c").handled);
    assert!(!press(&keymap, "c").handled);
    assert_eq!(taken(&calls), ["close"]);
}

// keymap.sequences-and-state.test.ts

#[test]
fn multi_key_sequences_report_pending_and_active_keys() {
    let keymap = Keymap::new();
    let calls = calls();
    keymap.register_layer(Layer::new().command(record(&calls, "delete-line"))).forget();
    keymap.register_layer(Layer::new().binding(Binding::new("dd").cmd("delete-line"))).forget();
    assert_eq!(active_names(&keymap), ["d"]);
    assert_eq!(press(&keymap, "d").reason, KeyReason::SequencePending);
    assert_eq!(pending(&keymap), ["d"]);
    assert!(keymap.has_pending_sequence());
    let active = keymap.active_keys(ActiveKeyOptions::default());
    assert_eq!(active.len(), 1);
    assert_eq!(active[0].command.as_ref().and_then(BindingCommand::name), Some("delete-line"));
    assert_eq!(active[0].display, "d");
    press(&keymap, "d");
    assert_eq!(taken(&calls), ["delete-line"]);
    assert!(pending(&keymap).is_empty());
    assert!(!keymap.has_pending_sequence());
}

#[test]
fn an_invalid_continuation_clears_the_sequence_without_consuming() {
    let keymap = Keymap::new();
    let calls = calls();
    keymap.register_layer(Layer::new().command(record(&calls, "delete-line"))).forget();
    keymap.register_layer(Layer::new().binding(Binding::new("dd").cmd("delete-line"))).forget();
    press(&keymap, "d");
    let result = press(&keymap, "x");
    assert_eq!(result.reason, KeyReason::SequenceMiss);
    assert!(!result.stop_propagation);
    assert!(pending(&keymap).is_empty());
    assert_eq!(active_names(&keymap), ["d"]);
}

#[test]
fn branching_sequences_share_a_prefix() {
    let keymap = Keymap::new();
    let calls = calls();
    keymap
        .register_layer(Layer::new().commands([record(&calls, "gg"), record(&calls, "gd"), record(&calls, "gdd")]))
        .forget();
    keymap.register_layer(Layer::new().bindings([Binding::new("gg").cmd("gg"), Binding::new("gd").cmd("gd")])).forget();
    press(&keymap, "g");
    assert_eq!(active_names(&keymap), ["d", "g"]);
    press(&keymap, "d");
    press(&keymap, "g");
    press(&keymap, "g");
    assert_eq!(taken(&calls), ["gd", "gg"]);
}

#[test]
fn continuations_merge_across_prefix_layers() {
    let keymap = Keymap::new();
    let calls = calls();
    keymap
        .register_layer(Layer::new().commands([record(&calls, "local-delete"), record(&calls, "global-delete")]))
        .forget();
    keymap.register_layer(Layer::new().binding(Binding::new("da").cmd("global-delete"))).forget();
    keymap.register_layer(Layer::new().target(1).binding(Binding::new("dd").cmd("local-delete"))).forget();
    keymap.set_focus(vec![1]);
    press(&keymap, "d");
    assert_eq!(active_names(&keymap), ["a", "d"]);
    press(&keymap, "d");
    press(&keymap, "d");
    press(&keymap, "a");
    assert_eq!(taken(&calls), ["local-delete", "global-delete"]);
}

#[test]
fn leader_prefixes_merge_across_local_and_global_layers() {
    let keymap = Keymap::new();
    let calls = calls();
    leader(&keymap);
    keymap
        .register_layer(Layer::new().commands([record(&calls, "global-model"), record(&calls, "local-editor")]))
        .forget();
    keymap.register_layer(Layer::new().binding(Binding::new("<leader>m").cmd("global-model"))).forget();
    keymap.register_layer(Layer::new().target(1).binding(Binding::new("<leader>e").cmd("local-editor"))).forget();
    keymap.set_focus(vec![1]);
    press(&keymap, "ctrl+x");
    assert_eq!(active_names(&keymap), ["e", "m"]);
    assert_eq!(keymap.pending_sequence()[0].token.as_deref(), Some("leader"));
    press(&keymap, "m");
    press(&keymap, "ctrl+x");
    press(&keymap, "e");
    assert_eq!(taken(&calls), ["global-model", "local-editor"]);
}

#[test]
fn focus_changes_clear_a_pending_sequence() {
    let keymap = Keymap::new();
    let calls = calls();
    keymap.register_layer(Layer::new().command(record(&calls, "delete-line"))).forget();
    keymap.register_layer(Layer::new().binding(Binding::new("dd").cmd("delete-line"))).forget();
    keymap.set_focus(vec![1]);
    press(&keymap, "d");
    let revision = keymap.revision();
    keymap.set_focus(vec![1]);
    assert_eq!(keymap.revision(), revision);
    keymap.set_focus(vec![1, 0]);
    assert_eq!(pending(&keymap), ["d"]);
    keymap.set_focus(vec![2]);
    assert!(pending(&keymap).is_empty());
}

#[test]
fn layer_requirements_gate_keys_and_clear_sequences() {
    let keymap = Keymap::new();
    let calls = calls();
    keymap
        .register_layer(Layer::new().commands([record(&calls, "normal-delete"), record(&calls, "visual-delete")]))
        .forget();
    keymap
        .register_layer(Layer::new().require("vim.mode", "normal").binding(Binding::new("dd").cmd("normal-delete")))
        .forget();
    keymap
        .register_layer(Layer::new().require("vim.mode", "visual").binding(Binding::new("vv").cmd("visual-delete")))
        .forget();
    assert!(active_names(&keymap).is_empty());
    keymap.set_data("vim.mode", "normal");
    assert_eq!(active_names(&keymap), ["d"]);
    press(&keymap, "d");
    keymap.set_data("vim.mode", "visual");
    assert!(pending(&keymap).is_empty());
    assert_eq!(active_names(&keymap), ["v"]);
    keymap.clear_data("vim.mode");
    assert!(active_names(&keymap).is_empty());
}

#[test]
fn listeners_see_pending_changes_and_batched_state() {
    let keymap = Keymap::new();
    let calls = calls();
    let sequences: Rc<RefCell<Vec<Vec<String>>>> = Rc::default();
    let states = Rc::new(Cell::new(0));
    let sink = sequences.clone();
    let count = states.clone();
    keymap
        .on_pending_sequence(move |sequence| {
            sink.borrow_mut().push(sequence.iter().map(|part| part.display.clone()).collect());
        })
        .forget();
    keymap.on_state(move || count.set(count.get() + 1)).forget();
    keymap.register_layer(Layer::new().command(record(&calls, "dca")).binding(Binding::new("dca").cmd("dca"))).forget();
    assert_eq!(states.replace(0), 1);
    press(&keymap, "d");
    press(&keymap, "c");
    press(&keymap, "a");
    assert_eq!(*sequences.borrow(), vec![vec!["d"], vec!["d", "c"], vec![]]);
    assert_eq!(states.get(), 3);
    let revision = keymap.revision();
    press(&keymap, "q");
    assert_eq!(keymap.revision(), revision);
}

#[test]
fn same_layer_exact_and_prefix_bindings_are_errors() {
    let keymap = Keymap::new();
    let messages = diagnostics(&keymap);
    let calls = calls();
    keymap
        .register_layer(
            Layer::new()
                .commands([record(&calls, "g"), record(&calls, "gg")])
                .bindings([Binding::new("g").cmd("g"), Binding::new("gg").cmd("gg")]),
        )
        .forget();
    assert_eq!(
        *messages.borrow(),
        ["Keymap bindings cannot use the same sequence as both an exact match and a prefix in the same layer"]
    );
    press(&keymap, "g");
    assert_eq!(taken(&calls), ["g"]);
}

#[test]
fn across_layers_the_first_matching_layer_decides_exact_or_prefix() {
    let keymap = Keymap::new();
    let calls = calls();
    keymap.register_layer(Layer::new().commands([record(&calls, "g"), record(&calls, "gg")])).forget();
    let exact = keymap.register_layer(Layer::new().binding(Binding::new("g").cmd("g")));
    let prefix = keymap.register_layer(Layer::new().binding(Binding::new("gg").cmd("gg")));
    // The newer prefix wins; without a disambiguation resolver the exact binding never runs.
    press(&keymap, "g");
    assert!(taken(&calls).is_empty());
    press(&keymap, "g");
    assert_eq!(taken(&calls), ["gg"]);
    prefix.dispose();
    exact.dispose();
    keymap.register_layer(Layer::new().binding(Binding::new("gg").cmd("gg"))).forget();
    keymap.register_layer(Layer::new().binding(Binding::new("g").cmd("g"))).forget();
    press(&keymap, "g");
    assert_eq!(taken(&calls), ["g"]);
}

#[test]
fn release_bindings_fire_on_release() {
    let keymap = Keymap::new();
    let messages = diagnostics(&keymap);
    let calls = calls();
    keymap
        .register_layer(
            Layer::new()
                .command(record(&calls, "up"))
                .bindings([Binding::new("x").cmd("up").release(), Binding::new("xy").cmd("up").release()]),
        )
        .forget();
    assert_eq!(*messages.borrow(), ["Keymap release bindings only support a single key stroke"]);
    assert!(!press(&keymap, "x").handled);
    let release = KeyEvent { kind: KeyEventKind::Release, ..event("x") };
    assert!(keymap.handle_key(&release).handled);
    assert_eq!(taken(&calls), ["up"]);
}

// default-parser.test.ts

#[test]
fn unknown_tokens_warn_and_bind_once_registered() {
    let keymap = Keymap::new();
    let messages = diagnostics(&keymap);
    let calls = calls();
    keymap
        .register_layer(Layer::new().command(record(&calls, "run")).binding(Binding::new("<leader>d").cmd("run")))
        .forget();
    leader(&keymap);
    press(&keymap, "ctrl+x");
    press(&keymap, "d");
    assert_eq!(
        *messages.borrow(),
        [
            "[Keymap] Unknown token \"leader\" in key sequence \"<leader>d\"; binding was skipped until the token is registered"
        ]
    );
    assert_eq!(taken(&calls), ["run"]);
}

#[test]
fn parses_the_default_binding_syntax() {
    let keymap = Keymap::<u32>::new();
    leader(&keymap);
    let parse = |key: &str| -> Vec<(String, String, Option<String>)> {
        keymap
            .parse_key_sequence(key)
            .unwrap()
            .into_iter()
            .map(|part| (part.display, part.stroke.to_string(), part.token))
            .collect()
    };
    let part = |display: &str, stroke: &str| (display.to_owned(), stroke.to_owned(), None);
    let leader_part = ("<leader>".to_owned(), "ctrl+x".to_owned(), Some("leader".to_owned()));
    assert_eq!(parse("<leader>down"), [leader_part.clone(), part("down", "down")]);
    assert_eq!(parse("gdown"), [part("g", "g"), part("down", "down")]);
    assert_eq!(parse("f12leftctrl"), [part("f12", "f12"), part("leftctrl", "leftctrl")]);
    assert_eq!(parse("<leader>space"), [leader_part.clone(), part("space", "space")]);
    assert_eq!(parse("<leader>ctrl+downa"), [leader_part, part("ctrl+down", "ctrl+down"), part("a", "a")]);
    assert_eq!(parse("ctrl+shift+f12x"), [part("ctrl+shift+f12", "ctrl+shift+f12"), part("x", "x")]);
    assert_eq!(parse("ctrl"), [part("ctrl", "ctrl")]);
    assert_eq!(parse("control"), [part("control", "control")]);
    assert_eq!(parse(" "), [part("space", "space")]);
    assert_eq!(parse("ctrl + X"), [part("ctrl+x", "ctrl+x")]);
    assert_eq!(parse("ctrl++"), [part("ctrl++", "ctrl++")]);
    assert_eq!(parse("Ctrl+Alt+PageDown"), [part("ctrl+meta+pagedown", "ctrl+meta+pagedown")]);
    assert_eq!(parse("return"), [part("return", "enter")]);
    assert_eq!(parse("<"), [part("<", "<")]);
    assert!(keymap.parse_key_sequence("{count}j").unwrap().is_empty());
    assert_eq!(keymap.parse_key_sequence("ctrl+"), Err("Invalid key \"ctrl+\": missing key name".to_owned()));
    assert_eq!(
        keymap.parse_key_sequence("ctrl + a + b"),
        Err("Invalid key \"ctrl + a + b\": multiple key names are not supported".to_owned())
    );
    assert_eq!(keymap.format_key("<leader>n"), Ok("ctrl+xn".to_owned()));
}

#[test]
fn tokenized_named_keys_dispatch_as_one_stroke() {
    let keymap = Keymap::new();
    let calls = calls();
    leader(&keymap);
    keymap
        .register_layer(
            Layer::new().command(record(&calls, "move-down")).binding(Binding::new("<leader>down").cmd("move-down")),
        )
        .forget();
    for key in ["ctrl+x", "d", "o", "w", "n"] {
        press(&keymap, key);
    }
    assert!(taken(&calls).is_empty());
    press(&keymap, "ctrl+x");
    press(&keymap, "down");
    assert_eq!(taken(&calls), ["move-down"]);
}

#[test]
fn strokes_follow_core_key_names() {
    let stroke = |code, modifiers| Stroke::from_event(&KeyEvent::new(code, modifiers)).to_string();
    assert_eq!(stroke(KeyCode::Char('A'), Modifiers::SHIFT), "shift+a");
    assert_eq!(stroke(KeyCode::Char('A'), Modifiers::NONE), "shift+a");
    assert_eq!(stroke(KeyCode::BackTab, Modifiers::SHIFT), "shift+tab");
    assert_eq!(stroke(KeyCode::Enter, Modifiers::ALT), "meta+enter");
    assert_eq!(Stroke::from_event(&KeyEvent::new(KeyCode::Enter, Modifiers::NONE)).name, "return");
    assert_eq!(stroke(KeyCode::Char(' '), Modifiers::CTRL), "ctrl+space");
    assert_eq!(stroke(KeyCode::PageDown, Modifiers::CTRL | Modifiers::ALT), "ctrl+meta+pagedown");
    assert_eq!(stroke(KeyCode::Char('?'), Modifiers::NONE), "?");
    assert_eq!(stroke(KeyCode::F(5), Modifiers::SUPER | Modifiers::HYPER), "super+hyper+f5");
    assert_eq!(stroke(KeyCode::Other(57441), Modifiers::NONE), "leftshift");
    // Each Kitty key Core names is a key in binding syntax, and the Textarea's own keymap runs each of Core's
    // textarea bindings on the key Core means: its meta is Alt.
    let keymap = Keymap::<u32>::new();
    let parsed = |key: &str| keymap.parse_key_sequence(key).unwrap().remove(0).stroke;
    for code in crate::sys::OT_INPUT_KEY_MEDIA_PLAY..=crate::sys::OT_INPUT_KEY_ISO_LEVEL5_SHIFT {
        let name = stroke(KeyCode::Other(code), Modifiers::NONE);
        assert_eq!(parsed(&name).name, name);
    }
    let editor = crate::widget::Textarea::default_keymap();
    assert_eq!(editor.len(), crate::tables::TEXTAREA_SHORTCUTS.len(), "one row per shortcut");
    for &(key, action) in addons::TEXTAREA_BINDINGS {
        let alt = key.replace("meta", "alt").replace("kpenter", "return");
        let event = KeyEvent { keypad: key.ends_with("kpenter"), ..KeyEvent::from_shortcut(&alt).unwrap() };
        assert_eq!((Stroke::from_event(&event), editor.get(&event)), (parsed(key), Some(action)), "{key}");
    }
}

// enabled.test.ts and metadata.test.ts

#[test]
fn enabled_conditions_gate_layers_and_commands() {
    let keymap = Keymap::new();
    let calls = calls();
    let layer_on = Rc::new(Cell::new(true));
    let command_on = Rc::new(Cell::new(true));
    let checks = Rc::new(Cell::new(0));
    let (layer_gate, command_gate, counter) = (layer_on.clone(), command_on.clone(), checks.clone());
    let gate = Condition::when(move || {
        counter.set(counter.get() + 1);
        command_gate.get()
    });
    keymap.register_layer(Layer::new().command(record(&calls, "run").enabled(gate))).forget();
    keymap
        .register_layer(
            Layer::new().enabled(Condition::when(move || layer_gate.get())).binding(Binding::new("r").cmd("run")),
        )
        .forget();
    keymap.register_layer(Layer::new().enabled(false).binding(Binding::new("s").cmd("run"))).forget();
    assert!(press(&keymap, "r").handled);
    // One view per key: the command's condition runs once, not again before the command runs.
    assert_eq!(checks.get(), 1);
    assert!(!press(&keymap, "s").handled);
    command_on.set(false);
    assert!(!press(&keymap, "r").stop_propagation);
    assert!(active_names(&keymap).is_empty());
    command_on.set(true);
    layer_on.set(false);
    assert!(!press(&keymap, "r").handled);
    assert_eq!(taken(&calls), ["run"]);
}

#[test]
fn conditions_that_flip_between_and_within_keys_dispatch_as_recorded() {
    // A differential row: the trace was recorded on the keymap that built its view of enabled commands several times
    // per key. Commands of one name chain across layers, reject, and flip the conditions of others while a key runs.
    // `d` also matches `c`, so a pending leader advances on both and keeps the captures of the better match.
    let keymap = Keymap::new();
    leader(&keymap);
    keymap
        .append_event_match_resolver(|event| (event.code == KeyCode::Char('d')).then(|| vec![Stroke::new("c")]))
        .forget();
    let calls = calls();
    let gates: Rc<[Cell<bool>; 4]> = Rc::new(Default::default());
    for layer in 0..4 {
        let commands = (0..4).map(|index| {
            let (calls, gates, gate) = (calls.clone(), gates.clone(), gates.clone());
            Command::new(format!("c{index}"), move |_| {
                calls.borrow_mut().push(format!("{layer}.{index}"));
                let flip = &gates[(layer + index) % 4];
                flip.set(!flip.get());
                (layer + index) % 3 != 0
            })
            .enabled(Condition::when(move || gate[layer * index % 4].get()))
        });
        let (gate, flip) = (gates.clone(), gates.clone());
        keymap
            .register_layer(
                Layer::new()
                    .enabled(Condition::when(move || layer != 3 || gate[3].get()))
                    .commands(commands.collect::<Vec<_>>())
                    .bindings([
                        Binding::new("a").cmd(format!("c{layer}")).fallthrough(layer % 2 == 0),
                        Binding::new("b").cmd("c1").fallthrough(true),
                        Binding::new("e").cmd(format!("c{}", (4 - layer) % 4)).fallthrough(true),
                        Binding::new("f").run(move |_| flip[layer].set(!flip[layer].get())).fallthrough(true),
                        Binding::new("f").cmd(format!("c{layer}")),
                        Binding::new(["<leader>c", "<leader>d"][layer % 2]).cmd(format!("c{}", 3 - layer)),
                    ]),
            )
            .forget();
    }
    let keys =
        "a b e f a ctrl+x c e f a ctrl+x d b e !c2 ctrl+x c f c e a b e f b !c0 a e ctrl+x d a e f b ctrl+x x a e f";
    let mut trace = Vec::new();
    for (step, key) in keys.split(' ').enumerate() {
        gates[step % 4].set(step % 3 != 0);
        let reason = match key.strip_prefix('!') {
            Some(name) => format!("{:?}", keymap.dispatch_command(name)),
            None => format!("{:?}", press(&keymap, key).reason),
        };
        trace.push(format!("{key}:{reason}:{}", taken(&calls).join(",")));
    }
    let recorded = "a:NoMatch: b:BindingHandled:1.1,2.1,1.1,3.1 e:BindingHandled:3.1,3.2,2.3 f:BindingHandled:2.0 \
         a:BindingHandled:2.2,2.1 ctrl+x:SequencePending: c:BindingHandled:3.1 \
         e:BindingHandled:3.1,3.3,1.3,3.0,2.0 f:BindingHandled:2.2 a:BindingHandled:1.2,3.1 \
         ctrl+x:SequencePending: d:BindingHandled:3.0,2.0 b:NoMatch: e:NoMatch: !c2:Disabled:1.2 \
         ctrl+x:SequencePending: c:BindingHandled:2.1,1.1 f:BindingHandled:0.3,3.2 c:NoMatch: \
         e:BindingHandled:3.1,1.3,3.0,2.0 a:BindingHandled:2.2,2.1 b:BindingHandled:3.1,3.1,3.1,3.1 \
         e:BindingHandled:3.1,3.2,3.3,2.3 f:BindingHandled:0.3,3.2 b:BindingHandled:3.1,3.1,3.1,3.1 \
         !c0:Disabled: a:BindingHandled:3.3,2.3 e:NoMatch: ctrl+x:SequencePending: d:BindingHandled:2.2 \
         a:BindingHandled:1.1 e:BindingHandled:3.1,3.2,2.3 f:BindingHandled:2.3 \
         b:BindingHandled:2.1,0.1,3.1,3.1 ctrl+x:SequencePending: x:SequenceMiss: a:BindingHandled:3.3,2.3 \
         e:BindingHandled:3.1,3.3,1.3 f:BindingHandled:2.3";
    assert_eq!(trace.join(" "), recorded);
}

#[test]
fn active_keys_carry_binding_and_command_metadata() {
    let keymap = Keymap::new();
    let calls = calls();
    keymap
        .register_layer(
            Layer::new().command(record(&calls, "save").title("Save").desc("Save the file").category("File")),
        )
        .forget();
    keymap
        .register_layer(Layer::new().binding(Binding::new("ctrl+s").cmd("save").desc("Write").group("Files")))
        .forget();
    let keys = keymap.active_keys(ActiveKeyOptions { include_bindings: true, include_metadata: true });
    assert_eq!(keys.len(), 1);
    assert_eq!(keys[0].display, "ctrl+s");
    assert_eq!(keys[0].desc.as_deref(), Some("Write"));
    assert_eq!(keys[0].group.as_deref(), Some("Files"));
    let command = keys[0].command_info.as_ref().unwrap();
    assert_eq!((command.title.as_deref(), command.category.as_deref()), (Some("Save"), Some("File")));
    assert_eq!(keys[0].bindings.as_ref().unwrap().len(), 1);
    let plain = keymap.active_keys(ActiveKeyOptions::default());
    assert!(plain[0].desc.is_none() && plain[0].bindings.is_none());
}

#[test]
fn empty_metadata_is_an_error() {
    let keymap = Keymap::new();
    let messages = diagnostics(&keymap);
    let calls = calls();
    keymap.register_layer(Layer::new().command(record(&calls, "run").title(" "))).forget();
    keymap.register_layer(Layer::new().binding(Binding::new("r").cmd("run").desc(""))).forget();
    assert_eq!(
        *messages.borrow(),
        ["Keymap metadata field \"title\" cannot be empty", "Keymap metadata field \"desc\" cannot be empty"]
    );
}

#[test]
fn command_queries_filter_by_namespace_search_and_names() {
    let keymap = Keymap::new();
    let calls = calls();
    keymap
        .register_layer(Layer::new().commands([
            record(&calls, "session.new").title("New session").namespace("palette"),
            record(&calls, "session.list").title("Sessions").namespace("palette"),
            record(&calls, "input.submit"),
        ]))
        .forget();
    keymap
        .register_layer(
            Layer::new()
                .bindings([Binding::new("ctrl+n").cmd("session.new"), Binding::new("<leader>n").cmd("session.new")]),
        )
        .forget();
    let names = |query: CommandQuery<u32>| -> Vec<String> {
        keymap.commands(&query).iter().map(|command| command.name.clone()).collect()
    };
    let palette = CommandQuery { namespace: Some(vec!["palette".into()]), ..CommandQuery::default() };
    assert_eq!(names(palette), ["session.new", "session.list"]);
    assert_eq!(names(CommandQuery { search: Some("LIST".into()), ..CommandQuery::default() }), ["session.list"]);
    let titles =
        CommandQuery { search: Some("new".into()), search_in: vec!["title".into()], ..CommandQuery::default() };
    assert_eq!(names(titles), ["session.new"]);
    assert_eq!(
        names(CommandQuery { names: Some(vec!["input.submit".into()]), ..CommandQuery::default() }),
        ["input.submit"]
    );
    assert_eq!(names(CommandQuery { limit: Some(1), ..CommandQuery::default() }), ["session.new"]);
    let entries =
        keymap.command_entries(&CommandQuery { names: Some(vec!["session.new".into()]), ..CommandQuery::default() });
    // `<leader>n` waits for the token, so only `ctrl+n` binds.
    assert_eq!(entries[0].bindings.len(), 1);
    leader(&keymap);
    let bindings = keymap.command_bindings(Visibility::Registered, &["session.new", "input.submit"]);
    let shown: Vec<String> = bindings["session.new"]
        .iter()
        .map(|binding| format_key_sequence(&binding.sequence, &FormatOptions::default()))
        .collect();
    assert_eq!(shown, ["ctrl+n", "<leader> n"]);
    assert!(bindings["input.submit"].is_empty());
}

// Addons: comma-bindings, escape, backspace, base-layout, leader, timed-leader, edit-buffer-bindings.

#[test]
fn comma_bindings_expand_alternatives() {
    let keymap = Keymap::new();
    let messages = diagnostics(&keymap);
    let calls = calls();
    addons::comma_bindings(&keymap).forget();
    leader(&keymap);
    keymap
        .register_layer(
            Layer::new()
                .command(record(&calls, "app.exit"))
                .binding(Binding::new("ctrl+c,ctrl+d,<leader>q").cmd("app.exit")),
        )
        .forget();
    keymap.register_layer(Layer::new().binding(Binding::new("a,,b").cmd("app.exit"))).forget();
    for key in ["ctrl+c", "ctrl+d", "ctrl+x", "q"] {
        press(&keymap, key);
    }
    assert_eq!(taken(&calls), ["app.exit", "app.exit", "app.exit"]);
    assert_eq!(
        *messages.borrow(),
        ["Invalid key sequence \"a,,b\": comma-separated bindings cannot contain empty entries"]
    );
}

#[test]
fn key_aliases_replace_standalone_names() {
    let keymap = Keymap::new();
    let calls = calls();
    addons::comma_bindings(&keymap).forget();
    addons::key_aliases(&keymap, &[("enter", "return"), ("esc", "escape"), ("pgdown", "pagedown"), ("pgup", "pageup")])
        .forget();
    keymap
        .register_layer(Layer::new().commands([
            record(&calls, "submit"),
            record(&calls, "close"),
            record(&calls, "page"),
        ]))
        .forget();
    keymap
        .register_layer(Layer::new().bindings([
            Binding::new("shift+enter,ENTER").cmd("submit"),
            Binding::new("esc").cmd("close"),
            Binding::new("ctrl+alt+pgdown").cmd("page"),
        ]))
        .forget();
    for key in ["shift+enter", "enter", "escape", "ctrl+alt+pagedown"] {
        press(&keymap, key);
    }
    assert_eq!(taken(&calls), ["submit", "submit", "close", "page"]);
    // `escape` and `enterprise` keep their spelling.
    let names: Vec<String> =
        keymap.parse_key_sequence("escape").unwrap().into_iter().map(|part| part.stroke.name).collect();
    assert_eq!(names, ["escape"]);
}

#[test]
fn escape_clears_and_backspace_pops_a_pending_sequence() {
    let keymap = Keymap::new();
    let calls = calls();
    addons::escape_clears_pending_sequence(&keymap, 0).forget();
    addons::backspace_pops_pending_sequence(&keymap, 0).forget();
    keymap
        .register_layer(Layer::new().command(record(&calls, "delete-ca")).binding(Binding::new("dca").cmd("delete-ca")))
        .forget();
    assert!(!press(&keymap, "escape").stop_propagation);
    assert!(!press(&keymap, "backspace").stop_propagation);
    press(&keymap, "d");
    press(&keymap, "c");
    assert_eq!(pending(&keymap), ["d", "c"]);
    assert_eq!(press(&keymap, "backspace").reason, KeyReason::InterceptConsumed);
    assert_eq!(pending(&keymap), ["d"]);
    assert_eq!(active_names(&keymap), ["c"]);
    press(&keymap, "c");
    press(&keymap, "a");
    assert_eq!(taken(&calls), ["delete-ca"]);
    press(&keymap, "d");
    assert!(press(&keymap, "escape").stop_propagation);
    assert!(pending(&keymap).is_empty());
    press(&keymap, "d");
    assert!(keymap.pop_pending_sequence());
    assert!(pending(&keymap).is_empty());
}

#[test]
fn intercepts_run_by_priority_and_can_consume() {
    let keymap = Keymap::new();
    let calls = calls();
    let (low, high) = (calls.clone(), calls.clone());
    keymap.intercept_key(0, false, move |_| low.borrow_mut().push("low".into())).forget();
    keymap
        .intercept_key(100, false, move |context| {
            high.borrow_mut().push("high".into());
            if context.stroke.name == "q" {
                context.consume();
            }
        })
        .forget();
    keymap.register_layer(Layer::new().command(record(&calls, "run")).binding(Binding::new("q").cmd("run"))).forget();
    assert_eq!(press(&keymap, "q").reason, KeyReason::InterceptConsumed);
    press(&keymap, "w");
    assert_eq!(taken(&calls), ["high", "high", "low"]);
}

#[test]
fn base_layout_fallback_matches_non_latin_layouts() {
    let keymap = Keymap::new();
    let calls = calls();
    addons::base_layout_fallback(&keymap).forget();
    keymap
        .register_layer(
            Layer::new()
                .commands([record(&calls, "copy"), record(&calls, "one")])
                .bindings([Binding::new("ctrl+c").cmd("copy"), Binding::new("ctrl+1").cmd("one")]),
        )
        .forget();
    let with_base = |code, base| KeyEvent { base_layout: Some(base), ..KeyEvent::new(code, Modifiers::CTRL) };
    assert!(keymap.handle_key(&with_base(KeyCode::Char('ㅊ'), 'c')).handled);
    assert!(keymap.handle_key(&with_base(KeyCode::Char('&'), '1')).handled);
    assert!(!keymap.handle_key(&with_base(KeyCode::Char('j'), 'c')).handled);
    assert_eq!(taken(&calls), ["copy", "one"]);
}

#[test]
fn timed_leader_expires_its_sequence() {
    let keymap = Keymap::new();
    let calls = calls();
    let leader = addons::timed_leader(&keymap, "leader", "ctrl+x", Duration::from_millis(2000)).unwrap();
    keymap
        .register_layer(Layer::new().command(record(&calls, "new")).binding(Binding::new("<leader>gn").cmd("new")))
        .forget();
    assert!(leader.deadline().is_none());
    press(&keymap, "ctrl+x");
    let deadline = leader.deadline().expect("armed");
    assert!(!leader.expire(Instant::now()));
    press(&keymap, "g");
    assert!(leader.deadline().unwrap() >= deadline);
    assert!(leader.expire(Instant::now() + Duration::from_millis(2000)));
    assert!(pending(&keymap).is_empty());
    assert!(leader.deadline().is_none());
    press(&keymap, "ctrl+x");
    press(&keymap, "g");
    press(&keymap, "n");
    assert!(leader.deadline().is_none());
    assert_eq!(taken(&calls), ["new"]);
    leader.dispose();
    assert!(keymap.parse_key_sequence("<leader>").unwrap().is_empty());
}

#[test]
fn managed_textarea_layer_runs_edit_actions() {
    let keymap = Keymap::new();
    let actions: Rc<RefCell<Vec<EditorAction>>> = Rc::default();
    let focused = Rc::new(Cell::new(true));
    let (sink, gate) = (actions.clone(), focused.clone());
    addons::managed_textarea_layer(
        &keymap,
        ManagedTextarea {
            enabled: Condition::when(move || gate.get()),
            bindings: vec![Binding::new("ctrl+a").cmd("input.select.all")],
            run: Rc::new(move |action| {
                sink.borrow_mut().push(action);
                true
            }),
        },
    )
    .forget();
    press(&keymap, "ctrl+a");
    press(&keymap, "ctrl+e");
    press(&keymap, "alt+enter");
    press(&keymap, "enter");
    // A legacy line feed (Ctrl+J) and Kitty keypad Enter insert a newline, and Alt+keypad Enter submits, as in Core.
    let mut parser = crate::input::Parser::standalone().unwrap();
    let mut out = Vec::new();
    parser.feed(b"\n\x1b[57414u\x1b[57414;3u", Instant::now(), &mut out).unwrap();
    for input in out {
        let crate::input::Input::Event(crate::input::Event::Key(key)) = input else { panic!("{input:?}") };
        assert!(keymap.handle_key(&key).handled, "{key:?}");
    }
    assert_eq!(
        *actions.borrow(),
        [
            EditorAction::SelectAll,
            EditorAction::LineEnd,
            EditorAction::Submit,
            EditorAction::Newline,
            EditorAction::Newline,
            EditorAction::Newline,
            EditorAction::Submit,
        ]
    );
    focused.set(false);
    assert!(!press(&keymap, "ctrl+e").handled);
    assert_eq!(keymap.dispatch_command("input.undo"), RunResult::Ok);
    assert_eq!(actions.borrow().last(), Some(&EditorAction::Undo));
    let command =
        keymap.commands(&CommandQuery { names: Some(vec!["input.submit".into()]), ..CommandQuery::default() });
    assert_eq!((command[0].desc.as_deref(), command[0].category.as_deref()), (Some("Submit"), Some("Text Editing")));
}

// A layer stack like OpenCode's mode stack (`keymap.tsx`'s `createMode`): base-mode layers require the mode, global
// layers do not.
#[test]
fn modes_switch_layers_like_the_tui_mode_stack() {
    let keymap = Keymap::new();
    let calls = calls();
    keymap.set_data("opencode.mode", "base");
    keymap
        .register_layer(
            Layer::new()
                .require("opencode.mode", "base")
                .command(record(&calls, "session.new"))
                .binding(Binding::new("ctrl+n").cmd("session.new")),
        )
        .forget();
    keymap
        .register_layer(
            Layer::new()
                .require("opencode.mode", "dialog")
                .command(record(&calls, "dialog.close"))
                .binding(Binding::new("escape").cmd("dialog.close")),
        )
        .forget();
    keymap
        .register_layer(
            Layer::new().command(record(&calls, "app.exit")).binding(Binding::new("ctrl+c").cmd("app.exit")),
        )
        .forget();
    press(&keymap, "ctrl+n");
    assert!(!press(&keymap, "escape").handled);
    keymap.set_data("opencode.mode", "dialog");
    assert!(!press(&keymap, "ctrl+n").handled);
    press(&keymap, "escape");
    press(&keymap, "ctrl+c");
    assert_eq!(taken(&calls), ["session.new", "dialog.close", "app.exit"]);
    assert_eq!(keymap.dispatch_command("session.new"), RunResult::Disabled);
}

// Terminal bytes through this crate's parser reach the same commands as Core's key events.
#[test]
fn parsed_terminal_input_dispatches_tui_defaults() {
    let keymap = Keymap::<u32>::new();
    let calls = calls();
    addons::comma_bindings(&keymap).forget();
    addons::key_aliases(&keymap, &[("enter", "return"), ("esc", "escape"), ("pgdown", "pagedown"), ("pgup", "pageup")])
        .forget();
    let _leader = addons::timed_leader(&keymap, "leader", "ctrl+x", Duration::from_millis(2000)).unwrap();
    let commands = ["app.exit", "command.palette.show", "session.new", "input.newline", "session.page.down", "upper"];
    keymap
        .register_layer(Layer::new().commands(commands.map(|name| record(&calls, name))).bindings([
            Binding::new("ctrl+c,ctrl+d,<leader>q").cmd("app.exit"),
            Binding::new("ctrl+p").cmd("command.palette.show"),
            Binding::new("<leader>n").cmd("session.new"),
            Binding::new("shift+enter,ctrl+enter,alt+enter,ctrl+j").cmd("input.newline"),
            Binding::new("pgdown").cmd("session.page.down"),
            Binding::new("shift+a").cmd("upper"),
        ]))
        .forget();
    let mut parser = crate::input::Parser::standalone().unwrap();
    let mut dispatched = Vec::new();
    for bytes in [
        &b"\x10"[..],            // ctrl+p
        b"\x18n",                // ctrl+x, n
        b"\x1b[13;2u",           // Kitty shift+enter
        b"\x1b\r",               // alt+enter
        b"\x1b[6~",              // page down
        b"A",                    // shift+a
        b"\x1b[120;5u\x1b[113u", // Kitty ctrl+x, q
        b"z",
    ] {
        let mut out = Vec::new();
        parser.feed(bytes, Instant::now(), &mut out).unwrap();
        for input in out {
            if let crate::input::Input::Event(crate::input::Event::Key(key)) = input {
                dispatched.push((Stroke::from_event(&key).to_string(), keymap.handle_key(&key).handled));
            }
        }
    }
    let shown: Vec<String> = dispatched.iter().map(|(stroke, handled)| format!("{stroke}={handled}")).collect();
    assert_eq!(
        shown,
        [
            "ctrl+p=true",
            "ctrl+x=true",
            "n=true",
            "shift+enter=true",
            "meta+enter=true",
            "pagedown=true",
            "shift+a=true",
            "ctrl+x=true",
            "q=true",
            "z=false",
        ]
    );
    assert_eq!(
        taken(&calls),
        [
            "command.palette.show",
            "session.new",
            "input.newline",
            "input.newline",
            "session.page.down",
            "upper",
            "app.exit"
        ]
    );
}

// extras: binding-lookup.test.ts, formatting.test.ts

#[test]
fn binding_lookup_turns_config_into_bindings() {
    let config = vec![
        ("leader".to_owned(), BindingValue::key("ctrl+x")),
        (
            "app.exit".to_owned(),
            BindingValue::Items(vec!["ctrl+c".into(), BindingItem::Binding(Binding::new("ctrl+d").desc("Quit"))]),
        ),
        ("app.debug".to_owned(), BindingValue::key("none")),
        ("session.new".to_owned(), BindingValue::key("<leader>n")),
    ];
    let defaults = |command: &str, binding: &mut Binding<u32>| {
        if binding.desc.is_none() {
            binding.desc = Some(format!("{command} description"));
        }
    };
    let mut lookup = BindingLookup::with_options(config, None, Some(&defaults)).unwrap();
    assert!(lookup.has("app.exit") && !lookup.has("app.debug"));
    assert!(lookup.get("app.debug").is_empty());
    let exit: Vec<_> =
        lookup.get("app.exit").iter().map(|binding| (binding.key.to_string(), binding.desc.clone().unwrap())).collect();
    assert_eq!(
        exit,
        [("ctrl+c".to_owned(), "app.exit description".to_owned()), ("ctrl+d".to_owned(), "Quit".to_owned())]
    );
    assert_eq!(lookup.get("app.exit")[0].cmd.as_ref().and_then(BindingCommand::name), Some("app.exit"));
    assert_eq!(lookup.bindings().len(), 4);
    assert_eq!(lookup.gather("app", &["app.exit", "session.new", "app.debug"]).len(), 3);
    assert_eq!(lookup.pick("app", &["session.new"]).len(), 1);
    assert_eq!(lookup.omit("app", &["app.exit"]).len(), 1);
    assert!(lookup.pick("other", &["app.exit"]).is_empty());
    let map = HashMap::from([("old.exit".to_owned(), "app.exit".to_owned())]);
    let mapped =
        BindingLookup::<u32>::with_options([("old.exit".to_owned(), BindingValue::key("q"))], Some(&map), None)
            .unwrap();
    assert_eq!(mapped.get("app.exit").len(), 1);
}

#[test]
fn formatting_applies_token_key_and_modifier_aliases() {
    let keymap = Keymap::<u32>::new();
    leader(&keymap);
    let options = FormatOptions {
        token_display: HashMap::from([("leader".into(), "ctrl+x".into())]),
        key_name_aliases: HashMap::from([("up".into(), "↑".into()), ("pagedown".into(), "pgdn".into())]),
        modifier_aliases: HashMap::from([("meta".into(), "alt".into())]),
        ..FormatOptions::default()
    };
    let sequence = |key: &str| keymap.parse_key_sequence(key).unwrap();
    assert_eq!(format_key_sequence(&sequence("<leader>up"), &options), "ctrl+x ↑");
    assert_eq!(format_key_sequence(&sequence("alt+pagedown"), &options), "alt+pgdn");
    assert_eq!(format_key_sequence(&sequence("return"), &options), "enter");
    assert_eq!(format_key_sequence(&sequence("return"), &FormatOptions::default()), "return");
    let (first, second) = (sequence("ctrl+c"), sequence("ctrl+d"));
    let all = [first.as_slice(), second.as_slice(), first.as_slice()];
    assert_eq!(format_command_bindings(all, &FormatOptions::default()).as_deref(), Some("ctrl+c, ctrl+d"));
    assert_eq!(format_command_bindings(std::iter::empty(), &FormatOptions::default()), None);
}
