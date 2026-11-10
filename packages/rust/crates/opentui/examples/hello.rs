//! A centered card that greets you, counts clicks on a button, and reports the last event.
//!
//! Run with `sh run.sh hello`. Press q or Ctrl+C to quit and Ctrl+Z to suspend.

use opentui::prelude::*;

fn main() -> opentui::Result<()> {
    let app = App::new(AppOptions::default())?;
    let theme = app.theme();
    app.root().justify(Justify::Center).align_items(Align::Center);

    let greeting = Text::new(&app, vec!["Hello from ".into(), "Rust".fg(theme.accent).bold(), " and OpenTUI.".into()]);
    let event = Text::new(&app, "Move the mouse or press a key.").fg(theme.muted);
    let button = Text::new(&app, " Click me ")
        .bg(theme.highlight_bg)
        .fg(theme.highlight_fg)
        .mouse_pointer(MousePointer::POINTER);
    let count = Text::new(&app, "No clicks yet.").fg(theme.muted);
    let card = View::new(&app)
        .border(BorderStyle::Rounded)
        .border_color(theme.accent)
        .title(" OpenTUI ")
        .title_alignment(Alignment::Center)
        .bottom_title(" q quit ")
        .bottom_title_alignment(Alignment::Right)
        .padding_x(2)
        .padding_y(1)
        .gap(1)
        .width(46)
        .child(&greeting)
        .child(&View::new(&app).row().gap(2).child(&button).child(&count))
        .child(&event);
    app.root().add(&card);

    let clicks = std::cell::Cell::new(0);
    button.on_click({
        let count = count.clone();
        move |_cx, _event| {
            clicks.set(clicks.get() + 1);
            count.set_text(format!("Clicked {} time{}.", clicks.get(), if clicks.get() == 1 { "" } else { "s" }));
        }
    });
    button.on_hover({
        let button = button.clone();
        move |_cx, hovered| {
            button.bg(if hovered { theme.accent } else { theme.highlight_bg });
        }
    });
    app.on_key({
        let event = event.clone();
        move |cx, key| {
            if key.matches("q") {
                cx.quit();
            }
            event.set_text(format!("Key {:?} {:?}", key.code, key.modifiers));
        }
    });
    app.on_mouse(move |_cx, mouse| {
        event.set_text(format!("Mouse {:?} at {},{}", mouse.kind, mouse.x, mouse.y));
    });
    app.run()
}
