//! Generate tests/fixtures/parity.mp4 — the golden parity gate's fixture clip (P8,
//! re-made for the codec). Run once and COMMIT the output; the golden grids JSON
//! is (re)generated from it by the suite (`UPDATE_GOLDEN=1 npx vitest run
//! tests/loop-export-parity.test.ts`).
//!
//!   cargo run --release --example make_parity_fixture --manifest-path src-tauri/codec/Cargo.toml
//!
//! Why the gate can demand cell-for-cell equality between the browser's live seek-grab and
//! the codec's decode:
//! - GRAYSCALE ONLY: constant chroma, so chroma upsampling differences cannot exist.
//! - 192x108 == the video raster dims (videoRasterDims) → no scaler in either path.
//! - H.264 decoding is bit-exact by specification, so both decoders produce the same Y; a
//!   near-lossless QP keeps the bands and bar edges at their intended levels. Tagged
//!   BT.709 limited range → both convert the same Y the same way.
//! - A white bar moves 8px per frame → any frame-SELECTION error changes grids.
//! - A keyframe every 6 frames → several GOPs in 24 frames, so seeks are real.
//! - Mid-gray bands (64/128/192) probe converter rounding; 0/255 are exact.

use std::io::Cursor;

use filmcraft_h264enc::{
    ColorConfig, Encoder, EncoderConfig, PacketFormat, Preset, Profile, RateControl, YuvFrame,
};
use filmcraft_isobmff::{
    AvcConfig, Brand, Mp4Writer, SampleEntry, TrackConfig, WriteSample, WriterOptions,
};

const W: usize = 192;
const H: usize = 108;
const FRAMES: usize = 24;
const FPS: u32 = 30;

/// Frame k's grey level at (x, y): black field, a 16px white bar at x = 8k (top 90 rows),
/// three static mid-gray bands (64/128/192) across the bottom 18 rows.
fn grey(k: usize, x: usize, y: usize) -> u32 {
    if y >= 90 {
        if y < 96 {
            64
        } else if y < 102 {
            128
        } else {
            192
        }
    } else if x >= k * 8 && x < k * 8 + 16 {
        255
    } else {
        0
    }
}

fn main() {
    let mut cfg = EncoderConfig::new(W as u32, H as u32, FPS, 1);
    cfg.profile = Profile::High;
    cfg.preset = Preset::Quality;
    cfg.rate = RateControl::Qp(1);
    cfg.bframes = 0;
    cfg.keyint = 6;
    cfg.scenecut = false;
    cfg.format = PacketFormat::LengthPrefixed;
    cfg.color = ColorConfig {
        primaries: 1,
        transfer: 1,
        matrix: 1,
        full_range: false,
    };
    let mut enc = Encoder::new(cfg).expect("encoder");
    let mut packets = Vec::new();
    let (u, v) = (vec![128u8; W * H / 4], vec![128u8; W * H / 4]);
    for k in 0..FRAMES {
        // Limited range: Y = 16 + 219·g/255.
        let y: Vec<u8> = (0..W * H)
            .map(|i| (16 + (219 * grey(k, i % W, i / W) + 127) / 255) as u8)
            .collect();
        let frame = YuvFrame {
            y: &y,
            u: &u,
            v: &v,
            y_stride: W,
            uv_stride: W / 2,
        };
        packets.extend(enc.encode(&frame, k as i64).expect("encode"));
    }
    packets.extend(enc.flush());

    let mut mux =
        Mp4Writer::new(Cursor::new(Vec::new()), WriterOptions::new(Brand::Mp4)).expect("mux");
    let avc = AvcConfig::parse(&enc.avcc()).expect("avcC");
    let t = mux
        .add_track(TrackConfig::new(
            SampleEntry::avc(avc, W as u16, H as u16),
            FPS,
        ))
        .expect("track");
    for p in &packets {
        let s = WriteSample {
            data: &p.data,
            duration: 1,
            composition_offset: (p.pts - p.dts) as i32,
            is_sync: p.keyframe,
        };
        mux.write_sample(t, s).expect("sample");
    }
    let bytes = mux.finish_faststart().expect("finish").into_inner();
    let out =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/parity.mp4");
    std::fs::write(&out, &bytes).expect("write fixture");
    println!(
        "{} ({} bytes, {} frames)",
        out.display(),
        bytes.len(),
        FRAMES
    );
}
