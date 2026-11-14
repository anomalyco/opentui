//! Headless apps on the real clock: frames, terminal writes, timers, and driving from another thread.

use opentui::app::{HeadlessOptions, HeadlessWrite};
use opentui::input::{Event, MouseEvent, MouseEventKind};
use opentui::prelude::*;
use opentui::remote::{OUTPUT_BYTES_MAX, RemoteOptions, RemoteTerminal};
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
/// animation such a task starts, from a timer callback, or from an animation that a hover handler starts once a
/// frame's output is complete. `Quit` quits from a task the widget defers while painting instead, and `Tick` from the
/// third tick of a spinner that starts ticking on the widget while it paints.
#[derive(Clone, Copy, Debug)]
enum Arm {
    Paint,
    Defer,
    Animate,
    Timer,
    Hover,
    Quit,
    Tick,
}

/// Where an app runs: headless, on a remote terminal that never reads its output, on one whose first frame does not
/// fit the output buffer, on one whose client reads its output only after 300 ms, or nowhere: a [`TestApp`] dropped
/// without running.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Host {
    Headless,
    Remote,
    Blocked,
    Late,
    Test,
}

type Quit = Rc<Cell<Option<Instant>>>;

/// A widget that arms a timer the first time it paints. A noisy one paints each cell in its own color, about 20
/// bytes a cell.
struct Arming {
    app: App,
    arm: Arm,
    noisy: bool,
    armed: Cell<bool>,
    quit: Quit,
    /// The widget itself, for [`Arm::Tick`], and its spinner.
    widget: RefCell<Option<AnyWidget>>,
    spinner: RefCell<Option<AnimationTick>>,
}

/// Arms a 20 ms timer that quits and records when.
fn arm_quit(app: &App, quit: &Quit) {
    let quit = quit.clone();
    app.set_timeout(Duration::from_millis(20), move |cx| {
        quit.set(Some(Instant::now()));
        cx.quit();
    });
}

impl Component for Arming {
    fn paint(&self, painter: &mut Painter<'_>) {
        let quit = self.quit.clone();
        match self.arm {
            _ if self.armed.replace(true) => {}
            Arm::Paint => arm_quit(&self.app, &quit),
            Arm::Defer => self.app.defer(move |cx| arm_quit(cx.app(), &quit)),
            Arm::Animate => self.app.defer(move |cx| {
                cx.animate(move |cx, _| {
                    arm_quit(cx.app(), &quit);
                    false
                })
            }),
            Arm::Quit => self.app.defer(|cx| cx.quit()),
            Arm::Tick => {
                let (widget, quit, mut ticks) = (self.widget.take().expect("the widget"), self.quit.clone(), 0);
                *self.spinner.borrow_mut() = Some(widget.on_animation_tick(50.0, move |cx, tick| {
                    ticks += tick.ticks;
                    if ticks >= 3 {
                        quit.set(Some(Instant::now()));
                        cx.quit();
                    }
                    cx.request_redraw();
                }));
            }
            Arm::Timer | Arm::Hover => {}
        }
        let cells = if self.noisy { 0..200 * 60 } else { 0..0 };
        for (x, y) in cells.map(|cell| (cell % 200, cell / 200)) {
            painter.fill(x, y, 1, 1, Color::rgb(x as u8, (y * 4) as u8, ((x * 7 + y * 13) % 251) as u8));
        }
    }
}

#[test]
fn timers_armed_while_painting_fire_on_time() {
    // Runs an app whose only wakeup after its first frame is the timer `arm` sets up, with an unrelated 60 s timer
    // pending, and returns when the timer quit (for `Quit`, when the run ended). A timer or quit the loop misses waits
    // for the next unrelated wakeup: the watchdog, or a remote terminal's 5 s capability window closing.
    let late = |&(arm, host): &(Arm, Host)| {
        let run = move |terminal: Option<RemoteTerminal>| {
            let app = match terminal {
                Some(terminal) => App::remote(terminal, AppOptions::default().with_theme(Theme::dark())).unwrap(),
                None => headless(10, 1),
            };
            watchdog(&app);
            app.set_timeout(Duration::from_secs(60), |_| {});
            let quit = Quit::default();
            if let Arm::Timer = arm {
                let quit = quit.clone();
                app.set_timeout(Duration::ZERO, move |cx| arm_quit(cx.app(), &quit));
            }
            let noisy = matches!(host, Host::Blocked | Host::Late);
            let (armed, spinner, quit_at) = (Cell::new(false), RefCell::new(None), quit.clone());
            let arming =
                Arming { app: app.clone(), arm, noisy, armed, quit: quit_at, widget: RefCell::new(None), spinner };
            let widget = Custom::new(&app, arming);
            if let Arm::Tick = arm {
                widget.with(|arming| *arming.widget.borrow_mut() = Some(widget.as_any()));
            }
            if let Arm::Hover = arm {
                // At 30 ms the pointer moves to the corner and the widget grows under it. That frame's output finishes
                // when the client reads it, and only then does the hover reach the widget.
                let quit = quit.clone();
                app.root().add(&widget.clone().height(0).on_hover(move |cx, entered| {
                    let quit = quit.clone();
                    if entered {
                        cx.animate(move |cx, _| {
                            arm_quit(cx.app(), &quit);
                            false
                        });
                    }
                }));
                app.set_timeout(Duration::from_millis(30), move |cx| {
                    let event = MouseEvent { kind: MouseEventKind::Moved, x: 0, y: 0, modifiers: Modifiers::NONE };
                    cx.app().dispatch(Event::Mouse(event));
                    widget.height(60);
                });
            } else {
                app.root().add(&widget.grow(1.0));
            }
            // The result is not checked: a blocked terminal times out restoring itself after the quit.
            let _ = app.run();
            if let Arm::Quit = arm {
                quit.set(Some(Instant::now()));
            }
            quit.get()
        };
        let started = Instant::now();
        let quit = if host == Host::Headless {
            run(None)
        } else {
            let options = RemoteOptions { width: 200, height: 60, ..RemoteOptions::default() };
            let (terminal, link) = RemoteTerminal::new(options, || {}).expect("a remote terminal");
            // Output already waiting leaves no room for a noisy frame, or room for the first frame but not a noisy one.
            let waiting = match host {
                Host::Blocked => OUTPUT_BYTES_MAX - 16 * 1024,
                Host::Late => OUTPUT_BYTES_MAX - 128 * 1024,
                _ => 0,
            };
            terminal.write(&vec![b' '; waiting], Duration::ZERO).expect("fill the output");
            if host == Host::Late {
                let link = link.clone();
                // Twice: what the first take makes room for comes after it.
                std::thread::spawn(move || {
                    for delay in [300, 50] {
                        std::thread::sleep(Duration::from_millis(delay));
                        while !link.take_output(1 << 20).is_empty() {}
                    }
                });
            }
            std::thread::spawn(move || run(Some(terminal))).join().expect("the app thread")
        };
        quit.is_none_or(|quit| quit - started > Duration::from_secs(2))
    };
    let rows = [Host::Headless, Host::Remote]
        .into_iter()
        .flat_map(|host| {
            [Arm::Paint, Arm::Defer, Arm::Animate, Arm::Timer, Arm::Quit, Arm::Tick].map(|arm| (arm, host))
        })
        .chain([(Arm::Defer, Host::Blocked), (Arm::Hover, Host::Late)]);
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

/// Calls the app as it drops, as a value that queued work owns may at teardown: defers a task that owns `inner`,
/// starts a timer and a tick, adds and removes a key handler, adds a message handler, cancels, posts a task that posts
/// as it drops, spawns a task whose completion owns the app, and quits.
struct Reenters {
    app: App,
    inner: Option<Box<Reenters>>,
    cancel: Option<Box<dyn FnOnce()>>,
    drops: Rc<Cell<u32>>,
    ran: Rc<Cell<bool>>,
}

/// Posts as it drops.
struct Posts(AppProxy);

impl Drop for Posts {
    fn drop(&mut self) {
        let _ = self.0.post(|_| {});
    }
}

impl Drop for Reenters {
    fn drop(&mut self) {
        self.drops.set(self.drops.get() + 1);
        let (app, inner, ran) = (&self.app, self.inner.take(), self.ran.clone());
        app.defer(move |_| {
            drop(inner);
            ran.set(true);
        });
        app.set_timeout(Duration::ZERO, |_| {});
        drop(app.on_animation_tick(60.0, |_, _| {}));
        let key = app.on_key(|_, _| {});
        app.remove_handler(key);
        app.on_message(|_, _: &u8| {});
        if let Some(cancel) = self.cancel.take() {
            cancel();
        }
        let posts = Posts(app.proxy());
        let _ = app.proxy().post(move |_| drop(posts));
        #[cfg(feature = "tokio")]
        app.spawn(std::future::pending::<()>(), {
            let (app, ran) = (app.clone(), self.ran.clone());
            move |_, ()| drop((app, ran))
        });
        app.quit();
    }
}

/// What owns a [`Reenters`] when the app ends: a task deferred before any frame, a pending timer, a key or message
/// handler, or a pending task's completion handler that cancels another task.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Holder {
    Defer,
    Timer,
    Key,
    Message,
    #[cfg(feature = "tokio")]
    Task,
}

/// Ends an app on `host` whose `holder` owns a [`Reenters`] before any frame. Returns how many `Reenters` dropped,
/// whether a task deferred at teardown ran, and how many owners its flag has left with the app still alive.
fn tear_down(host: Host, holder: Holder) -> (u32, bool, usize) {
    let (drops, ran) = (Rc::new(Cell::new(0)), Rc::new(Cell::new(false)));
    let reenters = |app: &App, cancel: Option<Box<dyn FnOnce()>>| {
        let (drops, ran) = (drops.clone(), ran.clone());
        let inner = Reenters { app: app.clone(), inner: None, cancel: None, drops: drops.clone(), ran: ran.clone() };
        Reenters { app: app.clone(), inner: Some(Box::new(inner)), cancel, drops, ran }
    };
    let hold = |app: &App| match holder {
        Holder::Defer => {
            let reenters = reenters(app, None);
            app.defer(move |_| drop(reenters));
        }
        Holder::Timer => {
            let reenters = reenters(app, None);
            app.set_timeout(Duration::from_secs(60), move |_| drop(reenters));
        }
        Holder::Key => {
            let reenters = reenters(app, None);
            app.on_key(move |_, _| _ = &reenters);
        }
        Holder::Message => {
            let reenters = reenters(app, None);
            app.on_message(move |_, _: &u8| _ = &reenters);
        }
        #[cfg(feature = "tokio")]
        Holder::Task => {
            let other = app.spawn(std::future::pending::<()>(), |_, ()| {});
            let reenters = reenters(app, Some(Box::new(move || other.abort())));
            app.spawn(std::future::pending::<()>(), move |_, ()| drop(reenters));
        }
    };
    let (app, _link) = match host {
        Host::Test => {
            let app = TestApp::new(4, 1);
            hold(app.app());
            drop(app);
            return (drops.get(), ran.get(), Rc::strong_count(&ran));
        }
        Host::Remote => {
            let (terminal, link) = RemoteTerminal::new(RemoteOptions::default(), || {}).expect("a remote terminal");
            (App::remote(terminal, AppOptions::default().with_theme(Theme::dark())).expect("remote app"), Some(link))
        }
        _ => (headless(4, 1), None),
    };
    watchdog(&app);
    hold(&app);
    app.set_timeout(Duration::ZERO, |cx| cx.quit());
    app.clone().run().expect("run");
    (drops.get(), ran.get(), Rc::strong_count(&ran))
}

#[test]
fn work_queued_at_teardown_may_call_the_app_as_it_drops() {
    // Work still queued when an app ends before a frame drops at teardown, and what it owns may call the app as it
    // drops. Nothing panics or hangs, everything drops, and nothing deferred meanwhile runs.
    let holders = [Holder::Defer, Holder::Timer, Holder::Key, Holder::Message];
    #[cfg(feature = "tokio")]
    let holders = [holders.as_slice(), &[Holder::Task]].concat();
    let rows = [Host::Test, Host::Headless, Host::Remote].into_iter().flat_map(|host| {
        // A running app runs deferred tasks before it quits.
        holders.iter().filter(move |&&holder| host == Host::Test || holder != Holder::Defer).map(move |&h| (host, h))
    });
    let wrong: Vec<_> = rows
        .filter(|&(host, holder)| {
            let (sender, receiver) = mpsc::channel();
            std::thread::spawn(move || sender.send(tear_down(host, holder)).expect("the test waits"));
            receiver.recv_timeout(Duration::from_secs(10)) != Ok((2, false, 1))
        })
        .collect();
    assert!(wrong.is_empty(), "{wrong:?}");
}
