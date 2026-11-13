//! Async tasks with the `tokio` feature.
#![cfg(feature = "tokio")]

use opentui::prelude::*;
use opentui::testing::TestApp;
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Duration;

#[test]
fn spawned_futures_finish_on_the_ui_thread() {
    let app = TestApp::new(20, 1);
    let status = Text::new(&app, "loading");
    app.root().add(&status);
    let ui_thread = std::thread::current().id();
    let ran_on = Rc::new(RefCell::new(None));
    let task = app.spawn(
        async {
            tokio::time::sleep(Duration::from_millis(5)).await;
            (std::thread::current().id(), 6 * 7)
        },
        {
            let (status, ran_on) = (status.clone(), ran_on.clone());
            move |_cx, (worker, answer)| {
                status.set_text(format!("answer {answer}"));
                *ran_on.borrow_mut() = Some(worker);
            }
        },
    );
    assert!(app.wait_until(Duration::from_secs(5), || ran_on.borrow().is_some()));
    assert!(task.is_finished());
    assert_ne!(ran_on.borrow().unwrap(), ui_thread);
    assert_eq!(app.render().row(0).trim_end(), "answer 42");
}

#[test]
fn aborted_tasks_never_call_back() {
    let app = TestApp::new(20, 1);
    let called = Rc::new(Cell::new(false));
    let task = app.spawn(
        async {
            tokio::time::sleep(Duration::from_millis(50)).await;
        },
        {
            let called = called.clone();
            move |_cx, ()| called.set(true)
        },
    );
    task.abort();
    assert!(!app.wait_until(Duration::from_millis(150), || called.get()));
}

#[test]
fn ambient_multi_thread_runtimes_are_reused() {
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(1).build().unwrap();
    let _guard = runtime.enter();
    let app = TestApp::new(10, 1);
    assert_eq!(app.runtime().id(), runtime.handle().id());
}

#[test]
fn abort_between_posting_a_result_and_the_ui_turn_drops_only_that_task() {
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(1).build().unwrap();
    let _guard = runtime.enter();
    for cancel in [None, Some(0), Some(1)] {
        let app = TestApp::new(4, 1);
        let results = Rc::new(RefCell::new(Vec::new()));
        let mut tasks = Vec::new();
        for id in [0, 1] {
            let results = Rc::clone(&results);
            let (tx, rx) = std::sync::mpsc::channel();
            tasks.push(app.spawn(
                async move {
                    // This task returns in the same poll. On this single worker the marker cannot run
                    // until spawn's wrapper has posted the output; the UI hasn't had a turn yet.
                    tokio::spawn(async move {
                        let _ = tx.send(());
                    });
                    id + 10
                },
                move |_, value| results.borrow_mut().push((id, value)),
            ));
            rx.recv_timeout(Duration::from_secs(5)).unwrap();
        }
        if let Some(id) = cancel {
            tasks[id].abort();
        }
        assert!(results.borrow().is_empty());
        app.advance(Duration::ZERO);
        app.advance(Duration::ZERO);
        let expected: Vec<_> = (0..2).filter(|&id| Some(id) != cancel).map(|id| (id, id + 10)).collect();
        assert_eq!(*results.borrow(), expected);
    }
}

#[test]
fn current_thread_runtimes_are_not_used() {
    // App::run would block the runtime's only thread, so tasks could never run there.
    let runtime = tokio::runtime::Builder::new_current_thread().build().unwrap();
    let _guard = runtime.enter();
    let app = TestApp::new(10, 1);
    assert_ne!(app.runtime().id(), runtime.handle().id());
    let done = Rc::new(Cell::new(false));
    app.spawn(async {}, {
        let done = done.clone();
        move |_cx, ()| done.set(true)
    });
    assert!(app.wait_until(Duration::from_secs(5), || done.get()));
}
