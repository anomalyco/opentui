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
