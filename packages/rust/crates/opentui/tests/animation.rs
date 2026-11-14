//! Timelines, tweens, and easing, driven by the manual clock. Expected values come from OpenTUI Core's
//! `Timeline.test.ts` where a case is ported from it.

use opentui::animation::Interpolate;
use opentui::prelude::*;
use opentui::testing::TestApp;
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Duration;

fn ms(millis: u64) -> Duration {
    Duration::from_millis(millis)
}

/// Advances the clock and paints a frame, which advances playing timelines.
fn step(app: &TestApp, millis: u64) {
    app.advance(ms(millis));
    app.present().expect("frame");
}

/// A value for tweens to write; NaN until the first update.
fn probe() -> Rc<Cell<f64>> {
    Rc::new(Cell::new(f64::NAN))
}

fn tween_into(value: &Rc<Cell<f64>>, from: f64, to: f64, duration: u64) -> Tween {
    let value = value.clone();
    Tween::new(from, to).duration(ms(duration)).on_update(move |_cx, current| value.set(current))
}

fn counter() -> (Rc<Cell<u32>>, impl FnMut(&mut Cx<'_>) + 'static) {
    let count = Rc::new(Cell::new(0));
    let handler = {
        let count = count.clone();
        move |_cx: &mut Cx<'_>| count.set(count.get() + 1)
    };
    (count, handler)
}

#[test]
fn easings_match_core() {
    // Sampled from Core at 0.25, 0.5, and 0.75 of a 1000 ms tween from 0 to 1.
    let table = [
        (Easing::Linear, [0.25, 0.5, 0.75]),
        (Easing::InQuad, [0.0625, 0.25, 0.5625]),
        (Easing::OutQuad, [0.4375, 0.75, 0.9375]),
        (Easing::InOutQuad, [0.125, 0.5, 0.875]),
        (Easing::InExpo, [0.005524271728019903, 0.03125, 0.1767766952966369]),
        (Easing::OutExpo, [0.8232233047033631, 0.96875, 0.99447572827198]),
        (Easing::InOutSine, [0.1464466094067262, 0.49999999999999994, 0.8535533905932737]),
        (Easing::InBounce, [0.02734375, 0.234375, 0.52734375]),
        (Easing::OutBounce, [0.47265625, 0.765625, 0.97265625]),
        (Easing::OutElastic, [0.9116116523516816, 1.015625, 1.00552427172802]),
        (Easing::InCirc, [0.031754163448145745, 0.1339745962155614, 0.3385621722338523]),
        (Easing::OutCirc, [0.6614378277661477, 0.8660254037844386, 0.9682458365518543]),
        (Easing::InOutCirc, [0.0669872981077807, 0.5, 0.9330127018922193]),
        (Easing::InBack, [-0.06413656250000001, -0.08769750000000004, 0.1825903124999999]),
        (Easing::OutBack, [0.8174096875000001, 1.0876975, 1.0641365625]),
        (Easing::InOutBack, [-0.09968184375, 0.5, 1.09968184375]),
    ];
    assert_eq!(table.map(|(easing, _)| easing), Easing::ALL);
    for (easing, expected) in table {
        for (t, expected) in [0.25, 0.5, 0.75].into_iter().zip(expected) {
            let actual = easing.apply(t);
            assert!((actual - expected).abs() < 1e-12, "{easing:?} at {t}: {actual} != {expected}");
        }
        // Exact ends, which Core's back easings miss by a rounding error, and clamped input.
        assert_eq!((easing.apply(0.0), easing.apply(1.0)), (0.0, 1.0), "{easing:?}");
        assert_eq!((easing.apply(-1.0), easing.apply(2.0), easing.apply(f64::NAN)), (0.0, 1.0, 0.0), "{easing:?}");
    }

    let app = TestApp::new(10, 1);
    let value = probe();
    Timeline::new(&app).add(Duration::ZERO, tween_into(&value, 0.0, 100.0, 1000).ease(Easing::OutBack));
    step(&app, 500);
    assert!((value.get() - 108.76975).abs() < 1e-9);
}

#[test]
fn tweens_follow_the_app_clock_and_frames_stop_at_the_end() {
    let app = TestApp::new(10, 1);
    let value = probe();
    let (updates, mut count_update) = counter();
    let (completions, on_complete) = counter();
    let (timeline_completions, on_timeline_complete) = counter();
    let timeline = Timeline::new(&app)
        .add(
            Duration::ZERO,
            Tween::new(0.0, 100.0).duration(ms(1000)).on_complete(on_complete).on_update({
                let value = value.clone();
                move |cx, current| {
                    value.set(current);
                    count_update(cx);
                }
            }),
        )
        .on_complete(on_timeline_complete);
    assert!(timeline.is_playing() && app.needs_frame());
    step(&app, 0);
    assert_eq!(value.get(), 0.0);
    step(&app, 500);
    assert_eq!(value.get(), 50.0);
    assert_eq!(timeline.current_time(), ms(500));
    // Timelines advance only with frames.
    app.advance(ms(250));
    assert_eq!(value.get(), 50.0);
    app.present().unwrap();
    assert_eq!(value.get(), 75.0);
    step(&app, 400);
    assert_eq!(value.get(), 100.0);
    assert_eq!((updates.get(), completions.get(), timeline_completions.get()), (4, 1, 1));
    assert!(timeline.is_complete() && !timeline.is_playing());
    assert_eq!(timeline.current_time(), ms(1000));
    assert!(!app.needs_frame());
    step(&app, 500);
    assert_eq!((updates.get(), completions.get(), timeline_completions.get()), (4, 1, 1));
}

#[test]
fn positions_delay_tweens_and_callbacks() {
    let app = TestApp::new(10, 1);
    let value = probe();
    let started = Rc::new(Cell::new(false));
    let calls = Rc::new(RefCell::new(Vec::new()));
    let timeline = Timeline::new(&app).add(
        ms(200),
        tween_into(&value, 0.0, 100.0, 500).on_start({
            let started = started.clone();
            move |_cx| started.set(true)
        }),
    );
    for at in [0, 1000, 1500] {
        let calls = calls.clone();
        timeline.call(ms(at), move |_cx| calls.borrow_mut().push(at));
    }
    step(&app, 100);
    assert!(!started.get() && value.get().is_nan());
    assert_eq!(*calls.borrow(), [0]);
    step(&app, 150);
    assert!(started.get());
    assert_eq!(value.get(), 10.0);
    step(&app, 750);
    assert_eq!(value.get(), 100.0);
    assert_eq!(*calls.borrow(), [0, 1000]);
    assert!(timeline.is_playing(), "the timeline runs until its last item, the call at 1500 ms");
    step(&app, 500);
    assert_eq!(*calls.borrow(), [0, 1000, 1500]);
    assert!(timeline.is_complete());
}

#[test]
fn an_explicit_duration_cuts_off_longer_items() {
    let app = TestApp::new(10, 1);
    let value = probe();
    let timeline = Timeline::new(&app).duration(ms(800)).add(Duration::ZERO, tween_into(&value, 0.0, 100.0, 1000));
    step(&app, 800);
    assert!(timeline.is_complete());
    assert_eq!(value.get(), 80.0);
}

#[test]
fn tweens_loop_with_delays_and_alternate() {
    let app = TestApp::new(10, 1);
    let value = probe();
    let (loops, on_loop) = counter();
    let (completions, on_complete) = counter();
    Timeline::new(&app).add(
        Duration::ZERO,
        tween_into(&value, 0.0, 100.0, 1000)
            .loops(3)
            .alternate(true)
            .loop_delay(ms(400))
            .on_loop(on_loop)
            .on_complete(on_complete),
    );
    step(&app, 1000);
    assert_eq!((value.get(), loops.get()), (100.0, 0));
    step(&app, 400);
    assert_eq!((value.get(), loops.get()), (100.0, 1), "the delay holds the end value");
    step(&app, 50);
    assert_eq!(value.get(), 95.0, "the second run goes back");
    step(&app, 950);
    assert_eq!(value.get(), 0.0);
    step(&app, 425);
    assert_eq!((value.get(), loops.get()), (2.5, 2));
    step(&app, 975);
    assert_eq!((value.get(), loops.get(), completions.get()), (100.0, 2, 1));

    // An even number of alternating runs ends back at the start.
    Timeline::new(&app).add(Duration::ZERO, tween_into(&value, 0.0, 100.0, 100).loops(2).alternate(true));
    step(&app, 0);
    step(&app, 150);
    assert_eq!(value.get(), 50.0);
    step(&app, 50);
    assert_eq!(value.get(), 0.0);
    assert!(!app.needs_frame());
}

#[test]
fn the_last_run_completes_without_waiting_out_its_delay() {
    // Core keeps the last run going through its loop delay, calling update handlers after completion, and it
    // completes later when the tween has no completion handler.
    for with_handler in [false, true] {
        let app = TestApp::new(10, 1);
        let updates = Rc::new(RefCell::new(Vec::new()));
        let completed_at = Rc::new(Cell::new(None));
        let timeline = Timeline::new(&app).duration(ms(5000));
        let mut tween = Tween::new(0.0, 100.0).duration(ms(100)).loops(2).loop_delay(ms(100)).on_update({
            let (updates, timeline) = (updates.clone(), timeline.clone());
            move |_cx, value| updates.borrow_mut().push((timeline.current_time().as_millis(), value))
        });
        if with_handler {
            tween = tween.on_complete({
                let (completed_at, timeline) = (completed_at.clone(), timeline.clone());
                move |_cx| completed_at.set(Some(timeline.current_time().as_millis()))
            });
        }
        timeline.add(Duration::ZERO, tween);
        for _ in 0..8 {
            step(&app, 50);
        }
        assert_eq!(
            *updates.borrow(),
            [(50, 50.0), (100, 100.0), (150, 100.0), (200, 100.0), (250, 50.0), (300, 100.0)],
            "with a completion handler: {with_handler}"
        );
        assert_eq!(completed_at.get(), with_handler.then_some(300));
    }
}

#[test]
fn zero_duration_tweens_jump_to_the_end_once() {
    let app = TestApp::new(10, 1);
    let value = probe();
    let (updates, mut count) = counter();
    Timeline::new(&app).duration(ms(1000)).add(
        ms(50),
        Tween::new(0.0, 100.0).duration(Duration::ZERO).loops(3).on_update({
            let value = value.clone();
            move |cx, current| {
                value.set(current);
                count(cx);
            }
        }),
    );
    step(&app, 66);
    assert_eq!((value.get(), updates.get()), (100.0, 1));
    step(&app, 100);
    assert_eq!(updates.get(), 1);
}

#[test]
fn pause_play_and_restart() {
    let app = TestApp::new(10, 1);
    let value = probe();
    let (pauses, on_pause) = counter();
    let timeline = Timeline::new(&app)
        .autoplay(false)
        .on_pause(on_pause)
        .add(Duration::ZERO, tween_into(&value, 0.0, 100.0, 1000));
    assert!(!timeline.is_playing());
    step(&app, 500);
    assert!(value.get().is_nan());
    assert!(!app.needs_frame(), "a paused timeline requests no frames");
    assert_eq!(pauses.get(), 0, "autoplay(false) is not a pause");

    timeline.play();
    assert!(app.needs_frame());
    step(&app, 0);
    step(&app, 250);
    assert_eq!(value.get(), 25.0);
    timeline.pause();
    timeline.pause();
    assert_eq!(pauses.get(), 1, "only a playing timeline pauses");
    step(&app, 250);
    assert_eq!(value.get(), 25.0);
    step(&app, 250);
    assert!(!app.needs_frame());

    timeline.play();
    step(&app, 0);
    step(&app, 250);
    assert_eq!(value.get(), 50.0);
    timeline.restart();
    step(&app, 250);
    assert_eq!(value.get(), 25.0);
    step(&app, 750);
    assert!(timeline.is_complete());
    assert_eq!(value.get(), 100.0);
    // Playing a finished timeline starts it over.
    timeline.play();
    step(&app, 0);
    step(&app, 500);
    assert_eq!(value.get(), 50.0);
    assert_eq!(pauses.get(), 1);
}

#[test]
fn looping_timelines_run_their_items_again() {
    // Core's "should execute callbacks at position 0 again when timeline loops".
    let app = TestApp::new(10, 1);
    let value = Rc::new(Cell::new(0.0));
    let (calls, mut count) = counter();
    let timeline = Timeline::new(&app)
        .duration(ms(1000))
        .looping(true)
        .call(Duration::ZERO, {
            let value = value.clone();
            move |cx| {
                count(cx);
                value.set(0.0);
            }
        })
        .add(ms(200), tween_into(&value, 0.0, 100.0, 500));
    step(&app, 0);
    assert_eq!((calls.get(), value.get()), (1, 0.0));
    step(&app, 200);
    step(&app, 250);
    assert_eq!(value.get(), 50.0);
    step(&app, 575);
    assert_eq!(timeline.current_time(), ms(25));
    assert_eq!((calls.get(), value.get()), (2, 0.0));
    step(&app, 175);
    assert_eq!(value.get(), 0.0);
    step(&app, 250);
    assert_eq!(value.get(), 50.0);
    assert!(timeline.is_playing() && !timeline.is_complete());
}

#[test]
fn once_tweens_start_now_and_do_not_repeat() {
    let app = TestApp::new(10, 1);
    let value = probe();
    let (starts, on_start) = counter();
    let timeline = Timeline::new(&app).duration(ms(1000)).looping(true);
    step(&app, 0);
    step(&app, 200);
    timeline.once(tween_into(&value, 0.0, 100.0, 300).on_start(on_start));
    step(&app, 150);
    assert_eq!(value.get(), 50.0);
    step(&app, 150);
    assert_eq!((value.get(), starts.get()), (100.0, 1));
    step(&app, 500);
    assert_eq!(timeline.current_time(), Duration::ZERO);
    step(&app, 400);
    assert_eq!((value.get(), starts.get()), (100.0, 1));
}

#[test]
fn empty_timelines_wait_for_items() {
    let app = TestApp::new(10, 1);
    let value = probe();
    let effects = Timeline::new(&app);
    step(&app, 100);
    assert!(effects.is_playing() && !effects.is_complete());
    assert!(!app.needs_frame(), "an empty timeline requests no frames");
    for _ in 0..2 {
        effects.once(tween_into(&value, 0.0, 100.0, 100));
        assert!(app.needs_frame());
        step(&app, 0);
        step(&app, 50);
        assert_eq!(value.get(), 50.0);
        step(&app, 50);
        assert_eq!(value.get(), 100.0);
        assert!(effects.is_playing() && !effects.is_complete());
        step(&app, 50);
        assert!(!app.needs_frame());
    }
    // A timeline with a duration and nothing on it is a delay.
    let (completions, on_complete) = counter();
    Timeline::new(&app).duration(ms(100)).on_complete(on_complete);
    step(&app, 0);
    step(&app, 100);
    assert_eq!(completions.get(), 1);
}

#[test]
fn seeking_delivers_values_without_events() {
    let app = TestApp::new(10, 1);
    let value = probe();
    let (starts, on_start) = counter();
    let (completions, on_complete) = counter();
    let (calls, call) = counter();
    let (timeline_completions, on_timeline_complete) = counter();
    let timeline = Timeline::new(&app)
        .autoplay(false)
        .call(ms(100), call)
        .add(ms(200), tween_into(&value, 0.0, 100.0, 400).on_start(on_start).on_complete(on_complete))
        .on_complete(on_timeline_complete);
    step(&app, 0);
    timeline.seek(ms(400));
    assert_eq!(value.get(), 50.0);
    assert_eq!(timeline.current_time(), ms(400));
    assert!(!timeline.is_playing(), "seeking keeps a paused timeline paused");
    assert!(!app.needs_frame());
    timeline.seek(ms(1000));
    assert_eq!(value.get(), 100.0);
    assert!(timeline.is_complete());
    assert_eq!((starts.get(), completions.get(), calls.get(), timeline_completions.get()), (0, 0, 0, 0));

    // Seeking back and playing runs the passed items' events from there.
    timeline.seek(ms(250)).play();
    assert!(!timeline.is_complete());
    assert_eq!(value.get(), 12.5);
    step(&app, 0);
    step(&app, 350);
    assert_eq!(value.get(), 100.0);
    assert_eq!((starts.get(), completions.get(), calls.get(), timeline_completions.get()), (0, 1, 0, 1));
}

#[test]
fn synced_timelines_follow_their_parent() {
    // Core's "should pause sub-timelines when main timeline is paused".
    let app = TestApp::new(10, 1);
    let (main_value, sub_value) = (probe(), probe());
    let main = Timeline::new(&app).duration(ms(3000)).add(Duration::ZERO, tween_into(&main_value, 0.0, 100.0, 2000));
    let sub = Timeline::new(&app).add(Duration::ZERO, tween_into(&sub_value, 0.0, 50.0, 800));
    main.sync(ms(500), &sub);
    assert!(!sub.is_playing(), "a synced timeline waits for its parent");
    step(&app, 0);
    step(&app, 250);
    assert_eq!(main_value.get(), 12.5);
    assert!(sub_value.get().is_nan() && !sub.is_playing());
    step(&app, 500);
    assert_eq!((main_value.get(), sub_value.get()), (37.5, 15.625));
    assert!(sub.is_playing());
    main.pause();
    assert!(!sub.is_playing());
    step(&app, 400);
    assert_eq!((main_value.get(), sub_value.get()), (37.5, 15.625));
    main.play();
    assert!(sub.is_playing());
    step(&app, 0);
    step(&app, 200);
    assert_eq!((main_value.get(), sub_value.get()), (47.5, 28.125));
    assert!(!sub.is_complete());
    step(&app, 500);
    assert!(sub.is_complete() && main.is_playing());
    step(&app, 2000);
    assert!(main.is_complete());
    assert!(!app.needs_frame());
}

#[test]
fn looping_parents_restart_their_children() {
    // Core's "should restart completed sub-timelines when main timeline loops".
    let app = TestApp::new(10, 1);
    let value = probe();
    let (completions, on_complete) = counter();
    let main = Timeline::new(&app).duration(ms(1000)).looping(true);
    let sub = Timeline::new(&app).add(Duration::ZERO, tween_into(&value, 0.0, 100.0, 300).on_complete(on_complete));
    main.sync(ms(200), &sub);
    step(&app, 0);
    step(&app, 200);
    assert_eq!(value.get(), 0.0);
    step(&app, 150);
    assert_eq!(value.get(), 50.0);
    step(&app, 150);
    assert_eq!((value.get(), completions.get()), (100.0, 1));
    assert!(sub.is_complete());
    step(&app, 500);
    assert_eq!(main.current_time(), Duration::ZERO);
    assert!(!sub.is_playing() && !sub.is_complete());
    step(&app, 200);
    assert!(sub.is_playing());
    step(&app, 150);
    assert_eq!(value.get(), 50.0);
    step(&app, 150);
    assert_eq!((value.get(), completions.get()), (100.0, 2));
}

#[test]
fn paused_parents_do_not_start_children() {
    // Core starts a synced child when the paused parent's time plus the frame's delta reaches it.
    let app = TestApp::new(10, 1);
    let value = probe();
    let main = Timeline::new(&app).autoplay(false);
    let sub = Timeline::new(&app).add(Duration::ZERO, tween_into(&value, 0.0, 100.0, 1000));
    main.sync(Duration::ZERO, &sub);
    step(&app, 250);
    assert!(value.get().is_nan() && !sub.is_playing());
    main.play();
    step(&app, 0);
    step(&app, 250);
    assert_eq!(value.get(), 25.0);
    main.pause();
    let late = Timeline::new(&app).add(Duration::ZERO, tween_into(&value, 0.0, 1.0, 100));
    main.sync(ms(300), &late);
    step(&app, 500);
    assert_eq!(value.get(), 25.0);
    assert!(!late.is_playing());
}

#[test]
fn sync_rejects_cycles_and_moves_children() {
    let app = TestApp::new(10, 1);
    let value = probe();
    let (a, b) = (Timeline::new(&app), Timeline::new(&app));
    a.sync(Duration::ZERO, &a);
    a.sync(Duration::ZERO, &b);
    b.sync(Duration::ZERO, &a);
    assert!(a.is_playing() && !b.is_playing(), "a contains b, so b cannot contain a");
    let child = Timeline::new(&app).add(Duration::ZERO, tween_into(&value, 0.0, 100.0, 100));
    a.sync(Duration::ZERO, &child);
    b.sync(ms(50), &child);
    step(&app, 0);
    step(&app, 100);
    assert_eq!(value.get(), 50.0, "the child runs only in b, from 50 ms");
    step(&app, 100);
    assert!(child.is_complete() && b.is_complete() && a.is_complete());
}

#[test]
fn timelines_without_a_duration_end_with_their_last_item() {
    let app = TestApp::new(10, 1);
    let value = probe();
    let child = Timeline::new(&app).add(ms(100), tween_into(&value, 0.0, 1.0, 200));
    let timeline = Timeline::new(&app)
        .add(Duration::ZERO, tween_into(&value, 0.0, 1.0, 100).loops(2).loop_delay(ms(50)))
        .sync(ms(100), &child);
    step(&app, 0);
    step(&app, 399);
    assert!(timeline.is_playing());
    step(&app, 1);
    assert!(timeline.is_complete());
    assert_eq!(timeline.current_time(), ms(400));

    let forever = Timeline::new(&app).add(Duration::ZERO, Tween::new(0.0, 1.0).duration(ms(10)).forever());
    step(&app, 0);
    step(&app, 10_000);
    assert!(forever.is_playing() && app.needs_frame());
}

#[test]
fn values_of_other_types_and_lazy_starts() {
    let app = TestApp::new(10, 1);
    let colors = Rc::new(RefCell::new(Vec::new()));
    let level = Slider::new(&app).range(0.0, 100.0).set_value(40.0);
    let small = Rc::new(Cell::new(0.0f32));
    Timeline::new(&app)
        .add(
            Duration::ZERO,
            Tween::new(Color::WHITE, Color::hex(0x000000)).duration(ms(100)).on_update({
                let colors = colors.clone();
                move |_cx, color| colors.borrow_mut().push(color)
            }),
        )
        .add(
            Duration::ZERO,
            Tween::new(1.0f32, 2.0).duration(ms(100)).on_update({
                let small = small.clone();
                move |_cx, value| small.set(value)
            }),
        )
        .add(
            ms(50),
            Tween::from_current(
                {
                    let level = level.clone();
                    move || level.value()
                },
                100.0,
            )
            .duration(ms(50))
            .on_update({
                let level = level.clone();
                move |_cx, value| {
                    level.set_value(value);
                }
            }),
        );
    level.set_value(60.0);
    step(&app, 0);
    step(&app, 50);
    assert_eq!(small.get(), 1.5);
    assert_eq!(level.value(), 60.0, "the start is read when the tween starts");
    step(&app, 25);
    assert_eq!(level.value(), 80.0);
    step(&app, 25);
    assert_eq!(level.value(), 100.0);
    let colors = colors.borrow();
    assert_eq!(colors[0], Color::WHITE, "the start keeps its palette intent");
    assert_eq!(colors[1], Color::rgb(96, 96, 96));
    assert_eq!(*colors.last().unwrap(), Color::hex(0x000000));
    assert_eq!(Color::rgb(0, 0, 0).interpolate(&Color::rgb(255, 255, 255), 1.5), Color::rgb(255, 255, 255));
}

#[test]
fn handlers_may_restart_or_seek_their_own_timeline() {
    let app = TestApp::new(10, 1);
    let value = probe();
    let (completions, on_complete) = counter();
    let passes = Rc::new(Cell::new(0));
    let timeline = Timeline::new(&app).on_complete(on_complete);
    timeline.add(
        Duration::ZERO,
        tween_into(&value, 0.0, 100.0, 100).on_complete({
            let (timeline, passes) = (timeline.clone(), passes.clone());
            move |_cx| {
                passes.set(passes.get() + 1);
                if passes.get() < 3 {
                    timeline.restart();
                }
            }
        }),
    );
    for _ in 0..4 {
        step(&app, 100);
    }
    // Each restart skips the timeline's completion, which the same frame had reached.
    assert_eq!((passes.get(), completions.get()), (3, 1));
    assert!(timeline.is_complete());

    let values = Rc::new(RefCell::new(Vec::new()));
    let timeline = Timeline::new(&app);
    timeline.add(
        Duration::ZERO,
        Tween::new(0.0, 100.0).duration(ms(100)).on_update({
            let (timeline, values) = (timeline.clone(), values.clone());
            move |_cx, value| {
                values.borrow_mut().push(value);
                if value == 50.0 {
                    timeline.seek(ms(80));
                }
            }
        }),
    );
    step(&app, 0);
    step(&app, 50);
    // The seek's update reaches the handler while it runs, so it is skipped.
    assert_eq!(*values.borrow(), [0.0, 50.0]);
    assert_eq!(timeline.current_time(), ms(80));
    assert!(timeline.is_playing());
    step(&app, 20);
    assert_eq!(*values.borrow(), [0.0, 50.0, 100.0]);
    assert!(timeline.is_complete());
}

#[test]
fn finished_timelines_release_their_handlers() {
    let app = TestApp::new(10, 1);
    let text = Text::new(&app, "hi");
    app.root().add(&text);
    let marker = Rc::new(());
    {
        let marker = marker.clone();
        let text = text.clone();
        Timeline::new(&app).add(
            Duration::ZERO,
            Tween::new(0.0, 1.0).duration(ms(100)).on_update(move |_cx, value| {
                let _ = &marker;
                text.opacity(value as f32);
            }),
        );
    }
    step(&app, 50);
    assert_eq!(Rc::strong_count(&marker), 2, "a playing timeline keeps itself alive");
    step(&app, 50);
    assert_eq!(Rc::strong_count(&marker), 1);
    assert!(!app.needs_frame());
}

#[test]
fn teardown_releases_timelines_that_capture_themselves() {
    let marker = Rc::new(());
    {
        let app = TestApp::new(10, 1);
        let paused = Timeline::new(&app).autoplay(false);
        let playing = Timeline::new(&app).looping(true);
        for timeline in [&paused, &playing] {
            let (marker, itself) = (marker.clone(), timeline.clone());
            timeline
                .on_complete(move |_cx| {
                    let _ = (&marker, &itself);
                })
                .add(
                    Duration::ZERO,
                    Tween::new(0.0, 1.0).duration(ms(100)).on_update({
                        let itself = timeline.clone();
                        move |_cx, _value| {
                            let _ = &itself;
                        }
                    }),
                );
        }
        paused.sync(
            ms(10),
            &Timeline::new(&app).call(Duration::ZERO, {
                let paused = paused.clone();
                move |_cx| {
                    let _ = &paused;
                }
            }),
        );
        step(&app, 50);
        assert_eq!(Rc::strong_count(&marker), 3);
    }
    assert_eq!(Rc::strong_count(&marker), 1);
}

// The shared animation clock. Frame rows and the seeded bound come from Core's vectors, which
// `renderer.scheduling.test.ts` runs too.

fn tick_vectors() -> serde_json::Value {
    serde_json::from_str(include_str!("../../../../core/src/tests/animation-tick.conformance.json")).unwrap()
}

fn numbers(value: &serde_json::Value) -> Vec<f64> {
    value.as_array().unwrap().iter().map(|number| number.as_f64().unwrap()).collect()
}

/// Frames and ticks per second after the first second, and each subscriber's gaps between ticks in ms.
struct Animated {
    frames: f64,
    ticks: Vec<f64>,
    gaps: Vec<Vec<f64>>,
}

/// Core's `animate`: subscribers at `rates` mounted at `offsets` (ms), each requesting a frame in its tick, plus
/// redraws at the `content` times, on an idle loop stepped 1 ms at a time at up to 60 frames per second.
fn animate(rates: &[f64], offsets: &[f64], live: bool, content: &[u64], seconds: u64) -> Animated {
    let app = TestApp::with_options(4, 1, AppOptions { max_fps: 60, ..Default::default() });
    let start = app.now();
    let counts = Rc::new(RefCell::new(vec![(0, Vec::new(), None); rates.len()]));
    let mut handles = Vec::new();
    let mut frames = 0;
    for millis in 0..(1 + seconds) * 1000 {
        for (index, &fps) in rates.iter().enumerate() {
            if offsets[index] as u64 != millis {
                continue;
            }
            let counts = counts.clone();
            handles.push(app.on_animation_tick(fps, move |cx, tick| {
                let time = (cx.now() - start).as_secs_f64() * 1000.0;
                if time <= 1000.0 {
                    return;
                }
                let (ticks, gaps, last) = &mut counts.borrow_mut()[index];
                *ticks += tick.ticks;
                if let Some(last) = *last {
                    gaps.push(time - last);
                }
                *last = Some(time);
                cx.request_redraw();
            }));
        }
        if live && millis == 0 {
            app.animate(|_cx, _elapsed| true);
        }
        if content.contains(&millis) {
            app.request_redraw();
        }
        let idle = app.idle(ms(1));
        if millis >= 1000 {
            frames += idle.frames;
        }
    }
    let per_second = |count: u64| count as f64 / seconds as f64;
    let counts = counts.take();
    Animated {
        frames: per_second(frames),
        ticks: counts.iter().map(|(ticks, _, _)| per_second(*ticks)).collect(),
        gaps: counts.into_iter().map(|(_, gaps, _)| gaps).collect(),
    }
}

#[test]
fn animation_ticks_share_frames_as_in_core() {
    let (vectors, mut seen, mut expected) = (tick_vectors(), Vec::new(), Vec::new());
    for row in vectors["frames"].as_array().unwrap() {
        let (name, options) = (row[0].as_str().unwrap(), &row[3]);
        // Rust has no tolerance option, and its timers fire on time.
        if options.get("tolerance").is_some() {
            continue;
        }
        let run = animate(&numbers(&row[1]), &numbers(&row[2]), options.get("live").is_some(), &[], 5);
        seen.push((name, run.frames, run.ticks));
        let (frames, ticks) = options.get("rust").map_or((&row[4], &row[5]), |rust| (&rust[0], &rust[1]));
        expected.push((name, frames.as_f64().unwrap(), numbers(ticks)));
    }
    assert_eq!(seen, expected);
}

#[test]
fn animation_frames_never_exceed_the_fastest_rate_plus_content() {
    let bound = &tick_vectors()["bound"];
    let mut seed = bound["seed"].as_u64().unwrap();
    // Core's Park-Miller generator, so both suites draw the same trials.
    let mut random = move || {
        seed = seed * 48271 % 2147483647;
        (seed - 1) as f64 / 2147483646.0
    };
    let mut below = move |count: usize| (random() * count as f64).floor() as usize;
    let (bases, divisors, mixed) = (numbers(&bound["bases"]), numbers(&bound["divisors"]), numbers(&bound["mixed"]));
    let seconds = bound["seconds"].as_u64().unwrap();
    for trial in 0..bound["trials"].as_u64().unwrap() {
        let base = bases[below(bases.len())];
        let count = 1 + below(3);
        let rates: Vec<f64> = (0..count)
            .map(|_| match trial % 3 {
                2 => mixed[below(mixed.len())],
                _ => base / divisors[below(divisors.len())],
            })
            .collect();
        let offsets: Vec<f64> = rates.iter().map(|_| below(200) as f64).collect();
        let length = below(40);
        let mut content: Vec<u64> = (0..length).map(|_| 1000 + below(2000) as u64).collect();
        content.sort_unstable();
        let alone = animate(&[], &[], false, &content, seconds);
        let run = animate(&rates, &offsets, false, &content, seconds);
        let context = format!("trial {trial}, rates {rates:?}, offsets {offsets:?}, frames {}", run.frames);
        let fastest = rates.iter().copied().fold(0.0, f64::max);
        assert!(run.frames <= fastest.min(60.0) + alone.frames, "{context}, alone {}", alone.frames);
        for (index, &fps) in rates.iter().enumerate() {
            // A tick runs on the first frame from half an interval before its due time; the fastest rate's frames
            // come at least every 1000 / fastest ms, a 60 fps gap later at worst.
            let slack = (1000.0 / fps).min(1000.0 / fastest) + 1000.0 / 60.0 + 1.0;
            assert!((run.ticks[index] - fps).abs() <= 1.0, "{context}, ticks {:?}", run.ticks);
            for gap in &run.gaps[index] {
                assert!((gap - 1000.0 / fps).abs() <= slack, "{context}, subscriber {index}, gap {gap}");
            }
        }
    }
}

/// Frames, wakeups, and ticks in one idle second.
fn idle_second(app: &TestApp, ticks: &Cell<u64>) -> (u64, u64, u64) {
    let before = ticks.get();
    let idle = app.idle(ms(1000));
    (idle.frames, idle.wakeups, ticks.get() - before)
}

/// A tick callback that counts its ticks and redraws, as a spinner does.
fn spinner(ticks: &Rc<Cell<u64>>) -> impl FnMut(&mut Cx<'_>, Tick) + 'static {
    let ticks = ticks.clone();
    move |cx, tick| {
        ticks.set(ticks.get() + tick.ticks);
        cx.request_redraw();
    }
}

#[test]
fn widget_ticks_run_while_the_widget_is_drawn() {
    let app = TestApp::with_options(4, 2, AppOptions { max_fps: 60, ..Default::default() });
    let view = View::new(&app).width(1).height(1);
    app.root().add(&view);
    app.idle(ms(1000));
    let ticks = Rc::new(Cell::new(0));
    let mut rows = vec![("nothing animates", idle_second(&app, &ticks))];
    let handle = view.on_animation_tick(12.5, spinner(&ticks));
    rows.push(("drawn", idle_second(&app, &ticks)));
    view.visible(false);
    rows.push(("hidden", idle_second(&app, &ticks)));
    rows.push(("still hidden", idle_second(&app, &ticks)));
    view.visible(true);
    rows.push(("shown again", idle_second(&app, &ticks)));
    view.detach();
    rows.push(("detached, handle kept", idle_second(&app, &ticks)));
    app.root().add(&view);
    rows.push(("added again", idle_second(&app, &ticks)));
    drop(handle);
    rows.push(("handle dropped", idle_second(&app, &ticks)));
    let text = Text::new(&app, "-");
    app.root().add(&text);
    let kept = text.on_animation_tick(12.5, spinner(&ticks));
    rows.push(("another widget", idle_second(&app, &ticks)));
    text.detach();
    drop(text);
    rows.push(("that widget dropped, handle kept", idle_second(&app, &ticks)));
    assert_eq!(
        rows,
        [
            ("nothing animates", (0, 0, 0)),
            // The first frame is the one that registers the widget's update hook.
            ("drawn", (13, 12, 12)),
            // The hiding frame is within the next tick's window and runs it; the tick after that parks: one wakeup, and
            // its frame.
            ("hidden", (2, 1, 1)),
            ("still hidden", (0, 0, 0)),
            ("shown again", (13, 12, 12)),
            // The detaching frame waits for the frame cap (a wakeup); the next due time parks (another).
            ("detached, handle kept", (2, 2, 0)),
            ("added again", (13, 12, 12)),
            ("handle dropped", (0, 0, 0)),
            ("another widget", (13, 12, 12)),
            ("that widget dropped, handle kept", (1, 1, 0)),
        ]
    );
    drop(kept);
}

#[test]
fn ticks_may_subscribe_and_end_animations_inside_a_tick() {
    // Four subscribers due in the same frames, in this order: `a`, `b`, `d`, and `e`, bound to a drawn widget. The
    // first tick of `a` subscribes `c`, ends `b` and itself, and detaches the widget. The callback of `b` owns `d`'s
    // handle, and that of `a` the widget's last handle: both drop with their callbacks, before `d` and `e` are due.
    // Only `c` ticks after that.
    let app = TestApp::with_options(4, 2, AppOptions { max_fps: 60, ..Default::default() });
    let calls = Rc::new(RefCell::new(Vec::new()));
    let log = |name: &'static str| {
        let calls = calls.clone();
        move |cx: &mut Cx<'_>, _tick: Tick| {
            calls.borrow_mut().push(name);
            cx.request_redraw();
        }
    };
    let widget = View::new(&app).width(1).height(1);
    app.root().add(&widget);
    let (handles, owned) = (Rc::new(RefCell::new(Vec::new())), Rc::new(RefCell::new(None)));
    let a = app.on_animation_tick(20.0, {
        let (handles, owned, log_a, mut log_c) = (handles.clone(), owned.clone(), log("a"), Some(log("c")));
        move |cx, tick| {
            log_a(cx, tick);
            if let Some(widget) = &*owned.borrow() {
                Widget::detach(widget);
            }
            let ended: Vec<AnimationTick> = handles.borrow_mut().drain(..).collect();
            handles.borrow_mut().extend(log_c.take().map(|log_c| cx.on_animation_tick(20.0, log_c)));
            drop(ended);
        }
    });
    let owns_d = Rc::new(RefCell::new(None));
    let b = app.on_animation_tick(20.0, {
        let (owns_d, log_b) = (owns_d.clone(), log("b"));
        move |cx, tick| {
            let _ = &owns_d;
            log_b(cx, tick);
        }
    });
    *owns_d.borrow_mut() = Some(app.on_animation_tick(20.0, log("d")));
    let _e = widget.on_animation_tick(20.0, log("e"));
    handles.borrow_mut().extend([a, b]);
    *owned.borrow_mut() = Some(widget);
    drop((owned, owns_d));
    let idle = app.idle(ms(1000));
    let calls = calls.take();
    assert_eq!(calls.first(), Some(&"a"));
    assert!(calls[1..].iter().all(|&name| name == "c"), "{calls:?}");
    assert_eq!((calls.len(), idle.frames), (20, 21));
    handles.borrow_mut().clear();
    assert_eq!(app.idle(ms(1000)), opentui::testing::Idle::default());
}

#[test]
fn a_cancelled_timer_may_drop_an_animated_widget() {
    // The timer's callback owns the widget's last handle; cancelling it ends the widget's ticks.
    let app = TestApp::with_options(4, 2, AppOptions { max_fps: 60, ..Default::default() });
    let widget = View::new(&app).width(1).height(1);
    app.root().add(&widget);
    let ticks = Rc::new(Cell::new(0));
    let _handle = widget.on_animation_tick(20.0, spinner(&ticks));
    app.idle(ms(1000));
    widget.detach();
    let timer = app.set_timeout(ms(10_000), move |_cx| drop(widget));
    assert!(app.cancel_timer(timer));
    // The detaching frame waits for the frame cap; no tick is due after it.
    assert_eq!([idle_second(&app, &ticks), idle_second(&app, &ticks)], [(1, 1, 0), (0, 0, 0)]);
    // A timer still pending when the app ends drops another such widget, and its handle, at teardown.
    let other = View::new(&app);
    let handle = other.on_animation_tick(20.0, spinner(&ticks));
    app.set_timeout(ms(10_000), move |_cx| drop((other, handle)));
    // And another a value that cancels a timer when it drops, as a playing video does.
    struct CancelsOnDrop(App, TimerId);
    impl Drop for CancelsOnDrop {
        fn drop(&mut self) {
            self.0.cancel_timer(self.1);
        }
    }
    let cancels = CancelsOnDrop(app.app().clone(), app.set_timeout(ms(10_000), |_cx| {}));
    app.set_timeout(ms(10_000), move |_cx| drop(cancels));
}

/// Starts a spinner on itself the first time it paints.
struct PaintSpinner {
    widget: RefCell<Option<AnyWidget>>,
    ticks: Rc<Cell<u64>>,
    handle: RefCell<Option<AnimationTick>>,
}

impl Component for PaintSpinner {
    fn paint(&self, _painter: &mut Painter<'_>) {
        if let Some(widget) = self.widget.take() {
            *self.handle.borrow_mut() = Some(widget.on_animation_tick(12.5, spinner(&self.ticks)));
        }
    }
}

#[test]
fn a_spinner_started_while_painting_ticks_from_its_first_due_time() {
    let app = TestApp::with_options(4, 2, AppOptions { max_fps: 60, ..Default::default() });
    let ticks = Rc::new(Cell::new(0));
    let component = PaintSpinner { widget: RefCell::default(), ticks: ticks.clone(), handle: RefCell::default() };
    let custom = Custom::new(&app, component).width(1).height(1);
    custom.with(|component| *component.widget.borrow_mut() = Some(custom.as_any()));
    app.root().add(&custom);
    // The painting frame counts as drawing it, so its first due tick runs instead of parking.
    assert_eq!(idle_second(&app, &ticks), (13, 12, 12));
}

#[test]
fn a_late_frame_covers_the_due_times_it_missed() {
    // Core's row: a subscriber at 12.5 fps from 50 ms first ticks at 160 ms. A late frame at 360 ms covers 160, 240
    // and 320 ms, and 400 ms, which is within reach; the next tick, at 480 ms, is ordinary.
    let app = TestApp::new(1, 1);
    let ticks = Rc::new(RefCell::new(Vec::new()));
    app.advance(ms(50));
    let handle = app.on_animation_tick(12.5, {
        let ticks = ticks.clone();
        move |_cx, tick| ticks.borrow_mut().push(tick)
    });
    app.present().expect("frame");
    app.advance(ms(310));
    app.present().expect("frame");
    app.idle(ms(120));
    drop(handle);
    assert_eq!(*ticks.borrow(), [Tick { elapsed: ms(310), ticks: 4 }, Tick { elapsed: ms(120), ticks: 1 }]);
    for fps in [0.0, -1.0, f64::NAN, f64::INFINITY] {
        let subscribed =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| app.on_animation_tick(fps, |_, _| {})));
        assert!(subscribed.is_err(), "{fps}");
    }
}
