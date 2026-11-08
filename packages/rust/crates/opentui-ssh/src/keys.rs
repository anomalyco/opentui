//! Host keys, client keys, and `authorized_keys` lines.

use crate::Error;
use russh::keys::ssh_key::LineEnding;
use russh::keys::{Algorithm, HashAlg, PrivateKey, PublicKey};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Where the server's host keys come from.
#[derive(Clone, Default)]
pub enum HostKey {
    /// A new Ed25519 key each time the server starts. Clients see a changed host key after every restart, so this
    /// suits development only.
    #[default]
    Ephemeral,
    /// The key in this file, or a new Ed25519 key saved there when the file does not exist yet. On Unix a new file
    /// is readable by its owner only, in a directory created with the same restriction.
    File(PathBuf),
    /// Private keys as text, in OpenSSH or PEM format. Clients pick the first one they support.
    Keys(Vec<String>),
}

/// Shows how many [`HostKey::Keys`] there are, never the private keys themselves.
impl std::fmt::Debug for HostKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Ephemeral => formatter.write_str("Ephemeral"),
            Self::File(path) => formatter.debug_tuple("File").field(path).finish(),
            Self::Keys(texts) => {
                let noun = if texts.len() == 1 { "key" } else { "keys" };
                write!(formatter, "Keys(<{} {noun} redacted>)", texts.len())
            }
        }
    }
}

/// A client's public key, after the client proved it holds the private key.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ClientKey {
    /// The key type, such as `ssh-ed25519`.
    pub algorithm: String,
    /// The SHA-256 fingerprint as `ssh-keygen -l` shows it: `SHA256:` and unpadded base64.
    pub fingerprint: String,
    /// The key as an `authorized_keys` line, without a comment.
    pub openssh: String,
}

impl ClientKey {
    pub(crate) fn new(key: &PublicKey) -> Self {
        let mut key = key.clone();
        key.set_comment("");
        Self {
            algorithm: key.algorithm().as_str().to_owned(),
            fingerprint: fingerprint(&key),
            openssh: key.to_openssh().unwrap_or_default(),
        }
    }
}

pub(crate) fn fingerprint(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

/// A host key and where it came from, for the startup banner.
pub(crate) struct LoadedKey {
    pub key: PrivateKey,
    pub source: String,
}

impl HostKey {
    pub(crate) fn load(&self) -> Result<Vec<LoadedKey>, Error> {
        match self {
            Self::Ephemeral => Ok(vec![LoadedKey { key: generate()?, source: "ephemeral".into() }]),
            Self::File(path) => load_or_generate(path).map(|key| vec![key]),
            Self::Keys(texts) if texts.is_empty() => Err(Error::Config("HostKey::Keys holds no keys".into())),
            Self::Keys(texts) => texts
                .iter()
                .map(|text| Ok(LoadedKey { key: decode(text, "a provided host key")?, source: "provided".into() }))
                .collect(),
        }
    }
}

fn generate() -> Result<PrivateKey, Error> {
    PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519)
        .map_err(|error| Error::Key { message: format!("could not generate a host key: {error}"), source: None })
}

fn decode(text: &str, what: &str) -> Result<PrivateKey, Error> {
    russh::keys::decode_secret_key(text, None)
        .map_err(|error| Error::Key { message: format!("could not read {what}: {error}"), source: None })
}

/// Loads the key at `path`, or generates one and saves it there. The new key appears at `path` complete: it is
/// written to a temporary file and then linked into place, so a server starting at the same moment either loads it
/// or saves its own first.
fn load_or_generate(path: &Path) -> Result<LoadedKey, Error> {
    let shown = path.display();
    match fs::read_to_string(path) {
        Ok(text) => {
            return Ok(LoadedKey {
                key: decode(&text, &format!("host key {shown}"))?,
                source: format!("loaded {shown}"),
            });
        }
        Err(error) if error.kind() != io::ErrorKind::NotFound => {
            return Err(Error::Key { message: format!("could not read host key {shown}"), source: Some(error) });
        }
        Err(_) => {}
    }
    let key = generate()?;
    let text = key
        .to_openssh(LineEnding::LF)
        .map_err(|error| Error::Key { message: format!("could not encode a host key: {error}"), source: None })?;
    if let Some(parent) = path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        create_private_dir(parent).map_err(|error| Error::Key {
            message: format!("could not create {}", parent.display()),
            source: Some(error),
        })?;
    }
    // Unique among processes and among this process's threads.
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |time| time.as_nanos());
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(format!(".{}.{nanos}.{}.tmp", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
    let temporary = PathBuf::from(temporary);
    let saved = write_private(&temporary, text.as_bytes()).and_then(|()| fs::hard_link(&temporary, path));
    let _ = fs::remove_file(&temporary);
    match saved {
        Ok(()) => Ok(LoadedKey { key, source: format!("generated {shown}") }),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            let text = fs::read_to_string(path).map_err(|error| Error::Key {
                message: format!("could not read host key {shown}"),
                source: Some(error),
            })?;
            Ok(LoadedKey { key: decode(&text, &format!("host key {shown}"))?, source: format!("loaded {shown}") })
        }
        Err(error) => Err(Error::Key { message: format!("could not save host key {shown}"), source: Some(error) }),
    }
}

fn create_private_dir(path: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(path)
}

fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

/// Parses `authorized_keys` lines, skipping blank lines and `#` comments.
pub(crate) fn parse_authorized<S: AsRef<str>>(lines: impl IntoIterator<Item = S>) -> Result<Vec<PublicKey>, Error> {
    let mut keys = Vec::new();
    for line in lines {
        let line = line.as_ref().trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let key = PublicKey::from_openssh(line).map_err(|error| {
            let start: String = line.chars().take(40).collect();
            Error::Key { message: format!("invalid authorized key {start:?}: {error}"), source: None }
        })?;
        keys.push(key);
    }
    Ok(keys)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("opentui-ssh-{name}-{}-{nanos}", std::process::id()))
    }

    #[test]
    fn a_host_key_file_is_generated_once_then_loaded() {
        let directory = scratch("host-key");
        let path = directory.join("keys").join("host_key");
        let first = HostKey::File(path.clone()).load().unwrap().remove(0);
        assert!(first.source.starts_with("generated"), "{}", first.source);
        let second = HostKey::File(path.clone()).load().unwrap().remove(0);
        assert!(second.source.starts_with("loaded"), "{}", second.source);
        assert_eq!(first.key.public_key(), second.key.public_key());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(fs::metadata(path.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
        }
        let leftovers: Vec<_> = fs::read_dir(path.parent().unwrap()).unwrap().collect();
        assert_eq!(leftovers.len(), 1, "no temporary files remain");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn provided_keys_load_and_bad_ones_fail() {
        let text = generate().unwrap().to_openssh(LineEnding::LF).unwrap().to_string();
        let keys = HostKey::Keys(vec![text.clone(), text]).load().unwrap();
        assert_eq!(keys.len(), 2);
        assert!(matches!(HostKey::Keys(vec!["nonsense".into()]).load(), Err(Error::Key { source: None, .. })));
        assert!(matches!(HostKey::Keys(Vec::new()).load(), Err(Error::Config(_))));
    }

    #[test]
    fn debug_output_redacts_provided_keys() {
        let text = generate().unwrap().to_openssh(LineEnding::LF).unwrap().to_string();
        let host_key = HostKey::Keys(vec![text.clone(), text.clone()]);
        let shown = format!("{:?}", crate::ServerConfig::new().host_key(host_key));
        assert!(shown.contains("Keys(<2 keys redacted>)"), "{shown}");
        assert!(!shown.contains("PRIVATE KEY") && !shown.contains(text.lines().nth(1).unwrap()), "{shown}");
        assert_eq!(format!("{:?}", HostKey::File("host_key".into())), r#"File("host_key")"#);
    }

    #[test]
    fn authorized_keys_skip_blank_lines_and_comments() {
        let public = generate().unwrap().public_key().to_openssh().unwrap();
        let keys = parse_authorized(["", "# a comment", &format!("{public} user@host"), "  "]).unwrap();
        assert_eq!(keys.len(), 1);
        let client = ClientKey::new(&keys[0]);
        assert_eq!(client.algorithm, "ssh-ed25519");
        assert!(client.fingerprint.starts_with("SHA256:"));
        assert_eq!(client.openssh, public);
        assert!(matches!(parse_authorized(["ssh-ed25519 not-base64"]), Err(Error::Key { .. })));
    }

    #[test]
    fn key_errors_keep_the_io_error() {
        let missing = scratch("missing").join("authorized_keys");
        let error = crate::Auth::empty().authorized_keys_file(&missing).unwrap_err();
        assert!(matches!(&error, Error::Key { source: Some(source), .. } if source.kind() == io::ErrorKind::NotFound));
        let source = std::error::Error::source(&error).and_then(|source| source.downcast_ref::<io::Error>());
        assert_eq!(source.map(io::Error::kind), Some(io::ErrorKind::NotFound));
        let shown = error.to_string();
        assert!(shown.starts_with(&format!("key failed: could not read {}: ", missing.display())), "{shown}");
    }
}
