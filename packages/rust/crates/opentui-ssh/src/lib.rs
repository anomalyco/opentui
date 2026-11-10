//! Serve [`opentui`] apps over SSH, one app per session, as OpenTUI Core's `@opentui/ssh` does.
//!
//! [`serve`] listens for SSH connections. Each shell session gets a thread of its own, where your handler creates
//! the session's [`App`](opentui::App) with [`Session::app`] and runs it. The app's input, output, and window size
//! come from the SSH channel through a [remote terminal](opentui::remote): it never touches the server's own
//! terminal, and a failure or panic in one session ends only that session.
//!
//! ```no_run
//! use opentui::prelude::*;
//! use opentui_ssh::{HostKey, ServerConfig};
//!
//! fn main() -> Result<(), opentui_ssh::Error> {
//!     let config = ServerConfig::new().host_key(HostKey::File("host_key".into()));
//!     let server = opentui_ssh::serve("127.0.0.1:2222", config, |session| {
//!         let app = session.app(AppOptions::default())?;
//!         let greeting = format!("Hello, {}! Press Ctrl+C to leave.", session.user());
//!         app.root().add(&Text::new(&app, greeting));
//!         app.run()
//!     })?;
//!     server.close_on_ctrl_c()
//! }
//! ```
//!
//! Then connect with `ssh -p 2222 localhost`.
//!
//! # Sessions
//!
//! The handler is a plain function on its own thread, so the code before [`App::run`](opentui::App::run) is the
//! session's setup and the code after it is its teardown. To refuse a session, return [`Session::deny`], which shows
//! the client a reason instead of an app. `App::run` returns when the app quits, the client disconnects, an
//! [idle or maximum timeout](field@ServerConfig::idle_timeout) passes, or the server closes; in all but a disconnect,
//! the app first restores the client's terminal.
//!
//! The app picks its light or dark theme from the client's terminal colors, as a local app does, and native code
//! learns the client's terminal from the `TERM` its SSH client sends, plus `COLORTERM`, `OPENTUI_FORCE_TRUECOLOR`,
//! `TERM_PROGRAM`, and `TERM_PROGRAM_VERSION` when the client sends them. A remote app never suspends on Ctrl+Z, never uses the
//! server's system clipboard, and copies to the client's clipboard through its terminal.
//!
//! # Differences from Core
//!
//! - There is no middleware chain; the handler's own code does setup, gating, and teardown.
//! - [`Auth`] offers open access, public keys, and passwords. Keyboard-interactive authentication is not supported.
//! - Like Core, only shell sessions run: `exec` and subsystem requests are refused.

mod auth;
mod config;
mod error;
mod keys;
mod server;
mod session;

pub use auth::Auth;
pub use config::{ErrorHandler, ServerConfig};
pub use error::{Error, ErrorReport, SshError};
pub use keys::{ClientKey, HostKey};
pub use server::{Server, serve};
pub use session::{Identity, Session};
