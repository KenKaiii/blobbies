use serde::{Serialize, Serializer};

/// Every error that can cross the IPC boundary.
///
/// Commands return this instead of `String` so the frontend receives a stable,
/// matchable shape, and so internal details never leak into the webview by
/// accident: only the variants declared here are ever serialized.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("input must not be empty")]
    EmptyInput,

    #[error("input must be at most {max} characters")]
    InputTooLong { max: usize },

    #[error("unknown storage slice")]
    InvalidSliceKey,

    #[error("stored data uses schema {found}, but this app supports up to {supported}")]
    SchemaTooNew { found: u64, supported: u64 },

    #[error("stored file is too large to load")]
    SliceTooLarge,

    #[error("{file} uses schema {found}, but this app supports up to {supported}")]
    SliceSchemaTooNew {
        file: String,
        found: u32,
        supported: u32,
    },

    #[error("stored data is corrupted: {0}")]
    Corrupt(String),

    #[error("no such Blob")]
    BlobNotFound,

    #[error("path is outside the Blob's home folder")]
    PathOutsideHome,

    #[error("no such file")]
    FileNotFound,

    #[error("file is too large")]
    FileTooLarge,

    #[error("file is not text")]
    NotText,

    #[error("the Blob's home folder is full")]
    HomeFull,

    /// The window disappeared between being listed and being captured.
    #[error("that window is no longer open")]
    WindowGone,

    /// Built without screen capture — Linux, where it would drag pipewire in as
    /// a system requirement for every user (see capture.rs and Cargo.toml).
    #[error("taking screenshots isn't supported on this platform")]
    CaptureUnsupported,

    /// Capture failed. On macOS that is usually missing Screen Recording
    /// consent, which only the user can grant — so the text points them there
    /// instead of reading as a bug in the app.
    #[error("couldn't capture that ({0}) — check Screen Recording access in System Settings")]
    Capture(String),

    #[error("storage error: {0}")]
    Io(String),

    /// Message is shown to the user, so it must stay free of internals — see
    /// `ocr::describe`.
    #[error("{0}")]
    Ocr(String),
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// Result alias for command handlers.
pub(crate) type Result<T> = std::result::Result<T, Error>;
