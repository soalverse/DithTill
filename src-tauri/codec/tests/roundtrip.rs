//! Round trips through the codec's own encoder and decoders: what goes into an export
//! comes back out of the import path (frames, timing, sound, GIF palette).

use dithtill_codec::{
    Container, EncodeOptions, Encoder, IndexedFrame, VideoReader, decode_audio, resample,
};

const W: u32 = 96;
const H: u32 = 64;
const FPS: u32 = 30;

/// An 8-bit indexed grey ramp frame whose bright bar moves with `f`.
fn frame_data(f: u32) -> Vec<u8> {
    let mut d = vec![0u8; (W * H) as usize];
    for y in 0..H {
        for x in 0..W {
            let bar = (x + f * 3) % W < 16;
            d[(y * W + x) as usize] = if bar { 255 } else { ((x * 2 + y) % 200) as u8 };
        }
    }
    d
}

fn grey_palette() -> Vec<u8> {
    (0..=255u8).flat_map(|v| [v, v, v]).collect()
}

fn push(enc: &mut Encoder, f: u32, pal: &[u8]) {
    let data = frame_data(f);
    let frame = IndexedFrame {
        width: W,
        height: H,
        bit_depth: 8,
        row_bytes: W as usize,
        data: &data,
        palette: pal,
        alpha: &[],
    };
    enc.push_frame(&frame).unwrap();
}

fn sine(n: usize, hz: f32, rate: u32) -> Vec<f32> {
    (0..n)
        .map(|i| 0.5 * (std::f32::consts::TAU * hz * i as f32 / rate as f32).sin())
        .collect()
}

fn mp4(frames: u32, audio: bool, cycle: Option<(u32, u32)>) -> Vec<u8> {
    let pal = grey_palette();
    let mut enc = Encoder::new(EncodeOptions {
        container: Container::Mp4,
        width: W,
        height: H,
        fps: FPS,
        cycle,
    })
    .unwrap();
    for f in 0..frames {
        push(&mut enc, f, &pal);
    }
    if audio {
        let total = cycle.map_or(frames, |c| c.1);
        let n = (total * 48_000 / FPS) as usize + 4800;
        let s = sine(n, 440.0, 48_000);
        enc.set_audio(&s, &s, 48_000).unwrap();
    }
    enc.finish().unwrap()
}

#[test]
fn mp4_frames_decode_back_in_order() {
    let bytes = mp4(45, false, None);
    let mut v = VideoReader::open(bytes).unwrap();
    let info = v.info();
    assert_eq!((info.width, info.height, info.frames), (W, H, 45));
    let times = v.frame_times(0.0, 10.0);
    assert_eq!(times.len(), 45);
    for (k, t) in times.iter().enumerate() {
        assert!((t - k as f64 / FPS as f64).abs() < 1e-6, "frame {k} at {t}");
    }
    // Decode in tiles (as the export walks) and compare luma with the source.
    let mut got = Vec::new();
    for first in (0..45).step_by(7) {
        let count = 7.min(45 - first);
        got.extend(v.decode(0.0, 10.0, first, count, W, H).unwrap());
    }
    for f in 0..45u32 {
        let src = frame_data(f);
        let px = &got[(f * W * H * 4) as usize..((f + 1) * W * H * 4) as usize];
        let err: f64 = src
            .iter()
            .zip(px.chunks_exact(4))
            .map(|(&s, p)| (s as f64 - p[1] as f64).abs())
            .sum::<f64>()
            / src.len() as f64;
        assert!(err < 6.0, "frame {f}: mean error {err}");
    }
}

#[test]
fn tile_order_and_size_never_change_the_frames() {
    let bytes = mp4(30, false, None);
    let mut a = VideoReader::open(bytes.clone()).unwrap();
    let whole = a.decode(0.0, 10.0, 0, 30, W / 2, H / 2).unwrap();
    let mut b = VideoReader::open(bytes).unwrap();
    // Backwards tiles force keyframe restarts.
    let mut parts = vec![Vec::new(); 6];
    for t in (0..6).rev() {
        parts[t] = b.decode(0.0, 10.0, t * 5, 5, W / 2, H / 2).unwrap();
    }
    assert_eq!(whole, parts.concat());
}

#[test]
fn trim_window_selects_presentation_times() {
    let bytes = mp4(30, false, None);
    let v = VideoReader::open(bytes).unwrap();
    let t = v.frame_times(0.5, 0.8);
    assert_eq!(t.len(), 9);
    assert!((t[0] - 0.5).abs() < 1e-6);
}

#[test]
fn mp4_sound_round_trips_in_sync() {
    let bytes = mp4(60, true, None);
    let (l, r) = decode_audio(&bytes, None, 48_000)
        .unwrap()
        .expect("audio track");
    assert_eq!(l.len(), r.len());
    // 2 s of video → 2 s of sound (AAC frames pad the end by < one frame).
    assert!(
        (l.len() as i64 - 96_000).abs() < 2048,
        "{} samples",
        l.len()
    );
    // Encoder delay is removed: the sine starts at sample 0 (phase-aligned with the source).
    let src = sine(48_000, 440.0, 48_000);
    let dot: f32 = l[4800..9600]
        .iter()
        .zip(&src[4800..9600])
        .map(|(a, b)| a * b)
        .sum();
    let norm: f32 = src[4800..9600].iter().map(|v| v * v).sum();
    assert!(dot / norm > 0.9, "correlation {}", dot / norm);
}

#[test]
fn cycle_export_repeats_to_the_total_length() {
    // 10-frame cycle → 34 frames (3 whole cycles + a 4-frame tail), with sound.
    let bytes = mp4(10, true, Some((10, 34)));
    let mut v = VideoReader::open(bytes.clone()).unwrap();
    assert_eq!(v.info().frames, 34);
    let px = v.decode(0.0, 10.0, 0, 34, W, H).unwrap();
    let fsz = (W * H * 4) as usize;
    for f in 0..34 {
        let base = f % 10;
        assert_eq!(
            &px[f * fsz..(f + 1) * fsz],
            &px[base * fsz..(base + 1) * fsz],
            "frame {f} == cycle frame {base}"
        );
    }
    let (l, _) = decode_audio(&bytes, None, 48_000).unwrap().unwrap();
    assert!((l.len() as i64 - 34 * 1600).abs() < 2048);
}

#[test]
fn gif_keeps_exact_palette_colours_and_loops() {
    let pal = [10u8, 20, 30, 200, 100, 50, 0, 0, 0];
    let alpha = [255u8, 255, 0];
    let mut enc = Encoder::new(EncodeOptions {
        container: Container::Gif,
        width: 8,
        height: 4,
        fps: 30,
        cycle: None,
    })
    .unwrap();
    // 2-bit packed rows: index pattern 0,1,2,0 … (8 px = 2 bytes per row).
    let row = [0b00_01_10_00u8, 0b01_01_00_10];
    let data: Vec<u8> = (0..4).flat_map(|_| row).collect();
    for _ in 0..3 {
        enc.push_frame(&IndexedFrame {
            width: 8,
            height: 4,
            bit_depth: 2,
            row_bytes: 2,
            data: &data,
            palette: &pal,
            alpha: &alpha,
        })
        .unwrap();
    }
    let bytes = enc.finish().unwrap();
    let mut opts = gif::DecodeOptions::new();
    opts.set_color_output(gif::ColorOutput::RGBA);
    let mut d = opts.read_info(bytes.as_slice()).unwrap();
    let mut delays = Vec::new();
    while let Some(f) = d.read_next_frame().unwrap() {
        delays.push(f.delay);
        assert_eq!(&f.buffer[0..4], &[10, 20, 30, 255]);
        assert_eq!(&f.buffer[4..8], &[200, 100, 50, 255]);
        assert_eq!(f.buffer[11], 0, "alpha 0 entry is transparent");
    }
    assert_eq!(delays, vec![3, 4, 3]);
}

#[test]
fn wav_decodes_and_resamples_to_the_pinned_rate() {
    let n = 44_100;
    let s = sine(n, 1000.0, 44_100);
    let mut wav = Vec::new();
    let data_len = (n * 2) as u32;
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&44_100u32.to_le_bytes());
    wav.extend_from_slice(&88_200u32.to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    for v in &s {
        wav.extend_from_slice(&((v * 32767.0) as i16).to_le_bytes());
    }
    let (l, r) = decode_audio(&wav, Some((0.25, 0.75)), 48_000)
        .unwrap()
        .unwrap();
    assert_eq!(l, r, "mono is duplicated");
    assert!((l.len() as i64 - 24_000).abs() <= 1);
    let want = sine(48_000, 1000.0, 48_000);
    // 0.25 s in, the 1 kHz sine is back at phase 0.
    let err: f32 = l[1000..2000]
        .iter()
        .zip(&want[1000..2000])
        .map(|(a, b)| (a - b).abs())
        .sum::<f32>()
        / 1000.0;
    assert!(err < 0.01, "resample error {err}");
}

#[test]
fn resample_is_identity_at_the_same_rate_and_keeps_length() {
    let x = sine(1000, 50.0, 8000);
    assert_eq!(resample(&x, 8000, 8000), x);
    assert_eq!(resample(&x, 44_100, 48_000).len(), 1089);
}

#[test]
fn not_a_media_file_is_an_error_not_a_panic() {
    assert!(VideoReader::open(vec![1, 2, 3, 4, 5, 6, 7, 8, 9]).is_err());
    assert!(
        decode_audio(b"hello world, definitely not audio", None, 48_000)
            .unwrap()
            .is_none()
    );
}
