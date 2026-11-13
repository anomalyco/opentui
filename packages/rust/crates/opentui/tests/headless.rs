//! Headless apps on the real clock: frames, terminal writes, timers, and driving from another thread.

use opentui::app::{HeadlessOptions, HeadlessWrite};
use opentui::input::Event;
use opentui::prelude::*;
use opentui::remote::{RemoteOptions, RemoteTerminal};
use opentui::testing::TestApp;
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::mpsc;
use std::time::{Duration, Instant};

fn headless(width: u16, height: u16) -> App {
    App::headless(HeadlessOptions { width, height, ..HeadlessOptions::default() }).expect("headless app")
}

/// Ends a run that a broken test would leave waiting forever.
fn watchdog(app: &App) {
    let proxy = app.proxy();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(20));
        let _ = proxy.post(|cx| cx.fail(Error::Usage("the watchdog ended the run")));
    });
}

/// Runs `drive` on another thread with a function that runs a closure on the UI thread and returns its result, as a
/// driver answering requests does. The app quits when `drive` returns.
fn drive<T: Send + 'static>(
    app: &App,
    drive: impl FnOnce(&dyn Fn(Box<dyn FnOnce(&App) -> T + Send>) -> T) + Send + 'static,
) {
    let proxy = app.proxy();
    std::thread::spawn(move || {
        let call = |task: Box<dyn FnOnce(&App) -> T + Send>| {
            let (sender, receiver) = mpsc::sync_channel(1);
            proxy.post(move |cx| drop(sender.send(task(cx.app())))).expect("the app runs");
            receiver.recv_timeout(Duration::from_secs(10)).expect("the UI thread answers")
        };
        drive(&call);
        let _ = proxy.quit();
    });
}

#[test]
fn frames_are_captured_as_the_app_paints_them() {
    let app = headless(12, 2);
    watchdog(&app);
    let input = Input::new(&app).placeholder("name");
    app.root().add(&input);
    input.focus();
    let frames = Rc::new(RefCell::new(Vec::new()));
    app.on_headless_frame({
        let frames = frames.clone();
        move |_cx, frame| frames.borrow_mut().push(frame.row(0).trim_end().to_owned())
    });
    let (sender, receiver) = mpsc::channel();
    drive(&app, move |call| {
        // The loop paints the first frame by itself.
        let deadline = Instant::now() + Duration::from_secs(10);
        while call(Box::new(|app| app.last_frame())).is_none() {
            assert!(Instant::now() < deadline, "no first frame");
            std::thread::sleep(Duration::from_millis(1));
        }
        call(Box::new(|app| {
            for character in "Ada".chars() {
                app.dispatch(Event::Key(KeyEvent::new(KeyCode::Char(character), Modifiers::NONE)));
            }
            None
        }));
        // The loop paints the change too: wait for it without asking for a frame.
        while call(Box::new(|app| app.last_frame())).is_some_and(|frame| frame.row(0).trim_end() != "Ada") {
            assert!(Instant::now() < deadline, "the typed text never painted");
            std::thread::sleep(Duration::from_millis(1));
        }
        let resized = call(Box::new(|app| {
            app.resize(5, 3).expect("resize");
            Some(app.capture().expect("capture"))
        }));
        sender.send(resized).unwrap();
    });
    app.clone().run().expect("run");
    let resized = receiver.recv().unwrap().expect("a resized frame");
    assert_eq!((resized.width, resized.height), (5, 3));
    assert_eq!(resized.row(0), "Ada  ");
    let frames = frames.borrow();
    assert_eq!(frames.first().map(String::as_str), Some("name"));
    assert!(frames.iter().any(|row| row == "Ada"), "{frames:?}");
    assert_eq!(app.size(), (5, 3));
}

#[test]
fn sinks_get_clipboard_notification_and_title_writes() {
    let options = AppOptions::default().with_title("start");
    let app = App::headless(HeadlessOptions { width: 10, height: 1, app: options }).expect("headless app");
    watchdog(&app);
    // Before the loop runs there is no terminal to write to, as for an app on a terminal.
    assert!(!app.notify("early", None));
    assert!(!app.copy_to_clipboard("early"));
    let writes = Rc::new(RefCell::new(Vec::new()));
    let id = app.on_headless_write({
        let writes = writes.clone();
        move |_cx, write| writes.borrow_mut().push(write.clone())
    });
    let answers = Rc::new(RefCell::new(Vec::new()));
    app.set_timeout(Duration::ZERO, {
        let answers = answers.clone();
        move |cx| {
            answers.borrow_mut().extend([
                cx.copy_to_clipboard("copied"),
                cx.copy_to_clipboard(""),
                cx.notify("done", Some("OpenCode")),
                cx.notify("plain", None),
            ]);
            cx.set_title("renamed");
            cx.quit();
        }
    });
    app.clone().run().expect("run");
    assert_eq!(*answers.borrow(), [true, false, true, true]);
    assert_eq!(
        *writes.borrow(),
        [
            HeadlessWrite::Title("start".into()),
            HeadlessWrite::Clipboard("copied".into()),
            HeadlessWrite::Notification { message: "done".into(), title: Some("OpenCode".into()) },
            HeadlessWrite::Notification { message: "plain".into(), title: None },
            HeadlessWrite::Title("renamed".into()),
        ]
    );
    // The run tore the handlers down.
    assert!(!app.remove_handler(id));
}

#[test]
fn timers_fire_on_the_real_clock() {
    let app = headless(10, 1);
    watchdog(&app);
    let started = Instant::now();
    let fired = Rc::new(Cell::new(None));
    app.set_timeout(Duration::from_millis(60), {
        let fired = fired.clone();
        move |_cx| fired.set(Some(started.elapsed()))
    });
    // Waits for both timers instead of racing them: a late wake collapses missed interval ticks into one.
    let ticks = Cell::new(0);
    app.set_interval(Duration::from_millis(10), move |cx| {
        ticks.set(ticks.get() + 1);
        if ticks.get() >= 3
            && let Some(fired) = fired.get()
        {
            assert!(fired >= Duration::from_millis(60), "{fired:?}");
            cx.quit();
        }
    });
    app.run().expect("run");
}

/// Where the timer that ends a run is armed: while a widget paints, from a task it defers while painting, from an
/// animation such a task starts, from a timer callback, or by the animation clock for a spinner that starts ticking
/// on the widget while it paints.
#[derive(Clone, Copy, Debug)]
enum Arm {
    Paint,
    Defer,
    Animate,
    Timer,
    Tick,
}

/// A widget that arms a timer the first time it paints.
struct Arming {
    app: App,
    arm: Arm,
    armed: Cell<bool>,
    /// The widget itself, for [`Arm::Tick`], and its spinner.
    widget: RefCell<Option<AnyWidget>>,
    spinner: RefCell<Option<AnimationTick>>,
}

/// Arms a 20 ms timer that quits.
fn arm_quit(app: &App) {
    app.set_timeout(Duration::from_millis(20), |cx| cx.quit());
}

impl Component for Arming {
    fn paint(&self, _painter: &mut Painter<'_>) {
        match self.arm {
            _ if self.armed.replace(true) => {}
            Arm::Paint => arm_quit(&self.app),
            Arm::Defer => self.app.defer(|cx| arm_quit(cx.app())),
            Arm::Animate => self.app.defer(|cx| {
                cx.animate(|cx, _| {
                    arm_quit(cx.app());
                    false
                })
            }),
            Arm::Timer => {}
            Arm::Tick => {
                let widget = self.widget.take().expect("the widget");
                let mut ticks = 0;
                *self.spinner.borrow_mut() = Some(widget.on_animation_tick(50.0, move |cx, tick| {
                    ticks += tick.ticks;
                    if ticks >= 3 {
                        cx.quit();
                    }
                    cx.request_redraw();
                }));
            }
        }
    }
}

#[test]
fn timers_armed_while_painting_fire_on_time() {
    // Runs an app whose only wakeup after its first frame is the timer `arm` sets up, headless or on a remote terminal
    // that never reads its output. A timer the loop misses waits for the next unrelated wakeup: the watchdog, or a
    // remote terminal's 5 s capability window closing.
    let late = |&(arm, remote): &(Arm, bool)| {
        let run = move |terminal: Option<RemoteTerminal>| {
            let app = match terminal {
                Some(terminal) => App::remote(terminal, AppOptions::default().with_theme(Theme::dark()))?,
                None => headless(10, 1),
            };
            watchdog(&app);
            if let Arm::Timer = arm {
                app.set_timeout(Duration::ZERO, |cx| arm_quit(cx.app()));
            }
            let (widget, spinner) = (RefCell::new(None), RefCell::new(None));
            let arming = Custom::new(&app, Arming { app: app.clone(), arm, armed: Cell::new(false), widget, spinner });
            arming.with(|component| *component.widget.borrow_mut() = Some(arming.as_any()));
            app.root().add(&arming.height(1).grow(1.0));
            app.run()
        };
        let started = Instant::now();
        let ended = if remote {
            let (terminal, _link) = RemoteTerminal::new(RemoteOptions::default(), || {}).expect("a remote terminal");
            std::thread::spawn(move || run(Some(terminal))).join().expect("the app thread")
        } else {
            run(None)
        };
        ended.is_err() || started.elapsed() > Duration::from_secs(2)
    };
    let rows = [false, true]
        .into_iter()
        .flat_map(|remote| [Arm::Paint, Arm::Defer, Arm::Animate, Arm::Timer, Arm::Tick].map(|arm| (arm, remote)));
    let late: Vec<_> = rows.filter(late).collect();
    assert!(late.is_empty(), "{late:?}");
}

#[test]
fn removed_handlers_stop_and_terminal_apps_have_no_capture() {
    let app = headless(4, 1);
    watchdog(&app);
    let frames = Rc::new(Cell::new(0));
    let id = app.on_headless_frame({
        let frames = frames.clone();
        move |_cx, _frame| frames.set(frames.get() + 1)
    });
    assert!(app.remove_handler(id));
    assert!(app.is_headless());
    app.set_timeout(Duration::ZERO, |cx| {
        cx.capture().expect("capture");
        cx.quit();
    });
    app.clone().run().expect("run");
    assert_eq!(frames.get(), 0);
    assert!(app.last_frame().is_some());

    let test = TestApp::new(4, 1);
    assert!(!test.is_headless());
    assert!(matches!(test.app().capture(), Err(Error::Usage(_))));
    assert!(matches!(test.app().resize(2, 2), Err(Error::Usage(_))));
    assert!(test.last_frame().is_none());
}

#[cfg(feature = "tokio")]
#[test]
fn spawned_tasks_wake_the_loop() {
    let app = headless(10, 1);
    watchdog(&app);
    let answer = Rc::new(Cell::new(0));
    app.spawn(
        async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            42
        },
        {
            let answer = answer.clone();
            move |cx, value| {
                answer.set(value);
                cx.quit();
            }
        },
    );
    app.run().expect("run");
    assert_eq!(answer.get(), 42);
}
