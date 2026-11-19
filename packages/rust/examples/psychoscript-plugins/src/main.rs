//! An OpenTUI app whose status bar, panels and commands come from PsychoScript plugins in a directory.
//!
//! `cargo run --release -- [plugins-dir]` (default `plugins/`). Plugin keys are listed in each plugin; the host has
//! `ctrl+r` to reload every plugin's source (state is kept), `` ` `` for the debug console, and `ctrl+q` or `ctrl+c`
//! to quit.

use opentui::prelude::*;
use psychoscript_plugins::{Host, load_dir};
use serde_json::json;
use std::path::PathBuf;
use std::time::Duration;

fn main() -> opentui::Result<()> {
    let dir = PathBuf::from(std::env::args().nth(1).unwrap_or_else(|| "plugins".into()));
    let sources =
        load_dir(&dir).map_err(|e| Error::from(std::io::Error::new(e.kind(), format!("{}: {e}", dir.display()))))?;
    let app = App::new(AppOptions::default().with_title("psychoscript plugins"))?;
    build(&app, sources, dir);
    app.run()
}

/// Mounts the plugins and wires keys, resizes and a one-second tick to them.
fn build(app: &App, sources: Vec<(String, String)>, dir: PathBuf) -> Host {
    let help = " ctrl+r reload · ` console · ctrl+q quit";
    let host = Host::mount(app, sources);
    app.root().add(&Text::new(app, help).fg(app.theme().muted));
    app.on_key({
        let host = host.clone();
        move |cx, key| {
            if key.matches("ctrl+q") || key.matches("ctrl+c") {
                cx.quit();
            } else if key.matches("`") {
                cx.app().console().toggle();
            } else if key.matches("ctrl+r") {
                if let Ok(sources) = load_dir(&dir) {
                    host.reload(&sources);
                }
            } else {
                host.key(key);
            }
        }
    });
    app.on_resize({
        let host = host.clone();
        move |_cx, width, height| host.dispatch(json!({ "type": "resize", "width": width, "height": height }))
    });
    app.set_interval(Duration::from_secs(1), {
        let host = host.clone();
        move |_cx| host.dispatch(json!({ "type": "tick", "now": psychoscript_plugins::now_ms() }))
    });
    let (width, height) = app.size();
    host.dispatch(json!({ "type": "resize", "width": width, "height": height }));
    host
}

#[cfg(test)]
mod tests {
    use super::*;
    use opentui::testing::TestApp;

    fn status(app: &TestApp) -> String {
        app.render().text()
    }

    #[test]
    fn plugins_draw_slots_run_commands_and_survive_throws_and_loops() {
        let app = TestApp::new(100, 20);
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("plugins");
        let host = build(&app, load_dir(&dir).unwrap(), dir);
        let slot = |id: &str, slot: &str| {
            host.slots().into_iter().find(|(p, _)| p == id).and_then(|(_, s)| s.get(slot).cloned())
        };
        // git draws its status, or, when `git status` outlasts the event budget (a cold index), its error.
        let git = || slot("git", "status").is_some() || status(&app).contains("git ⚠");
        assert!(app.wait_until(Duration::from_secs(5), git), "{}", status(&app));
        assert!(app.wait_until(Duration::from_secs(5), || slot("filter", "panel").is_some()));

        // A key binding a plugin registered runs its command: `f` cycles the filter's query.
        let before = slot("filter", "panel");
        app.press("f");
        assert!(app.wait_until(Duration::from_secs(5), || slot("filter", "panel") != before));

        // A plugin that loops forever times out on its own thread; the UI keeps taking keys meanwhile.
        app.press("l");
        let started = std::time::Instant::now();
        app.press("f");
        assert!(started.elapsed() < Duration::from_millis(20));
        assert!(app.wait_until(Duration::from_secs(5), || status(&app).contains("timed out")), "{}", status(&app));

        // A throw shows in the plugin's status and keeps its state: the next event counts on from it.
        app.press("t");
        assert!(app.wait_until(Duration::from_secs(5), || status(&app).contains("boom")), "{}", status(&app));
        app.press("x");
        assert!(app.wait_until(Duration::from_secs(5), || status(&app).contains("bad ok")), "{}", status(&app));

        // Reloading new source keeps the state: the key count goes on in the new format.
        let keys = |app: &TestApp| status(app).lines().find(|l| l.contains("keys")).unwrap_or("").to_string();
        let source = "const n = (state?.keys ?? 0) + (event.type === 'key' ? 1 : 0); \
                      return { state: { ...state, keys: n }, slots: { status: `reloaded ${n}` } }";
        host.reload(&[("keys".into(), source.into())]);
        app.press("y");
        assert!(app.wait_until(Duration::from_secs(5), || keys(&app).contains("reloaded 2")), "{}", status(&app));
    }
}
