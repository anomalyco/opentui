//! Headless frame timings: builds scenes of many widgets, changes them, and times event handling, layout, painting,
//! encoding, and output delivery per frame. No terminal is needed; output goes to memory.
//!
//! Run with `cargo run --release --example bench`.

use opentui::prelude::*;
use opentui::testing::TestApp;
use std::time::{Duration, Instant};

fn time(frames: u32, mut frame: impl FnMut(u32)) -> Duration {
    let start = Instant::now();
    for index in 0..frames {
        frame(index);
    }
    start.elapsed() / frames
}

fn report(name: &str, per_frame: Duration) {
    println!("{name:<48} {:>8.1} µs/frame  {:>7.0} fps", per_frame.as_secs_f64() * 1e6, 1.0 / per_frame.as_secs_f64());
}

fn main() {
    let options = || AppOptions { host: opentui::host::HostOptions::default(), ..Default::default() };

    // A full screen of text that changes every frame.
    let app = TestApp::with_options(200, 60, options());
    let lines: Vec<Text> = (0..60).map(|line| Text::new(&app, format!("line {line}"))).collect();
    for line in &lines {
        app.root().add(line);
    }
    app.render();
    report(
        "200x60, 60 text rows, all change",
        time(300, |frame| {
            for (index, line) in lines.iter().enumerate() {
                line.set_text(format!("frame {frame} line {index} {}", "·".repeat((frame as usize + index) % 120)));
            }
            app.present().unwrap();
        }),
    );
    report(
        "200x60, 60 text rows, one changes",
        time(1000, |frame| {
            lines[frame as usize % 60].set_text(format!("frame {frame}"));
            app.present().unwrap();
        }),
    );
    drop(app);

    // A long scrolled list: viewport culling keeps painting proportional to what is visible.
    let app = TestApp::with_options(120, 40, options());
    let scroll = ScrollBox::new(&app).grow(1.0);
    for row in 0..5000 {
        scroll.add(
            &View::new(&app)
                .row()
                .gap(2)
                .child(&Text::new(&app, format!("{row:>5}")))
                .child(&Text::new(&app, "a row in a long list")),
        );
    }
    app.root().add(&scroll);
    app.render();
    report(
        "ScrollBox with 5000 rows (15000 nodes), scroll",
        time(300, |frame| {
            scroll.scroll_to(0.0, f64::from(frame * 7 % 4900));
            app.present().unwrap();
        }),
    );
    drop(app);

    // Host-painted widgets.
    let app = TestApp::with_options(120, 40, options());
    let list = Select::new(&app)
        .options((0..10_000).map(|index| (format!("Option {index}"), format!("Description {index}"))))
        .grow(1.0);
    app.root().add(&list);
    list.focus();
    app.render();
    report(
        "Select with 10000 options, move selection",
        time(1000, |_| {
            app.press("down");
            app.present().unwrap();
        }),
    );
    drop(app);

    // Typing into a large textarea.
    let app = TestApp::with_options(120, 40, options());
    let area = Textarea::new(&app).grow(1.0);
    let text: String =
        (0..2000).map(|line| format!("line {line} of a large document with some words in it\n")).collect();
    area.set_text(&text);
    app.root().add(&area);
    area.focus();
    app.render();
    report(
        "Textarea with 2000 lines, type a character",
        time(1000, |_| {
            app.type_text("x");
            app.present().unwrap();
        }),
    );
    drop(app);

    // Highlighting: appends between frames cost one highlight of the whole text, at the next frame.
    #[cfg(feature = "tree-sitter")]
    {
        let app = TestApp::with_options(120, 40, options());
        let code = opentui::widget::Code::new(&app).filetype("rust").line_numbers(true).follow(true).grow(1.0);
        code.set_code(include_str!("showcase.rs"));
        app.root().add(&code);
        app.render();
        report(
            "Code with ~500 lines of Rust, append 10 lines",
            time(100, |frame| {
                for line in 0..10 {
                    code.append(&format!("let x{frame}_{line} = \"{line}\";\n"));
                }
                app.present().unwrap();
            }),
        );
        drop(app);

        // A textarea highlights its whole text at the next frame after an edit; cursor moves and idle frames do not
        // highlight.
        for highlighted in [false, true] {
            let app = TestApp::with_options(120, 40, options());
            let area = Textarea::new(&app).filetype(highlighted.then_some("rust")).grow(1.0);
            area.set_text(include_str!("showcase.rs"));
            app.root().add(&area);
            area.focus();
            app.render();
            let name =
                if highlighted { "Textarea, 16 KiB of Rust, highlighted" } else { "Textarea, 16 KiB of Rust, plain" };
            report(
                &format!("{name}, type"),
                time(200, |_| {
                    app.type_text("x");
                    app.present().unwrap();
                }),
            );
            report(
                &format!("{name}, move cursor"),
                time(1000, |frame| {
                    app.press(if frame % 2 == 0 { "left" } else { "right" });
                    app.present().unwrap();
                }),
            );
            report(&format!("{name}, idle"), time(1000, |_| app.present().unwrap()));
        }
    }
}
