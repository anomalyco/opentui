use crate::{Auth, Error, ErrorReport, HostKey};
use std::sync::Arc;
use std::time::Duration;

/// Called with what the server reports: a handler that fails or panics, a check that panics, a connection that
/// fails, or [open access](Error::OpenAccess) beyond the loopback interface.
pub type ErrorHandler = Arc<dyn Fn(&ErrorReport<'_>) + Send + Sync>;

/// How [`serve`](crate::serve) runs.
///
/// Start from [`Self::new`] and change what you need with the setters, named after the fields:
///
/// ```
/// use opentui_ssh::{Auth, HostKey, ServerConfig};
/// use std::time::Duration;
///
/// let config = ServerConfig::new()
///     .auth(Auth::empty().any_public_key())
///     .host_key(HostKey::File("host_key".into()))
///     .idle_timeout(Duration::from_secs(600));
/// ```
#[derive(Clone)]
#[non_exhaustive]
pub struct ServerConfig {
    /// How clients authenticate. [`Auth::open`] by default.
    pub auth: Auth,
    /// The server's host keys. [`HostKey::Ephemeral`] by default.
    pub host_key: HostKey,
    /// Ends a session after this long without client input: the app restores the client's terminal, and the
    /// session's channel closes, which ends an OpenSSH client. Off by default.
    pub idle_timeout: Option<Duration>,
    /// Ends a session after this long, however active. Off by default.
    pub max_timeout: Option<Duration>,
    /// The most [`Server::close`](crate::Server::close) waits before it drops every connection. It trades how long a
    /// shutdown may take against slow clients losing their terminal's restoration. `None`, the default, waits as
    /// long as the apps need: each app's [close bound](opentui::host::HostOptions::close_bound) to restore its
    /// client's terminal, as long again for the client to take that output, and as long once more for the client to
    /// leave. With a client that stopped reading, that is about half a minute at the default close timeout. A
    /// shorter time ends a shutdown sooner, but a client on a slow link may then keep the alternate screen and mouse
    /// reporting.
    pub close_timeout: Option<Duration>,
    /// Sessions one connection may run at once; more are refused. 1 by default, as in Core.
    pub sessions_per_connection: usize,
    /// Sessions the server runs at once; more are refused. 100 by default, as in Core. Each session's app has a
    /// thread of its own until its handler returns.
    pub max_sessions: usize,
    /// Prints the address, host key fingerprints, and authentication methods to stdout once listening. On by
    /// default.
    pub banner: bool,
    /// Called with every error the server contains, and with the [`Error::OpenAccess`] warning. Prints each report
    /// to stderr by default. It runs in [`serve`](crate::serve) or on a network or session thread, and should
    /// return quickly.
    pub on_error: ErrorHandler,
}

impl std::fmt::Debug for ServerConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ServerConfig")
            .field("auth", &self.auth)
            .field("host_key", &self.host_key)
            .field("idle_timeout", &self.idle_timeout)
            .field("max_timeout", &self.max_timeout)
            .field("close_timeout", &self.close_timeout)
            .field("sessions_per_connection", &self.sessions_per_connection)
            .field("max_sessions", &self.max_sessions)
            .field("banner", &self.banner)
            .finish_non_exhaustive()
    }
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            auth: Auth::open(),
            host_key: HostKey::Ephemeral,
            idle_timeout: None,
            max_timeout: None,
            close_timeout: None,
            sessions_per_connection: 1,
            max_sessions: 100,
            banner: true,
            on_error: Arc::new(|report| eprintln!("opentui-ssh: {report}")),
        }
    }
}

impl ServerConfig {
    /// The defaults, as [`Self::default`] gives them.
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets [how clients authenticate](field@Self::auth).
    pub fn auth(mut self, auth: Auth) -> Self {
        self.auth = auth;
        self
    }

    /// Sets [where the host keys come from](field@Self::host_key).
    pub fn host_key(mut self, host_key: HostKey) -> Self {
        self.host_key = host_key;
        self
    }

    /// Sets [the idle timeout](field@Self::idle_timeout); `None` turns it off.
    pub fn idle_timeout(mut self, timeout: impl Into<Option<Duration>>) -> Self {
        self.idle_timeout = timeout.into();
        self
    }

    /// Sets [the maximum timeout](field@Self::max_timeout); `None` turns it off.
    pub fn max_timeout(mut self, timeout: impl Into<Option<Duration>>) -> Self {
        self.max_timeout = timeout.into();
        self
    }

    /// Sets [the most a server close waits](field@Self::close_timeout); `None` waits as long as the apps need.
    pub fn close_timeout(mut self, timeout: impl Into<Option<Duration>>) -> Self {
        self.close_timeout = timeout.into();
        self
    }

    /// Sets [how many sessions one connection may run](field@Self::sessions_per_connection) at once.
    pub fn sessions_per_connection(mut self, sessions: usize) -> Self {
        self.sessions_per_connection = sessions;
        self
    }

    /// Sets [how many sessions the server runs](field@Self::max_sessions) at once.
    pub fn max_sessions(mut self, sessions: usize) -> Self {
        self.max_sessions = sessions;
        self
    }

    /// Sets [whether to print a banner](field@Self::banner) once listening.
    pub fn banner(mut self, banner: bool) -> Self {
        self.banner = banner;
        self
    }

    /// Sets [what to call](field@Self::on_error) with every error the server contains.
    pub fn on_error(mut self, on_error: impl Fn(&ErrorReport<'_>) + Send + Sync + 'static) -> Self {
        self.on_error = Arc::new(on_error);
        self
    }

    pub(crate) fn check(&self) -> Result<(), Error> {
        if self.auth.methods().is_empty() {
            return Err(Error::Config("auth has no methods: use Auth::open, or add one to Auth::empty".into()));
        }
        if self.sessions_per_connection == 0 || self.max_sessions == 0 {
            return Err(Error::Config("session limits must be at least 1".into()));
        }
        let timeouts = [self.idle_timeout, self.max_timeout, self.close_timeout];
        if timeouts.into_iter().flatten().any(|timeout| timeout.is_zero()) {
            return Err(Error::Config("timeouts must be longer than zero".into()));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn the_setters_set_every_field() {
        assert_eq!(format!("{:?}", ServerConfig::new()), format!("{:?}", ServerConfig::default()));
        let reports = Arc::new(AtomicUsize::new(0));
        let config = ServerConfig::new()
            .auth(Auth::empty().password(|_, _| true))
            .host_key(HostKey::File("host_key".into()))
            .idle_timeout(Duration::from_secs(1))
            .max_timeout(Duration::from_secs(2))
            .close_timeout(Duration::from_secs(3))
            .sessions_per_connection(3)
            .max_sessions(4)
            .banner(false)
            .on_error({
                let reports = Arc::clone(&reports);
                move |_| {
                    reports.fetch_add(1, Ordering::SeqCst);
                }
            });
        assert_eq!(config.auth.method_names(), ["password"]);
        assert!(matches!(&config.host_key, HostKey::File(path) if path.as_os_str() == "host_key"));
        assert_eq!(
            (config.idle_timeout, config.max_timeout, config.close_timeout),
            (Some(Duration::from_secs(1)), Some(Duration::from_secs(2)), Some(Duration::from_secs(3)))
        );
        assert_eq!((config.sessions_per_connection, config.max_sessions, config.banner), (3, 4, false));
        (config.on_error)(&ErrorReport { error: &Error::Panic("boom".into()), peer: None, user: None });
        assert_eq!(reports.load(Ordering::SeqCst), 1);
        let config = config.idle_timeout(None).max_timeout(None);
        assert_eq!((config.idle_timeout, config.max_timeout), (None, None));
    }
}
