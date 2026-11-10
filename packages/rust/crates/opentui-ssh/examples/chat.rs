//! A chat room over SSH: every session runs its own app, and each message reaches all of them.
//!
//! ```sh
//! cargo run -p opentui-ssh --example chat            # listens on 127.0.0.1:2222
//! cargo run -p opentui-ssh --example chat -- 0.0.0.0:2222
//! ssh -p 2222 localhost                              # once per participant
//! ```
//!
//! Anyone who reaches the port can join under any name, so serve it beyond your own machine only with
//! authentication set in `ServerConfig::auth`. Ctrl+C stops the server and restores every participant's terminal.

use opentui::prelude::*;
use opentui_ssh::{ServerConfig, Session};
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

/// A line every participant's app shows.
#[derive(Clone)]
struct Line {
    text: String,
    notice: bool,
}

/// Asks every app to refresh its status line.
struct Refresh;

/// The participants' apps, reached through their proxies.
#[derive(Clone, Default)]
struct Room {
    members: Arc<Mutex<Vec<(u64, AppProxy)>>>,
    next_id: Arc<AtomicU64>,
}

impl Room {
    fn join(&self, proxy: AppProxy) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.members.lock().unwrap_or_else(PoisonError::into_inner).push((id, proxy));
        id
    }

    fn leave(&self, id: u64) {
        self.members.lock().unwrap_or_else(PoisonError::into_inner).retain(|(member, _)| *member != id);
    }

    fn say(&self, text: String, notice: bool) {
        let line = Line { text, notice };
        for (_, proxy) in self.members.lock().unwrap_or_else(PoisonError::into_inner).iter() {
            let _ = proxy.send(line.clone());
        }
    }

    fn refresh(&self) {
        for (_, proxy) in self.members.lock().unwrap_or_else(PoisonError::into_inner).iter() {
            let _ = proxy.send(Refresh);
        }
    }

    fn count(&self) -> usize {
        self.members.lock().unwrap_or_else(PoisonError::into_inner).len()
    }
}

fn session_status(app: &App, session: &Session, room: &Room) -> String {
    let (width, height) = app.size();
    format!("{} · {width}x{height} · {} here · Esc leaves", session.term(), room.count())
}

fn participate(room: &Room, session: Session) -> opentui::Result<()> {
    let name = match session.user() {
        "" => "guest".to_owned(),
        user => user.to_owned(),
    };
    let app = session.app(AppOptions::default())?;
    let theme = app.theme();
    let log = ScrollBox::new(&app).sticky(true).grow(1.0);
    let status = Text::new(&app, "").fg(theme.muted);
    let input = Input::new(&app).placeholder("Say something and press Enter").height(1);
    app.root().add(
        &View::new(&app)
            .border(BorderStyle::Rounded)
            .title(format!(" opentui-ssh chat · {name} "))
            .padding_x(1)
            .grow(1.0)
            .child(&log),
    );
    app.root().add(&View::new(&app).border(BorderStyle::Rounded).padding_x(1).child(&input));
    app.root().add(&View::new(&app).padding_x(1).child(&status));

    app.on_message({
        let (app, log) = (app.clone(), log.clone());
        move |_cx, line: &Line| {
            let color = if line.notice { theme.muted } else { theme.foreground };
            log.add(&Text::new(&app, &line.text).fg(color));
        }
    });
    input.on_submit({
        let (room, name, input) = (room.clone(), name.clone(), input.clone());
        move |cx, text| {
            if !text.trim().is_empty() {
                room.say(format!("{name}: {}", text.trim()), false);
            }
            let input = input.clone();
            cx.defer(move |_cx| {
                input.set_value("");
            });
        }
    });
    // The status shows the size and head count; refresh it on resizes and as people come and go.
    let refresh = {
        let (status, room, session) = (status.clone(), room.clone(), Rc::new(session));
        move |app: &App| {
            status.set_text(session_status(app, &session, &room));
        }
    };
    app.on_resize({
        let refresh = refresh.clone();
        move |cx, _, _| refresh(cx.app())
    });
    app.on_message({
        let refresh = refresh.clone();
        move |cx, _: &Refresh| refresh(cx.app())
    });
    app.on_key(|cx, key| {
        if key.matches("escape") {
            cx.quit();
        }
    });
    input.focus();

    let id = room.join(app.proxy());
    refresh(&app);
    room.say(format!("{name} joined"), true);
    room.refresh();
    let result = app.run();
    room.leave(id);
    room.say(format!("{name} left"), true);
    room.refresh();
    result
}

fn main() -> Result<(), opentui_ssh::Error> {
    let address = std::env::args().nth(1).unwrap_or_else(|| "127.0.0.1:2222".to_owned());
    let room = Room::default();
    let server = opentui_ssh::serve(address, ServerConfig::new(), move |session| participate(&room, session))?;
    server.close_on_ctrl_c()
}
