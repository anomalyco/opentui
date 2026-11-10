//! A task list: a title, a bordered list you move through and toggle, and a status line.
//!
//! Run with `sh run.sh tasks`. j/k or the arrows move, Space toggles, a adds a task, q quits.

use opentui::prelude::*;
use std::cell::RefCell;
use std::rc::Rc;

const TASKS: [&str; 4] = [
    "Create a native scene",
    "Render styled text and borders",
    "Handle keyboard input in Rust",
    "Restore the terminal on exit",
];

struct Tasks {
    names: Vec<String>,
    done: Vec<bool>,
}

impl Tasks {
    fn rows(&self) -> Vec<String> {
        self.names
            .iter()
            .zip(&self.done)
            .map(|(name, done)| format!("[{}] {name}", if *done { "x" } else { " " }))
            .collect()
    }

    fn status(&self) -> String {
        let completed = self.done.iter().filter(|done| **done).count();
        format!(" {completed}/{} complete", self.names.len())
    }
}

/// Builds the UI and returns the list, for tests.
fn build(app: &App) -> Select {
    let theme = app.theme();
    let tasks = Rc::new(RefCell::new(Tasks {
        names: TASKS.iter().map(|name| name.to_string()).collect(),
        done: vec![false; TASKS.len()],
    }));
    let title = Text::new(app, " OpenTUI / Rust").fg(theme.accent).bold();
    let list = Select::new(app).options(tasks.borrow().rows()).show_description(false).grow(1.0);
    let panel = View::new(app).border(BorderStyle::Single).highlight_focus().grow(1.0).child(&list);
    let status = Text::new(app, tasks.borrow().status()).fg(theme.accent);
    let help = Text::new(app, " j/k: move  Space: toggle  a: add  q: quit").fg(theme.muted);
    app.root().add(&title).add(&panel).add(&status).add(&help);

    // Space reaches the list's own handler first; Select ignores it, so this handler decides.
    list.on_key({
        let list = list.clone();
        move |cx, key| {
            let mut tasks = tasks.borrow_mut();
            if key.matches("space") {
                let index = list.selected();
                tasks.done[index] = !tasks.done[index];
                list.options(tasks.rows());
            } else if key.matches("a") {
                let name = format!("Task {}", tasks.names.len() + 1);
                tasks.names.push(name);
                tasks.done.push(false);
                list.options(tasks.rows()).select(tasks.names.len() - 1);
            } else {
                return;
            }
            status.set_text(tasks.status());
            cx.stop_propagation();
        }
    });
    app.on_key(|cx, key| {
        if key.matches("q") {
            cx.quit();
        }
    });
    list.focus();
    list
}

fn main() -> opentui::Result<()> {
    let app = App::new(AppOptions::default())?;
    build(&app);
    app.run()
}

#[cfg(test)]
mod tests {
    use super::*;
    use opentui::testing::TestApp;

    #[test]
    fn task_keys_move_toggle_and_add() {
        let app = TestApp::new(44, 9);
        let list = build(&app);
        for (key, selected) in [("up", 0), ("down", 1), ("j", 2), ("k", 1)] {
            app.press(key);
            assert_eq!(list.selected(), selected);
        }
        app.press("space");
        assert_eq!(list.option(1).unwrap().name, "[x] Render styled text and borders");
        app.press("a");
        assert_eq!((list.option_count(), list.selected()), (5, 4));
        app.press("q");
        assert!(app.is_quitting());
    }

    #[test]
    fn the_scene_paints_title_panel_rows_and_status() {
        let app = TestApp::new(44, 9);
        build(&app);
        app.press("j");
        app.press("space");
        let expected = [
            " OpenTUI / Rust",
            "┌──────────────────────────────────────────┐",
            "│   [ ] Create a native scene              │",
            "│ ▶ [x] Render styled text and borders     │",
            "│   [ ] Handle keyboard input in Rust      │",
            "│   [ ] Restore the terminal on exit       │",
            "└──────────────────────────────────────────┘",
            " 1/4 complete",
            " j/k: move  Space: toggle  a: add  q: quit",
        ];
        let capture = app.render();
        assert_eq!(capture.text(), expected.join("\n"));
        // The focused list's panel highlights its border.
        assert_eq!(capture.cell(0, 1).unwrap().fg, app.theme().focus);
    }
}
