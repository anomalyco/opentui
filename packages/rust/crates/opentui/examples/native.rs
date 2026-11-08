//! The native layer without the framework: a scene of raw nodes driven by the terminal host. It reports the last
//! input event and the node under the mouse.
//!
//! Run with `sh run.sh native`. Press q or Ctrl+C to quit and Ctrl+Z to suspend.

use opentui::host::{Host, HostOptions};
use opentui::input::Event;
use opentui::layout::{Align, Edge, Justify, LayoutProperty};
use opentui::native::{BoxDetails, Node, NodeKind, Paint};
use opentui::style::{Alignment, BorderStyle, Color, Sides, Stylize};
use std::time::{Duration, Instant};

const ACCENT: Color = Color::rgb(104, 211, 168);
const MUTED: Color = Color::rgb(132, 151, 164);
const PANEL: u32 = 2;
const LABEL: u32 = 3;

fn main() -> std::process::ExitCode {
    let result = Host::start(HostOptions::default()).and_then(|mut host| {
        let result = run(&mut host);
        let closed = host.shutdown();
        result.and(closed)
    });
    match result {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Error: {error}");
            std::process::ExitCode::FAILURE
        }
    }
}

fn run(host: &mut Host) -> opentui::Result<()> {
    let session = host.session().clone();
    let root = Node::new(&session, NodeKind::Root, 1)?;
    root.set_layout(LayoutProperty::JustifyContent(Justify::Center))?;
    root.set_layout(LayoutProperty::AlignItems(Align::Center))?;

    let panel = Node::new(&session, NodeKind::Box, PANEL)?;
    panel.insert_into(&root, 0)?;
    panel.set_layout(LayoutProperty::Padding(Edge::Horizontal, 2.into()))?;
    panel.set_layout(LayoutProperty::Padding(Edge::Vertical, 1.into()))?;
    panel.set_paint(&Paint {
        border: Sides::ALL,
        border_style: BorderStyle::Rounded,
        border_color: ACCENT,
        ..Default::default()
    })?;
    panel.set_box_details(&BoxDetails {
        title: " OpenTUI from Rust ",
        title_alignment: Alignment::Center,
        bottom_title: " q quit ",
        bottom_title_alignment: Alignment::Right,
        ..Default::default()
    })?;

    let label = Node::new(&session, NodeKind::Text, LABEL)?;
    label.insert_into(&panel, 0)?;

    let mut last_event = String::from("none yet");
    let mut hovered = "nothing";
    let mut dirty = true;
    let mut events = Vec::new();
    loop {
        if dirty && host.can_render()? {
            let (width, height) = host.size();
            label.set_spans(&[
                "Hello from a native scene.\n\n".bold(),
                "last event  ".fg(MUTED),
                last_event.as_str().fg(ACCENT),
                "\nunder mouse ".fg(MUTED),
                hovered.fg(ACCENT),
                format!("\nterminal    {width}x{height}").fg(MUTED),
            ])?;
            host.present(session.paint(Color::TRANSPARENT, true, 0)?)?;
            dirty = false;
        }
        host.poll(dirty.then(|| Instant::now() + Duration::from_millis(2)), &mut events)?;
        let mut suspend = false;
        for event in events.drain(..) {
            match &event {
                Event::Key(key) if key.matches("q") || key.matches("ctrl+c") => return Ok(()),
                Event::Key(key) if key.matches("ctrl+z") => suspend = true,
                Event::Terminate => return Ok(()),
                Event::Mouse(mouse) => {
                    // Hits come from the last presented frame.
                    hovered = match session.hit_test(i32::from(mouse.x), i32::from(mouse.y))? {
                        Some(PANEL) => "the box",
                        Some(LABEL) => "the label",
                        _ => "the background",
                    };
                }
                _ => {}
            }
            last_event = match event {
                Event::Key(key) => format!("{:?} {:?}", key.code, key.modifiers),
                Event::Mouse(mouse) => format!("{:?} at {},{}", mouse.kind, mouse.x, mouse.y),
                Event::Paste(text) => format!("paste of {} bytes", text.len()),
                other => format!("{other:?}"),
            };
            dirty = true;
        }
        if suspend {
            host.suspend(&mut events)?;
        }
    }
}
