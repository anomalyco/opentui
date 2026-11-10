use crate::keys::{self, ClientKey};
use crate::{Error, Identity};
use russh::MethodKind;
use russh::keys::PublicKey;
use std::path::Path;
use std::sync::Arc;

type KeyCheck = dyn Fn(&str, &ClientKey) -> bool + Send + Sync;
type PasswordCheck = dyn Fn(&str, &str) -> bool + Send + Sync;

/// How clients authenticate: [`Auth::open`], [`ServerConfig`](crate::ServerConfig)'s default, or the methods added
/// to [`Auth::empty`].
///
/// A client offering several methods gets in with the first that succeeds. Checks run on the server's network
/// threads, so they should return quickly. A check that panics rejects the client and is reported to
/// [`ServerConfig::on_error`](field@crate::ServerConfig::on_error).
///
/// ```
/// use opentui_ssh::Auth;
///
/// let auth = Auth::empty().any_public_key().password(|user, password| user == "demo" && password == "demo");
/// ```
#[derive(Clone)]
pub struct Auth {
    open: bool,
    any_key: bool,
    authorized: Vec<PublicKey>,
    allow_key: Option<Arc<KeyCheck>>,
    password: Option<Arc<PasswordCheck>>,
}

impl std::fmt::Debug for Auth {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("Auth").field("methods", &self.method_names()).finish_non_exhaustive()
    }
}

impl Auth {
    /// No authentication: anyone who reaches the port gets a session, under whatever user name their client sends.
    /// [`serve`](crate::serve) warns, through [`ServerConfig::on_error`](field@crate::ServerConfig::on_error), when it
    /// listens beyond the loopback interface without authentication. Adding a method turns open access off.
    pub fn open() -> Self {
        Self { open: true, ..Self::empty() }
    }

    /// No methods yet. Add at least one; [`serve`](crate::serve) rejects a configuration without any.
    pub fn empty() -> Self {
        Self { open: false, any_key: false, authorized: Vec::new(), allow_key: None, password: None }
    }

    /// Accepts any public key the client proves it holds, so every client is identified by its key's fingerprint.
    /// Turns open access off.
    pub fn any_public_key(mut self) -> Self {
        self.open = false;
        self.any_key = true;
        self
    }

    /// Accepts the public keys in these `authorized_keys` lines, such as `ssh-ed25519 AAAA... user@host`. Blank lines
    /// and `#` comments are skipped. OpenSSH options before a key are not supported. Adds to the keys of earlier
    /// calls, and turns open access off.
    pub fn authorized_keys<S: AsRef<str>>(mut self, lines: impl IntoIterator<Item = S>) -> Result<Self, Error> {
        let keys = keys::parse_authorized(lines)?;
        if keys.is_empty() {
            return Err(Error::Config("authorized keys hold no keys".into()));
        }
        self.open = false;
        self.authorized.extend(keys);
        Ok(self)
    }

    /// [`Self::authorized_keys`] from a file.
    pub fn authorized_keys_file(self, path: impl AsRef<Path>) -> Result<Self, Error> {
        let path = path.as_ref();
        let text = std::fs::read_to_string(path).map_err(|error| Error::Key {
            message: format!("could not read {}", path.display()),
            source: Some(error),
        })?;
        self.authorized_keys(text.lines())
    }

    /// Accepts the public keys `allow` accepts, given the user name and the key, once the client has proved it
    /// holds the key. A key on the [`Self::authorized_keys`] list gets in without asking `allow`.
    ///
    /// The user name is whatever the client sent; the key is what is proven. To tie names to keys, check both here.
    ///
    /// Replaces the check of an earlier call, and turns open access off.
    pub fn allow_public_key(mut self, allow: impl Fn(&str, &ClientKey) -> bool + Send + Sync + 'static) -> Self {
        self.open = false;
        self.allow_key = Some(Arc::new(allow));
        self
    }

    /// Accepts the passwords `check` accepts, given the user name and the password. Replaces the check of an earlier
    /// call, and turns open access off.
    pub fn password(mut self, check: impl Fn(&str, &str) -> bool + Send + Sync + 'static) -> Self {
        self.open = false;
        self.password = Some(Arc::new(check));
        self
    }

    pub(crate) fn is_open(&self) -> bool {
        self.open
    }

    fn public_key(&self) -> bool {
        self.any_key || !self.authorized.is_empty() || self.allow_key.is_some()
    }

    /// The methods the server offers, as SSH names them.
    pub(crate) fn method_names(&self) -> Vec<&'static str> {
        let mut names = Vec::new();
        if self.open {
            names.push("none");
        }
        if self.public_key() {
            names.push("publickey");
        }
        if self.password.is_some() {
            names.push("password");
        }
        names
    }

    pub(crate) fn methods(&self) -> Vec<MethodKind> {
        let mut methods = Vec::new();
        if self.open {
            methods.push(MethodKind::None);
        }
        if self.public_key() {
            methods.push(MethodKind::PublicKey);
        }
        if self.password.is_some() {
            methods.push(MethodKind::Password);
        }
        methods
    }

    pub(crate) fn authorized(&self) -> &[PublicKey] {
        &self.authorized
    }

    pub(crate) fn none(&self, user: &str) -> Option<Identity> {
        self.open.then(|| Identity::None { user: user.to_owned() })
    }

    /// Whether a key is worth the client's signature. Ownership is not proven yet.
    pub(crate) fn offers(&self, key: &PublicKey) -> bool {
        self.any_key || self.allow_key.is_some() || self.is_authorized(key)
    }

    /// Checks a key the client proved it holds. `on_panic` reports a check that panicked.
    pub(crate) fn public_key_identity(
        &self,
        user: &str,
        key: &PublicKey,
        on_panic: impl FnOnce(Error),
    ) -> Option<Identity> {
        let client = ClientKey::new(key);
        let accepted = self.any_key
            || self.is_authorized(key)
            || self.allow_key.as_ref().is_some_and(|allow| guarded(|| allow(user, &client), on_panic));
        accepted.then(|| Identity::PublicKey { user: user.to_owned(), key: client })
    }

    pub(crate) fn password_identity(
        &self,
        user: &str,
        password: &str,
        on_panic: impl FnOnce(Error),
    ) -> Option<Identity> {
        let accepted = self.password.as_ref().is_some_and(|check| guarded(|| check(user, password), on_panic));
        accepted.then(|| Identity::Password { user: user.to_owned() })
    }

    fn is_authorized(&self, key: &PublicKey) -> bool {
        self.authorized.iter().any(|authorized| authorized.key_data() == key.key_data())
    }
}

/// Runs a check, treating a panic as a rejection.
fn guarded(check: impl FnOnce() -> bool, on_panic: impl FnOnce(Error)) -> bool {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(check)) {
        Ok(accepted) => accepted,
        Err(payload) => {
            on_panic(Error::Panic(crate::error::panic_message(&*payload)));
            false
        }
    }
}
