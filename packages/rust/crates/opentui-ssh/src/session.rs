use crate::keys::ClientKey;
use opentui::remote::RemoteTerminal;
use opentui::{App, AppOptions};
use std::cell::RefCell;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// Who connected, and how they authenticated.
///
/// The user name is whatever the client sent. Public-key authentication proves the client holds the key, not that
/// the name belongs to it: identify users by [`ClientKey::fingerprint`], or tie names to keys in
/// [`Auth::allow_public_key`](crate::Auth::allow_public_key).
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum Identity {
    /// No authentication, with [`Auth::open`](crate::Auth::open).
    None {
        /// The user name the client sent.
        user: String,
    },
    /// A password that [`Auth::password`](crate::Auth::password)'s check accepted.
    Password {
        /// The user name the client sent.
        user: String,
    },
    /// A public key the server accepted.
    PublicKey {
        /// The user name the client sent.
        user: String,
        /// The key, which the client proved it holds.
        key: ClientKey,
    },
}

impl Identity {
    /// The user name the client sent, whatever the method. See the [type documentation](Self) for what it proves.
    pub fn user(&self) -> &str {
        match self {
            Self::None { user } | Self::Password { user } | Self::PublicKey { user, .. } => user,
        }
    }

    /// The key the client authenticated with, if it used one.
    pub fn key(&self) -> Option<&ClientKey> {
        match self {
            Self::PublicKey { key, .. } => Some(key),
            Self::None { .. } | Self::Password { .. } => None,
        }
    }
}

/// One SSH shell session, handed to the handler on a thread of its own.
///
/// [`Self::app`] creates the session's [`App`] on the client's terminal; run it with [`App::run`], which returns
/// when the app quits, the client disconnects, or the server closes. Code before that is the session's setup and
/// code after it is the teardown.
pub struct Session {
    pub(crate) identity: Identity,
    pub(crate) term: String,
    pub(crate) size: (u16, u16),
    pub(crate) has_pty: bool,
    pub(crate) peer: Option<SocketAddr>,
    pub(crate) environment: Vec<(String, String)>,
    pub(crate) terminal: RefCell<Option<RemoteTerminal>>,
    pub(crate) denied: Arc<AtomicBool>,
}

impl std::fmt::Debug for Session {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Session")
            .field("identity", &self.identity)
            .field("term", &self.term)
            .field("size", &self.size)
            .field("peer", &self.peer)
            .finish_non_exhaustive()
    }
}

impl Session {
    /// Who connected, and how they authenticated.
    pub fn identity(&self) -> &Identity {
        &self.identity
    }

    /// The user name the client sent. See [`Identity`] for what it proves.
    pub fn user(&self) -> &str {
        self.identity.user()
    }

    /// The client's terminal type, such as `xterm-256color`, from its pseudo-terminal request. `xterm-256color` when
    /// the client made no such request or sent an empty or overlong type.
    pub fn term(&self) -> &str {
        &self.term
    }

    /// The client's terminal size in cells when the session started. The app sees later changes as resize events.
    pub fn size(&self) -> (u16, u16) {
        self.size
    }

    /// Whether the client asked for a pseudo-terminal. Without one, as with `ssh -T`, the client's terminal is not in
    /// raw mode, so keys arrive a line at a time and are echoed.
    pub fn has_pty(&self) -> bool {
        self.has_pty
    }

    /// The client's address.
    pub fn peer_addr(&self) -> Option<SocketAddr> {
        self.peer
    }

    /// An environment variable the client sent, as `ssh -o SendEnv` or `SetEnv` do.
    pub fn env(&self, name: &str) -> Option<&str> {
        self.environment.iter().rev().find(|(key, _)| key == name).map(|(_, value)| value.as_str())
    }

    /// Creates the session's app on the client's terminal, as [`App::remote`] does. The app's
    /// [`run`](App::run) returns when the app quits, the client disconnects, or the server closes. Fails once the
    /// terminal is in use by an earlier call, [`Self::deny`], or [`Self::take_terminal`].
    pub fn app(&self, options: AppOptions) -> opentui::Result<App> {
        let terminal = self.take_terminal().ok_or(opentui::Error::Usage("the session's terminal is already in use"))?;
        App::remote(terminal, options)
    }

    /// Writes `reason` to the client's screen and ends the session without an app, with exit status 1. Return it
    /// from the handler: `return session.deny("no entry")`. Fails once the terminal is in use.
    pub fn deny(&self, reason: &str) -> opentui::Result<()> {
        let terminal = self.take_terminal().ok_or(opentui::Error::Usage("the session's terminal is already in use"))?;
        self.denied.store(true, Ordering::SeqCst);
        // The client's terminal is in raw mode, where a line feed alone does not return to the first column.
        let mut message = reason.replace("\r\n", "\n").replace('\n', "\r\n");
        if !message.ends_with('\n') {
            message.push_str("\r\n");
        }
        terminal.write(message.as_bytes(), Duration::from_secs(1))?;
        Ok(())
    }

    /// Takes the client's terminal, for a lower-level [`Host`](opentui::host::Host) instead of an [`App`].
    pub fn take_terminal(&self) -> Option<RemoteTerminal> {
        self.terminal.borrow_mut().take()
    }
}
