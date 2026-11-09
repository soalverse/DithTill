//! DithTill's codec layer: everything the app used the ffmpeg sidecar for, in
//! pure Rust under permissive licences. The SAME code runs native inside the desktop app
//! (Tauri commands, multi-threaded) and as wasm in the web app, the MCP tools and the tests
//! (single-threaded) — one encoder, one decoder, one set of recipes everywhere.
//!
//! - [`Encoder`]: rendered indexed frames → MP4 (H.264 + AAC) or looping GIF.
//! - [`VideoReader`]: a placed video's exact frames for the export walk.
//! - [`decode_audio`]: a song / clip soundtrack → planar stereo at the pinned rate.

mod audio;
mod encode;
mod video;
#[cfg(target_arch = "wasm32")]
mod wasm;

pub use audio::{decode_audio, resample};
pub use encode::{Container, EncodeOptions, Encoder, IndexedFrame};
pub use video::{VideoInfo, VideoReader};

/// A codec failure, as a message the app can show.
#[derive(Debug, Clone)]
pub struct Error(pub String);

impl Error {
    pub fn msg<E: std::fmt::Display>(e: E) -> Error {
        Error(e.to_string())
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

/// EBML header → Matroska / WebM.
pub(crate) fn is_matroska(b: &[u8]) -> bool {
    b.starts_with(&[0x1A, 0x45, 0xDF, 0xA3])
}

/// A top-level ISO BMFF / QuickTime box → MP4, M4A, MOV.
pub(crate) fn is_isobmff(b: &[u8]) -> bool {
    b.len() >= 8
        && matches!(
            &b[4..8],
            b"ftyp" | b"moov" | b"mdat" | b"wide" | b"free" | b"skip" | b"pnot"
        )
}
