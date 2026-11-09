//! The codec as Tauri commands: the desktop app runs `dithtill-codec` natively
//! (multi-threaded); the web app runs the same crate as wasm. Mirrors the wasm ABI that
//! `src/platform/codec-wasm.ts` drives — `src/platform/codec.ts` is the native twin.
//! Bulk data (frames, PCM, file bytes) travels as raw IPC bodies, small values as JSON.

use std::collections::HashMap;
use std::sync::Mutex;

use dithtill_codec::{Container, EncodeOptions, Encoder, IndexedFrame, VideoReader};
use serde::{Deserialize, Serialize};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::State;

#[derive(Default)]
pub struct Codecs {
    next: u32,
    encoders: HashMap<u32, Encoder>,
    videos: HashMap<u32, VideoReader>,
}

pub type CodecState = Mutex<Codecs>;

impl Codecs {
    fn handle(&mut self) -> u32 {
        self.next = self.next.wrapping_add(1).max(1);
        self.next
    }
}

fn lock<'a>(s: &'a State<'_, CodecState>) -> Result<std::sync::MutexGuard<'a, Codecs>, String> {
    s.lock().map_err(|_| "codec state poisoned".to_string())
}

fn raw<'a>(req: &'a Request<'_>) -> Result<&'a [u8], String> {
    match req.body() {
        InvokeBody::Raw(b) => Ok(b),
        InvokeBody::Json(_) => Err("expected a binary body".into()),
    }
}

fn header<T: std::str::FromStr>(req: &Request<'_>, name: &str) -> Result<T, String> {
    req.headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| format!("missing header {name}"))
}

fn f32s(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncoderOpts {
    container: String,
    width: u32,
    height: u32,
    fps: u32,
    cycle_frames: Option<u32>,
    cycle_total: Option<u32>,
}

#[tauri::command(async)]
pub fn codec_encoder_new(opts: EncoderOpts, state: State<'_, CodecState>) -> Result<u32, String> {
    let enc = Encoder::new(EncodeOptions {
        container: if opts.container == "gif" {
            Container::Gif
        } else {
            Container::Mp4
        },
        width: opts.width,
        height: opts.height,
        fps: opts.fps,
        cycle: opts.cycle_frames.zip(opts.cycle_total),
    })
    .map_err(|e| e.0)?;
    let mut s = lock(&state)?;
    let id = s.handle();
    s.encoders.insert(id, enc);
    Ok(id)
}

/// Body: index data ‖ palette ‖ alpha. Headers: x-id, x-frame = "w,h,bitDepth,rowBytes,dataLen,palLen".
#[tauri::command(async)]
pub fn codec_encoder_frame(
    request: Request<'_>,
    state: State<'_, CodecState>,
) -> Result<(), String> {
    let id: u32 = header(&request, "x-id")?;
    let meta: String = header(&request, "x-frame")?;
    let m: Vec<usize> = meta.split(',').filter_map(|v| v.parse().ok()).collect();
    let [w, h, bd, rb, dl, pl] = m[..] else {
        return Err("bad frame header".into());
    };
    let body = raw(&request)?;
    if body.len() < dl + pl {
        return Err("frame body too short".into());
    }
    let frame = IndexedFrame {
        width: w as u32,
        height: h as u32,
        bit_depth: bd as u8,
        row_bytes: rb,
        data: &body[..dl],
        palette: &body[dl..dl + pl],
        alpha: &body[dl + pl..],
    };
    let mut s = lock(&state)?;
    let enc = s.encoders.get_mut(&id).ok_or("no such encoder")?;
    enc.push_frame(&frame).map_err(|e| e.0)
}

/// Body: left f32s ‖ right f32s (equal halves). Headers: x-id, x-rate.
#[tauri::command(async)]
pub fn codec_encoder_audio(
    request: Request<'_>,
    state: State<'_, CodecState>,
) -> Result<(), String> {
    let id: u32 = header(&request, "x-id")?;
    let rate: u32 = header(&request, "x-rate")?;
    let all = f32s(raw(&request)?);
    let (l, r) = all.split_at(all.len() / 2);
    let mut s = lock(&state)?;
    let enc = s.encoders.get_mut(&id).ok_or("no such encoder")?;
    enc.set_audio(l, r, rate).map_err(|e| e.0)
}

/// Finish (and drop) the encoder. With `out_path` the file is written there and the
/// response is empty; otherwise the response body is the file.
#[tauri::command(async)]
pub fn codec_encoder_finish(
    id: u32,
    out_path: Option<String>,
    state: State<'_, CodecState>,
) -> Result<Response, String> {
    let enc = lock(&state)?
        .encoders
        .remove(&id)
        .ok_or("no such encoder")?;
    let bytes = enc.finish().map_err(|e| e.0)?;
    match out_path {
        Some(p) => {
            std::fs::write(&p, &bytes).map_err(|e| format!("could not save {p}: {e}"))?;
            Ok(Response::new(Vec::new()))
        }
        None => Ok(Response::new(bytes)),
    }
}

#[tauri::command(async)]
pub fn codec_encoder_abort(id: u32, state: State<'_, CodecState>) -> Result<(), String> {
    lock(&state)?.encoders.remove(&id);
    Ok(())
}

/// Body: the whole video file.
#[tauri::command(async)]
pub fn codec_video_open(request: Request<'_>, state: State<'_, CodecState>) -> Result<u32, String> {
    let v = VideoReader::open(raw(&request)?.to_vec()).map_err(|e| e.0)?;
    let mut s = lock(&state)?;
    let id = s.handle();
    s.videos.insert(id, v);
    Ok(id)
}

#[derive(Serialize)]
pub struct VideoInfoOut {
    width: u32,
    height: u32,
    duration: f64,
    frames: usize,
    rotation: u8,
    codec: &'static str,
}

#[tauri::command(async)]
pub fn codec_video_info(id: u32, state: State<'_, CodecState>) -> Result<VideoInfoOut, String> {
    let s = lock(&state)?;
    let i = s.videos.get(&id).ok_or("no such video")?.info();
    Ok(VideoInfoOut {
        width: i.width,
        height: i.height,
        duration: i.duration,
        frames: i.frames,
        rotation: i.rotation,
        codec: i.codec,
    })
}

#[tauri::command(async)]
pub fn codec_video_times(
    id: u32,
    in_s: f64,
    out_s: f64,
    state: State<'_, CodecState>,
) -> Result<Vec<f64>, String> {
    let s = lock(&state)?;
    Ok(s.videos
        .get(&id)
        .ok_or("no such video")?
        .frame_times(in_s, out_s))
}

#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
pub fn codec_video_decode(
    id: u32,
    in_s: f64,
    out_s: f64,
    first: usize,
    count: usize,
    w: u32,
    h: u32,
    state: State<'_, CodecState>,
) -> Result<Response, String> {
    let mut s = lock(&state)?;
    let v = s.videos.get_mut(&id).ok_or("no such video")?;
    Ok(Response::new(
        v.decode(in_s, out_s, first, count, w, h).map_err(|e| e.0)?,
    ))
}

#[tauri::command(async)]
pub fn codec_video_close(id: u32, state: State<'_, CodecState>) -> Result<(), String> {
    lock(&state)?.videos.remove(&id);
    Ok(())
}

/// Body: the file. Headers: x-rate, optional x-trim = "in,out". Response: left f32s ‖
/// right f32s; an EMPTY response = the file has no audio stream.
#[tauri::command(async)]
pub fn codec_audio_decode(request: Request<'_>) -> Result<Response, String> {
    let rate: u32 = header(&request, "x-rate")?;
    let trim = request
        .headers()
        .get("x-trim")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            let (a, b) = v.split_once(',')?;
            Some((a.parse().ok()?, b.parse().ok()?))
        });
    match dithtill_codec::decode_audio(raw(&request)?, trim, rate).map_err(|e| e.0)? {
        Some((l, r)) => {
            let mut out = Vec::with_capacity((l.len() + r.len()) * 4);
            for v in l.iter().chain(r.iter()) {
                out.extend_from_slice(&v.to_le_bytes());
            }
            Ok(Response::new(out))
        }
        None => Ok(Response::new(Vec::new())),
    }
}
