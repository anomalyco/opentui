mod support;

use opentui::{ffi, Node, Session};
use std::time::{Duration, Instant};
use support::{size, text, Color, Input, Key, Result, Terminal};

const BACKGROUND: Color = [18, 22, 28, 255];
const FOREGROUND: Color = [219, 226, 234, 255];
const ACCENT: Color = [104, 211, 168, 255];
const TASKS: [&str; 4] = [
    "Create a native scene",
    "Render styled text and borders",
    "Handle keyboard input in Rust",
    "Restore the terminal on exit",
];

struct App<'session, 'context> {
    rows: Vec<Node<'session, 'context>>,
    status: Node<'session, 'context>,
    // Keep every native owner alive, including nodes that do not change after setup.
    _structure: Vec<Node<'session, 'context>>,
    selected: usize,
    done: [bool; TASKS.len()],
}

impl<'session, 'context> App<'session, 'context> {
    fn new(session: &'session Session<'context>) -> Result<Self> {
        let root = Node::new(session, ffi::OT_SCENE_ROOT, 1)?;
        root.set_paint(&ffi::ot_scene_paint_options {
            opacity: 1.0,
            should_fill: 1,
            background: BACKGROUND,
            ..Default::default()
        })?;
        let title = Node::new(session, ffi::OT_SCENE_TEXT, 2)?;
        title.mount_at(&root, 0)?;
        text(&title, " OpenTUI / Rust", ACCENT, true)?;

        let panel = Node::new(session, ffi::OT_SCENE_BOX, 3)?;
        panel.mount_at(&root, 1)?;
        panel.set_style(1, 1, 0, 0, 1.0, 0)?; // Yoga float: flex-grow = 1.
        panel.set_style(2, 3, 0, 1, 0.0, 0)?; // Yoga point value: min-height = 0.
        panel.set_paint(&ffi::ot_scene_paint_options {
            opacity: 1.0,
            border_sides: 15,
            border_color: [67, 83, 99, 255],
            should_fill: 1,
            background: BACKGROUND,
            ..Default::default()
        })?;
        let mut rows = Vec::new();
        for index in 0..TASKS.len() {
            let row = Node::new(session, ffi::OT_SCENE_TEXT, 4 + index as u32)?;
            row.mount_at(&panel, index as u32)?;
            rows.push(row);
        }
        let status = Node::new(session, ffi::OT_SCENE_TEXT, 8)?;
        status.mount_at(&root, 2)?;
        let help = Node::new(session, ffi::OT_SCENE_TEXT, 9)?;
        help.mount_at(&root, 3)?;
        text(&help, " j/k: move  Space: toggle  q: quit", FOREGROUND, false)?;
        // Fixed one-row labels leave the remaining height to the bordered panel.
        for node in [&title, &status, &help].into_iter().chain(rows.iter()) {
            node.set_style(2, 1, 0, 1, 1.0, 0)?; // Yoga point value: height = 1.
            node.set_style(1, 2, 0, 0, 0.0, 0)?; // Yoga float: flex-shrink = 0.
        }
        let app =
            Self { rows, status, _structure: vec![root, title, panel, help], selected: 0, done: [false; TASKS.len()] };
        app.update()?;
        Ok(app)
    }

    fn update(&self) -> Result<()> {
        for (index, row) in self.rows.iter().enumerate() {
            let pointer = if index == self.selected { ">" } else { " " };
            let check = if self.done[index] { "x" } else { " " };
            let color = if index == self.selected { ACCENT } else { FOREGROUND };
            text(row, &format!(" {pointer} [{check}] {}", TASKS[index]), color, index == self.selected)?;
        }
        let completed = self.done.iter().filter(|done| **done).count();
        text(&self.status, &format!(" {completed}/{} complete | native scene + Rust input", TASKS.len()), ACCENT, false)
    }

    fn key(&mut self, key: Key) -> Result<bool> {
        match key {
            Key::Char(b'q') | Key::Interrupt => return Ok(false),
            Key::Char(b'j') | Key::Down => self.selected = (self.selected + 1) % TASKS.len(),
            Key::Char(b'k') | Key::Up => self.selected = (self.selected + TASKS.len() - 1) % TASKS.len(),
            Key::Char(b' ') => self.done[self.selected] = !self.done[self.selected],
            _ => return Ok(true),
        }
        self.update()?;
        Ok(true)
    }
}

fn run(session: &Session<'_>, terminal: &Terminal<'_, '_>) -> Result<()> {
    let mut app = App::new(session)?;
    let renderer = session.renderer_state()?;
    let mut dimensions = (renderer.width, renderer.height);
    let mut input = Input::default();
    let mut bytes = [0; 256];
    let mut dirty = true;
    loop {
        let next_size = size()?;
        if next_size != dimensions {
            session.resize(next_size.0, next_size.1)?;
            dimensions = next_size;
            dirty = true;
        }
        if dirty {
            session.paint(BACKGROUND, false, 0)?;
            if session.render(true)? != ffi::OT_RENDER_PENDING {
                return Err("native renderer did not accept the frame".into());
            }
            terminal.drain()?;
            dirty = false;
        }
        let timeout = input.timeout(Instant::now(), Duration::from_millis(100));
        let Some(count) = terminal.read(&mut bytes, timeout)? else { return Ok(()) };
        let now = Instant::now();
        for key in input.keys(&bytes[..count], now) {
            if !app.key(key)? {
                return Ok(());
            }
            dirty |= matches!(key, Key::Char(b'j' | b'k' | b' ') | Key::Up | Key::Down);
        }
    }
}

fn main() -> std::process::ExitCode {
    support::run(16, run)
}

#[cfg(test)]
mod tests {
    use super::*;
    use opentui::Context;

    #[test]
    fn task_keys_preserve_selection_toggle_and_text() -> Result<()> {
        let context = Context::new(ffi::ot_context_options {
            object_capacity: 16,
            render_cells_max: support::CELLS_MAX,
            ..Default::default()
        })?;
        let session = Session::new(
            &context,
            ffi::ot_session_options {
                chunk_size: ffi::OT_SESSION_CONTROL_PACKET_BYTES,
                span_capacity: 2,
                max_bytes: u64::from(ffi::OT_SESSION_CONTROL_PACKET_BYTES) * 2,
                control_capacity: ffi::OT_SESSION_CONTROL_PACKET_BYTES,
                ..Default::default()
            },
        )?;
        session.attach_renderer(80, 24, ffi::OT_SESSION_REMOTE_LOCAL, &[])?;
        let mut app = App::new(&session)?;
        assert_eq!(app.rows[0].text()?, b" > [ ] Create a native scene");
        for (key, selected) in [(Key::Up, 3), (Key::Down, 0), (Key::Char(b'j'), 1), (Key::Char(b'k'), 0)] {
            assert!(app.key(key)?);
            assert_eq!(app.selected, selected);
            assert!(app.rows[selected].text()?.starts_with(b" > [ ] "));
        }
        assert!(app.key(Key::Char(b' '))?);
        assert_eq!(app.rows[0].text()?, b" > [x] Create a native scene");
        assert_eq!(app.status.text()?, b" 1/4 complete | native scene + Rust input");
        assert!(app.key(Key::Char(b' '))?);
        assert_eq!(app.status.text()?, b" 0/4 complete | native scene + Rust input");
        assert!(app.key(Key::Escape)?);
        assert!(!app.key(Key::Char(b'q'))?);
        assert!(!app.key(Key::Interrupt)?);
        session.paint(BACKGROUND, false, 0)?;
        Ok(())
    }
}
