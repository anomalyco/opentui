use std::fmt;
use std::net::SocketAddr;

/// What can go wrong serving apps over SSH.
#[derive(Debug)]
#[non_exhaustive]
pub enum Error {
    /// The configuration is invalid.
    Config(String),
    /// Binding, reading, or writing failed.
    Io(std::io::Error),
    /// A host key or public key could not be read, generated, or saved.
    Key {
        /// What failed, such as `could not read host key host_key`.
        message: String,
        /// The I/O error behind it, when reading or writing a file failed.
        source: Option<std::io::Error>,
    },
    /// An SSH connection failed.
    Ssh(SshError),
    /// A session's handler returned an error.
    App(opentui::Error),
    /// A session's handler, or a check from [`Auth`](crate::Auth), panicked.
    Panic(String),
    /// A warning rather than a failure: the server listens on this address, beyond the loopback interface, with
    /// [`Auth::open`](crate::Auth::open), so anyone who reaches it gets a session.
    OpenAccess(SocketAddr),
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Config(message) => write!(formatter, "invalid configuration: {message}"),
            Self::Io(error) => write!(formatter, "I/O failed: {error}"),
            Self::Key { message, source: Some(error) } => write!(formatter, "key failed: {message}: {error}"),
            Self::Key { message, source: None } => write!(formatter, "key failed: {message}"),
            Self::Ssh(error) => write!(formatter, "SSH connection failed: {error}"),
            Self::App(error) => write!(formatter, "session failed: {error}"),
            Self::Panic(message) => write!(formatter, "panicked: {message}"),
            Self::OpenAccess(addr) => write!(
                formatter,
                "listening on {addr} without authentication. Anyone who can reach this port, including through \
                 published container ports, tunnels, or proxies, gets a session. Set ServerConfig::auth to restrict \
                 access."
            ),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Key { source, .. } => source.as_ref().map(|error| error as _),
            Self::Ssh(error) => Some(error),
            Self::App(error) => Some(error),
            Self::Config(_) | Self::Panic(_) | Self::OpenAccess(_) => None,
        }
    }
}

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<opentui::Error> for Error {
    fn from(error: opentui::Error) -> Self {
        Self::App(error)
    }
}

impl Error {
    pub(crate) fn ssh(error: russh::Error) -> Self {
        Self::Ssh(SshError(error))
    }
}

/// Why an SSH connection failed, in [`Error::Ssh`]. Its [`source`](std::error::Error::source) is the SSH library's
/// own error; downcasting it ties your code to the version of russh this crate uses.
#[derive(Debug)]
pub struct SshError(russh::Error);

impl fmt::Display for SshError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.0, formatter)
    }
}

impl std::error::Error for SshError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.0)
    }
}

/// An error the server contained, with the client it concerns when the server knows it. See
/// [`ServerConfig::on_error`](field@crate::ServerConfig::on_error).
///
/// Displays as the error, after the client's address and user name when known. The user name is quoted, so control
/// characters a client sent stay escaped.
#[derive(Clone, Copy, Debug)]
#[non_exhaustive]
pub struct ErrorReport<'a> {
    /// What went wrong.
    pub error: &'a Error,
    /// The client's address, for errors on a connection or session.
    pub peer: Option<SocketAddr>,
    /// The user name the client sent, for errors in a session or in a check from [`Auth`](crate::Auth), and for
    /// connection errors after authentication.
    pub user: Option<&'a str>,
}

impl fmt::Display for ErrorReport<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match (self.peer, self.user) {
            (Some(peer), Some(user)) => write!(formatter, "{peer}, user {user:?}: ")?,
            (Some(peer), None) => write!(formatter, "{peer}: ")?,
            (None, Some(user)) => write!(formatter, "user {user:?}: ")?,
            (None, None) => {}
        }
        write!(formatter, "{}", self.error)
    }
}

/// The message of a panic payload.
pub(crate) fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|message| (*message).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "a non-text panic payload".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::error::Error as _;

    #[test]
    fn ssh_errors_lead_to_the_ssh_librarys_error() {
        let error = Error::ssh(russh::Error::Disconnect);
        let ssh = error.source().expect("Error::Ssh has a source");
        assert!(ssh.is::<SshError>());
        let inner = ssh.source().expect("SshError has a source");
        assert!(matches!(inner.downcast_ref::<russh::Error>(), Some(russh::Error::Disconnect)));
        assert_eq!(ssh.to_string(), inner.to_string());
        assert_eq!(error.to_string(), format!("SSH connection failed: {inner}"));
    }

    #[test]
    fn reports_show_the_client_and_user_they_know() {
        let error = Error::Panic("boom".into());
        let peer = Some(SocketAddr::from(([127, 0, 0, 1], 50000)));
        let shown = |peer, user| ErrorReport { error: &error, peer, user }.to_string();
        assert_eq!(shown(peer, Some("alice")), r#"127.0.0.1:50000, user "alice": panicked: boom"#);
        assert_eq!(shown(peer, None), "127.0.0.1:50000: panicked: boom");
        assert_eq!(shown(None, Some("\x1b[2J")), r#"user "\u{1b}[2J": panicked: boom"#);
        assert_eq!(shown(None, None), "panicked: boom");
    }
}
