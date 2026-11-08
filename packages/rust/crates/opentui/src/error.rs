use crate::sys;
use std::fmt;

pub type Result<T, E = Error> = std::result::Result<T, E>;

/// An error from native code, the terminal, or the host.
#[derive(Debug)]
#[non_exhaustive]
pub enum Error {
    /// A native call returned a status other than `OT_OK`.
    Native { operation: &'static str, status: Status },
    /// Terminal or transport I/O failed.
    Io(std::io::Error),
    /// The host broke a rule of this crate, for example by exceeding a fixed bound.
    Usage(&'static str),
    /// An error from the app's own code, passed to [`App::fail`](crate::App::fail) or returned from an SSH session
    /// handler. Create one with [`Error::other`].
    Other(Box<dyn std::error::Error + Send + Sync>),
}

impl Error {
    /// The native status, when native code rejected the operation.
    pub fn status(&self) -> Option<Status> {
        match self {
            Self::Native { status, .. } => Some(*status),
            _ => None,
        }
    }

    /// Wraps an error from the app's own code, or a message: `Error::other("no config file")`.
    pub fn other(error: impl Into<Box<dyn std::error::Error + Send + Sync>>) -> Self {
        Self::Other(error.into())
    }
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Native { operation, status } => {
                write!(formatter, "{operation} failed: {} ({})", status.description(), status.code())
            }
            Self::Io(error) => write!(formatter, "terminal I/O failed: {error}"),
            Self::Usage(message) => formatter.write_str(message),
            Self::Other(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Other(error) => error.source(),
            _ => None,
        }
    }
}

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

macro_rules! statuses {
    ($($variant:ident = $code:ident: $description:literal,)*) => {
        /// A native `ot_status` error code.
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        #[non_exhaustive]
        pub enum Status {
            $(#[doc = $description] $variant,)*
            /// A code this crate does not name, from a newer native library.
            Unknown(i32),
        }

        impl Status {
            pub fn from_code(code: i32) -> Self {
                match code {
                    $(sys::$code => Self::$variant,)*
                    _ => Self::Unknown(code),
                }
            }

            pub fn code(self) -> i32 {
                match self {
                    $(Self::$variant => sys::$code,)*
                    Self::Unknown(code) => code,
                }
            }

            pub fn description(self) -> &'static str {
                match self {
                    $(Self::$variant => $description,)*
                    Self::Unknown(_) => "unknown status",
                }
            }
        }
    };
}

statuses! {
    InvalidArgument = OT_INVALID_ARGUMENT: "invalid argument",
    UnsupportedVersion = OT_UNSUPPORTED_VERSION: "unsupported ABI version",
    OutOfMemory = OT_OUT_OF_MEMORY: "out of memory",
    WrongThread = OT_WRONG_THREAD: "called from a thread that does not own the context",
    InternalError = OT_INTERNAL_ERROR: "internal error",
    ContextBusy = OT_CONTEXT_BUSY: "context busy",
    WrongContext = OT_WRONG_CONTEXT: "handle belongs to another context",
    WrongKind = OT_WRONG_KIND: "handle names another kind of resource",
    StaleHandle = OT_STALE_HANDLE: "stale handle",
    WrongSession = OT_WRONG_SESSION: "handle belongs to another session",
    OutputBackpressure = OT_OUTPUT_BACKPRESSURE: "output queue full",
    SessionClosed = OT_SESSION_CLOSED: "session closed",
    OutputBusy = OT_OUTPUT_BUSY: "output busy",
    StaleOutput = OT_STALE_OUTPUT: "stale output ticket",
    OutputFailed = OT_OUTPUT_FAILED: "output transport failed",
    ObjectLimit = OT_OBJECT_LIMIT: "object limit reached",
    RendererAttached = OT_RENDERER_ATTACHED: "renderer already attached",
    RendererNotAttached = OT_RENDERER_NOT_ATTACHED: "renderer not attached",
    InvalidPhase = OT_INVALID_PHASE: "invalid terminal phase",
    ControlPacketLimit = OT_CONTROL_PACKET_LIMIT: "control packet limit reached",
    LeaseLimit = OT_LEASE_LIMIT: "lease limit reached",
    LeaseBytesLimit = OT_LEASE_BYTES_LIMIT: "leased storage limit reached",
    StaleLease = OT_STALE_LEASE: "stale lease",
    UnsupportedResource = OT_UNSUPPORTED_RESOURCE: "unsupported resource",
    StaleFrame = OT_STALE_FRAME: "stale frame",
    LayoutLimit = OT_LAYOUT_LIMIT: "layout limit reached",
    FrameBusy = OT_FRAME_BUSY: "frame busy",
    FrameRequestLimit = OT_FRAME_REQUEST_LIMIT: "frame request limit reached",
    ImageUnsupportedFormat = OT_IMAGE_UNSUPPORTED_FORMAT: "unsupported image format",
    ImageUnsupportedColorSpace = OT_IMAGE_UNSUPPORTED_COLOR_SPACE: "unsupported image color space",
    ImageMalformedData = OT_IMAGE_MALFORMED_DATA: "malformed image data",
    ImageDimensionLimit = OT_IMAGE_DIMENSION_LIMIT: "image dimensions exceed the limit",
    ImageMemoryLimit = OT_IMAGE_MEMORY_LIMIT: "image memory limit reached",
    ImageOutputTooSmall = OT_IMAGE_OUTPUT_TOO_SMALL: "image output buffer too small",
    ImageUnsupportedFeature = OT_IMAGE_UNSUPPORTED_FEATURE: "unsupported image feature",
    ImageBusy = OT_IMAGE_BUSY: "image busy",
    AudioDecodeFailed = OT_AUDIO_DECODE_FAILED: "audio decoding failed",
    AudioDeviceFailed = OT_AUDIO_DEVICE_FAILED: "audio device failed",
}

pub(crate) fn check(operation: &'static str, code: sys::ot_status) -> Result<()> {
    if code == sys::OT_OK { Ok(()) } else { Err(Error::Native { operation, status: Status::from_code(code) }) }
}

/// Converts a host length to the ABI's `u32` byte or record count.
pub(crate) fn count(operation: &'static str, length: usize) -> Result<u32> {
    length.try_into().map_err(|_| Error::Native { operation, status: Status::InvalidArgument })
}

/// Native cleanup has no recovery path: a failure means an owner invariant broke, so abort instead of leaking.
pub(crate) fn cleanup(operation: &'static str, code: sys::ot_status) {
    if let Err(error) = check(operation, code) {
        eprintln!("opentui: native cleanup failed: {error}");
        std::process::abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_negative_header_status_has_a_name() {
        for code in -64..0 {
            let status = Status::from_code(code);
            assert_eq!(status.code(), code);
            let named = !matches!(status, Status::Unknown(_));
            let known = (-28..=-1).contains(&code) || (-47..=-40).contains(&code) || (-62..=-61).contains(&code);
            assert_eq!(named, known, "status {code}");
        }
    }
}
