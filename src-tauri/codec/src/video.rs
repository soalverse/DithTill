//! Video frame reader for the export walk: demux (MP4/MOV, Matroska/WebM) + decode
//! (H.264, HEVC, VP8, VP9, AV1) → RGBA frames scaled to the layer's raster size.
//!
//! Frames are addressed by PRESENTATION order inside a trim window [in, out) — the list
//! `frame_times` returns, which the pure selection rules (core/video-frames) index into.
//! Decoding is sequential with keyframe seeks: a request continues from where the last
//! one stopped (the export walks tiles in order) and only restarts at a keyframe when it
//! has to go back or jump far ahead. Display rotation (iPhone portrait) is applied, like
//! the browser's own video player.

use filmcraft_isobmff as mp4;
use filmcraft_matroska as mkv;

use crate::{Error, Result};

/// Frames decoded past the requested range are kept (in display order) up to this many,
/// so the next contiguous request needs no restart.
const AHEAD_MAX: usize = 32;

enum Source {
    Mp4 {
        file: Box<mp4::Mp4File>,
        track: usize,
    },
    Mkv {
        file: Box<mkv::MkvFile>,
        track: usize,
    },
}

#[derive(Clone)]
enum Codec {
    H264(Vec<u8>),
    Hevc(Vec<u8>),
    Vp8,
    Vp9,
    Av1,
}

enum Dec {
    H264(Box<filmcraft_h264::Decoder>),
    Hevc(Box<filmcraft_hevc::Decoder>),
    Vp8(Box<filmcraft_vp8::Decoder>),
    Vp9(Box<filmcraft_vp9::Decoder>),
    Av1(Box<filmcraft_av1::Decoder>),
}

struct SampleRef {
    /// Presentation time (seconds, edit lists applied).
    pts: f64,
    sync: bool,
}

pub struct VideoInfo {
    /// Display size (rotation applied).
    pub width: u32,
    pub height: u32,
    pub duration: f64,
    pub frames: usize,
    pub codec: &'static str,
    pub rotation: u8,
}

pub struct VideoReader {
    bytes: Vec<u8>,
    src: Source,
    codec: Codec,
    /// Decode order.
    samples: Vec<SampleRef>,
    /// Display rank → decode index (sorted by pts).
    display: Vec<usize>,
    /// Decode index → display rank.
    rank: Vec<usize>,
    rotation: u8,
    coded: (u32, u32),
    dec: Option<Dec>,
    next_feed: usize,
    last_out: Option<usize>,
    ahead: Vec<(usize, Vec<u8>)>,
    ahead_dims: (u32, u32),
    last_frame: Option<Vec<u8>>,
}

fn codec_name(c: &Codec) -> &'static str {
    match c {
        Codec::H264(_) => "h264",
        Codec::Hevc(_) => "hevc",
        Codec::Vp8 => "vp8",
        Codec::Vp9 => "vp9",
        Codec::Av1 => "av1",
    }
}

impl VideoReader {
    pub fn open(bytes: Vec<u8>) -> Result<Self> {
        let (src, codec, samples, rotation, coded) = if crate::is_matroska(&bytes) {
            open_mkv(&bytes)?
        } else {
            open_mp4(&bytes)?
        };
        if samples.is_empty() {
            return Err(Error::msg("the video has no frames"));
        }
        let mut display: Vec<usize> = (0..samples.len()).collect();
        display.sort_by(|&a, &b| samples[a].pts.total_cmp(&samples[b].pts).then(a.cmp(&b)));
        let mut rank = vec![0; samples.len()];
        for (r, &d) in display.iter().enumerate() {
            rank[d] = r;
        }
        Ok(VideoReader {
            bytes,
            src,
            codec,
            samples,
            display,
            rank,
            rotation,
            coded,
            dec: None,
            next_feed: 0,
            last_out: None,
            ahead: Vec::new(),
            ahead_dims: (0, 0),
            last_frame: None,
        })
    }

    pub fn info(&self) -> VideoInfo {
        let (w, h) = if self.rotation % 2 == 1 {
            (self.coded.1, self.coded.0)
        } else {
            self.coded
        };
        let last = self.samples[*self.display.last().unwrap_or(&0)].pts;
        let first = self.samples[self.display[0]].pts;
        let step = if self.samples.len() > 1 {
            (last - first) / (self.samples.len() - 1) as f64
        } else {
            0.0
        };
        VideoInfo {
            width: w,
            height: h,
            duration: last + step,
            frames: self.samples.len(),
            codec: codec_name(&self.codec),
            rotation: self.rotation,
        }
    }

    /// Display ranks of the frames whose presentation time lies in [in_s, out_s).
    fn window(&self, in_s: f64, out_s: f64) -> (usize, usize) {
        let pts = |r: usize| self.samples[self.display[r]].pts;
        let n = self.display.len();
        let a = (0..n).find(|&r| pts(r) >= in_s - 1e-9).unwrap_or(n);
        let b = (a..n).find(|&r| pts(r) >= out_s - 1e-9).unwrap_or(n);
        (a, b)
    }

    /// Presentation times (seconds) of every frame in the trim window, in display order.
    pub fn frame_times(&self, in_s: f64, out_s: f64) -> Vec<f64> {
        let (a, b) = self.window(in_s, out_s);
        (a..b).map(|r| self.samples[self.display[r]].pts).collect()
    }

    /// RGBA frames `first .. first + count` of the trim window, each `w × h` (display
    /// orientation), concatenated.
    pub fn decode(
        &mut self,
        in_s: f64,
        out_s: f64,
        first: usize,
        count: usize,
        w: u32,
        h: u32,
    ) -> Result<Vec<u8>> {
        let (wa, wb) = self.window(in_s, out_s);
        let (a, b) = (wa + first, wa + first + count);
        if count == 0 || b > wb || w == 0 || h == 0 {
            return Err(Error::msg("frame range outside the clip"));
        }
        let fsz = w as usize * h as usize * 4;
        let mut out = vec![0u8; count * fsz];
        let mut filled = vec![false; count];

        if self.ahead_dims != (w, h) {
            self.ahead.clear();
            self.ahead_dims = (w, h);
        }
        self.ahead.retain(|(r, _)| *r >= a);
        for (r, px) in &self.ahead {
            if *r < b {
                out[(r - a) * fsz..(r - a + 1) * fsz].copy_from_slice(px);
                filled[r - a] = true;
            }
        }
        self.ahead.retain(|(r, _)| *r >= b);

        let lowest = match (0..count).find(|&k| !filled[k]) {
            Some(k) => a + k,
            None => return Ok(out),
        };
        let lo_decode = (lowest..b)
            .filter(|r| !filled[r - a])
            .map(|r| self.display[r])
            .min()
            .unwrap_or(self.display[lowest]);
        let key = self.keyframe_for(lo_decode, self.samples[self.display[lowest]].pts);
        let behind = self.last_out.is_some_and(|r| r >= lowest);
        if self.dec.is_none() || behind || key > self.next_feed {
            self.restart(key)?;
        }

        let mut missing = filled.iter().filter(|f| !**f).count();
        let mut first_err: Option<String> = None;
        while missing > 0 {
            let pics = if self.next_feed < self.samples.len() {
                let i = self.next_feed;
                self.next_feed += 1;
                let data = self.read_sample(i)?;
                // A damaged frame is skipped; its slot falls back to the previous picture.
                match self.decode_au(&data, i as i64) {
                    Ok(p) => p,
                    Err(e) => {
                        first_err.get_or_insert(e.0);
                        Vec::new()
                    }
                }
            } else {
                let pics = self.flush();
                self.dec = None;
                if pics.is_empty() {
                    break;
                }
                pics
            };
            for pic in pics {
                let d = pic.pts as usize;
                let Some(&r) = self.rank.get(d) else { continue };
                self.last_out = Some(self.last_out.map_or(r, |m| m.max(r)));
                if r >= a && r < b && !filled[r - a] {
                    let px = pic.to_rgba(w, h, self.rotation);
                    out[(r - a) * fsz..(r - a + 1) * fsz].copy_from_slice(&px);
                    filled[r - a] = true;
                    missing -= 1;
                } else if r >= b
                    && self.ahead.len() < AHEAD_MAX
                    && !self.ahead.iter().any(|(x, _)| *x == r)
                {
                    self.ahead.push((r, pic.to_rgba(w, h, self.rotation)));
                }
            }
        }
        // Not one picture, ever: an unsupported format (e.g. 4:4:4 / 10-bit H.264) — say so
        // rather than exporting black.
        if self.last_frame.is_none() && !filled.iter().any(|f| *f) {
            let why = first_err.unwrap_or_else(|| "no pictures decoded".into());
            return Err(Error::msg(format!(
                "this video can't be read ({}): {why}",
                codec_name(&self.codec)
            )));
        }
        // Never-decoded frames repeat the previous picture (black before the first).
        for k in 0..count {
            if filled[k] {
                self.last_frame = Some(out[k * fsz..(k + 1) * fsz].to_vec());
            } else if let Some(prev) = &self.last_frame
                && prev.len() == fsz
            {
                out[k * fsz..(k + 1) * fsz].copy_from_slice(prev);
            } else {
                for px in out[k * fsz..(k + 1) * fsz].chunks_exact_mut(4) {
                    px[3] = 255;
                }
            }
        }
        Ok(out)
    }

    /// The sync sample to start decoding from so frame `decode_idx` (shown at `pts`) and any
    /// open-GOP leading pictures around it decode cleanly.
    fn keyframe_for(&self, decode_idx: usize, pts: f64) -> usize {
        let syncs: Vec<usize> = self
            .samples
            .iter()
            .enumerate()
            .filter(|(_, s)| s.sync)
            .map(|(i, _)| i)
            .collect();
        let before = |i: usize| syncs.iter().rev().find(|&&s| s <= i).copied().unwrap_or(0);
        let mut k = before(decode_idx);
        while k > 0 && self.samples[k].pts > pts {
            k = before(k - 1);
        }
        k
    }

    fn restart(&mut self, from: usize) -> Result<()> {
        self.dec = Some(match &self.codec {
            Codec::H264(avcc) => Dec::H264(Box::new(
                filmcraft_h264::Decoder::from_avcc(avcc).map_err(Error::msg)?,
            )),
            Codec::Hevc(hvcc) => Dec::Hevc(Box::new(
                filmcraft_hevc::Decoder::from_hvcc(hvcc).map_err(Error::msg)?,
            )),
            Codec::Vp8 => Dec::Vp8(Box::new(filmcraft_vp8::Decoder::new())),
            Codec::Vp9 => Dec::Vp9(Box::new(filmcraft_vp9::Decoder::new())),
            Codec::Av1 => Dec::Av1(Box::new(filmcraft_av1::Decoder::new())),
        });
        self.next_feed = from;
        self.last_out = None;
        Ok(())
    }

    fn read_sample(&self, i: usize) -> Result<Vec<u8>> {
        match &self.src {
            Source::Mp4 { file, track } => file
                .read_sample(self.bytes.as_slice(), *track, i)
                .map_err(Error::msg),
            Source::Mkv { file, track } => file
                .read_sample(self.bytes.as_slice(), *track, i)
                .map_err(Error::msg),
        }
    }

    fn decode_au(&mut self, data: &[u8], pts: i64) -> Result<Vec<Pic>> {
        let Some(dec) = &mut self.dec else {
            return Ok(Vec::new());
        };
        Ok(match dec {
            Dec::H264(d) => d
                .decode(data, pts)
                .map_err(Error::msg)?
                .into_iter()
                .map(Pic::from_h264)
                .collect(),
            Dec::Hevc(d) => d
                .decode(data, pts)
                .map_err(Error::msg)?
                .into_iter()
                .map(Pic::from_hevc)
                .collect(),
            Dec::Vp8(d) => d
                .decode(data, pts)
                .map_err(Error::msg)?
                .into_iter()
                .map(Pic::from_vp8)
                .collect(),
            Dec::Vp9(d) => d
                .decode(data, pts)
                .map_err(Error::msg)?
                .into_iter()
                .map(Pic::from_vp9)
                .collect(),
            Dec::Av1(d) => d
                .decode_pts(data, pts)
                .map_err(Error::msg)?
                .into_iter()
                .map(Pic::from_av1)
                .collect(),
        })
    }

    fn flush(&mut self) -> Vec<Pic> {
        let Some(dec) = &mut self.dec else {
            return Vec::new();
        };
        match dec {
            Dec::H264(d) => d.flush().into_iter().map(Pic::from_h264).collect(),
            Dec::Hevc(d) => d.flush().into_iter().map(Pic::from_hevc).collect(),
            Dec::Vp8(_) => Vec::new(),
            Dec::Vp9(d) => d.flush().into_iter().map(Pic::from_vp9).collect(),
            Dec::Av1(d) => d.flush().into_iter().map(Pic::from_av1).collect(),
        }
    }
}

type Opened = (Source, Codec, Vec<SampleRef>, u8, (u32, u32));

fn open_mp4(bytes: &[u8]) -> Result<Opened> {
    let file = mp4::open(bytes).map_err(|e| Error::msg(format!("not a readable video: {e}")))?;
    let track = file
        .track_of_kind(mp4::TrackKind::Video)
        .ok_or_else(|| Error::msg("no video track"))?;
    let t = &file.tracks[track];
    let codec = match t.codec() {
        Some(mp4::CodecConfig::Avc(a)) => Codec::H264(a.to_bytes()),
        Some(mp4::CodecConfig::Hevc(h)) => Codec::Hevc(h.to_bytes()),
        Some(mp4::CodecConfig::Vp9(_)) => Codec::Vp9,
        Some(mp4::CodecConfig::Av1(_)) => Codec::Av1,
        other => {
            return Err(Error::msg(format!(
                "unsupported video codec: {}",
                other.map_or("unknown", |c| c.name())
            )));
        }
    };
    let ts = t.timescale.max(1) as f64;
    let samples = (0..t.samples.len())
        .map(|i| SampleRef {
            pts: t.presentation_pts(i).unwrap_or(0) as f64 / ts,
            sync: t.samples[i].is_sync,
        })
        .collect();
    let coded = t
        .video()
        .map(|v| (v.width as u32, v.height as u32))
        .unwrap_or((t.width, t.height));
    let rotation = t.display_rotation().unwrap_or(0);
    Ok((
        Source::Mp4 {
            file: Box::new(file),
            track,
        },
        codec,
        samples,
        rotation,
        coded,
    ))
}

fn open_mkv(bytes: &[u8]) -> Result<Opened> {
    let file = mkv::open(bytes).map_err(|e| Error::msg(format!("not a readable video: {e}")))?;
    let track = file
        .track_of_kind(mkv::TrackKind::Video)
        .ok_or_else(|| Error::msg("no video track"))?;
    let t = &file.tracks[track];
    let codec = match &t.codec {
        mkv::Codec::Avc { avcc } => Codec::H264(avcc.clone()),
        mkv::Codec::Hevc { hvcc } => Codec::Hevc(hvcc.clone()),
        mkv::Codec::Vp8 => Codec::Vp8,
        mkv::Codec::Vp9 { .. } => Codec::Vp9,
        mkv::Codec::Av1 { .. } => Codec::Av1,
        _ => {
            return Err(Error::msg(format!(
                "unsupported video codec: {}",
                t.codec_id
            )));
        }
    };
    let samples = t
        .samples
        .iter()
        .map(|s| SampleRef {
            pts: t.ticks_to_ns(s.pts) as f64 / 1e9,
            sync: s.keyframe,
        })
        .collect();
    let v = t.video.as_ref();
    let coded = v.map(|v| (v.pixel_width, v.pixel_height)).unwrap_or((0, 0));
    let rotation = v.and_then(|v| v.display_rotation()).unwrap_or(0);
    Ok((
        Source::Mkv {
            file: Box::new(file),
            track,
        },
        codec,
        samples,
        rotation,
        coded,
    ))
}

// ---------------------------------------------------------------------------------------------
// Decoded pictures → RGBA
// ---------------------------------------------------------------------------------------------

enum Plane {
    U8(Vec<u8>),
    U16(Vec<u16>),
    /// Monochrome chroma: neutral everywhere.
    Neutral,
}

struct Pic {
    w: usize,
    h: usize,
    cw: usize,
    ch: usize,
    depth: u32,
    y: Plane,
    u: Plane,
    v: Plane,
    ys: usize,
    uvs: usize,
    full_range: bool,
    /// H.273 matrix_coefficients (1 BT.709, 5/6 BT.601, 9/10 BT.2020, 2 unspecified).
    matrix: u8,
    pts: i64,
}

fn hevc_plane(p: filmcraft_hevc::Plane) -> Plane {
    match p {
        filmcraft_hevc::Plane::U8(v) => Plane::U8(v),
        filmcraft_hevc::Plane::U16(v) => Plane::U16(v),
    }
}

fn vp9_plane(p: filmcraft_vp9::Plane) -> Plane {
    match p {
        filmcraft_vp9::Plane::U8(v) => Plane::U8(v),
        filmcraft_vp9::Plane::U16(v) => Plane::U16(v),
    }
}

impl Pic {
    fn from_h264(p: filmcraft_h264::Picture) -> Pic {
        Pic {
            w: p.width as usize,
            h: p.height as usize,
            cw: p.chroma_width as usize,
            ch: p.chroma_height as usize,
            depth: 8,
            y: Plane::U8(p.y),
            u: Plane::U8(p.u),
            v: Plane::U8(p.v),
            ys: p.y_stride,
            uvs: p.uv_stride,
            full_range: p.color.full_range,
            matrix: p.color.matrix,
            pts: p.pts,
        }
    }

    fn from_hevc(p: filmcraft_hevc::Picture) -> Pic {
        Pic {
            w: p.width as usize,
            h: p.height as usize,
            cw: p.chroma_width as usize,
            ch: p.chroma_height as usize,
            depth: p.bit_depth,
            y: hevc_plane(p.y),
            u: hevc_plane(p.u),
            v: hevc_plane(p.v),
            ys: p.y_stride,
            uvs: p.uv_stride,
            full_range: p.color.full_range,
            matrix: p.color.matrix,
            pts: p.pts,
        }
    }

    fn from_vp8(p: filmcraft_vp8::Picture) -> Pic {
        Pic {
            w: p.width as usize,
            h: p.height as usize,
            cw: p.chroma_width as usize,
            ch: p.chroma_height as usize,
            depth: 8,
            ys: p.width as usize,
            uvs: p.chroma_width as usize,
            y: Plane::U8(p.y),
            u: Plane::U8(p.u),
            v: Plane::U8(p.v),
            full_range: false,
            matrix: 6,
            pts: p.pts,
        }
    }

    fn from_vp9(p: filmcraft_vp9::Picture) -> Pic {
        let matrix = match p.color.color_space {
            1 | 3 => 6,
            2 | 7 => 1,
            4 => 7,
            5 => 9,
            _ => 2,
        };
        Pic {
            w: p.width as usize,
            h: p.height as usize,
            cw: p.chroma_width as usize,
            ch: p.chroma_height as usize,
            depth: p.bit_depth,
            y: vp9_plane(p.y),
            u: vp9_plane(p.u),
            v: vp9_plane(p.v),
            ys: p.y_stride,
            uvs: p.uv_stride,
            full_range: p.color.full_range,
            matrix,
            pts: p.pts,
        }
    }

    fn from_av1(p: filmcraft_av1::Picture) -> Pic {
        let (cw, ch) = (p.plane_width(1) as usize, p.plane_height(1) as usize);
        let [y, u, v] = p.planes;
        let chroma = |pl: Vec<u16>| {
            if p.mono_chrome || pl.is_empty() {
                Plane::Neutral
            } else {
                Plane::U16(pl)
            }
        };
        Pic {
            w: p.width as usize,
            h: p.height as usize,
            cw,
            ch,
            depth: p.bit_depth as u32,
            ys: p.width as usize,
            uvs: cw,
            y: Plane::U16(y),
            u: chroma(u),
            v: chroma(v),
            full_range: p.full_range,
            matrix: p.matrix_coefficients,
            pts: p.pts,
        }
    }

    /// Sample of `plane` at (x, y) on the 8-bit scale.
    fn sample(&self, plane: &Plane, stride: usize, x: usize, y: usize) -> f32 {
        let s = 1.0 / (1u32 << (self.depth.saturating_sub(8))) as f32;
        match plane {
            Plane::U8(v) => v.get(y * stride + x).copied().unwrap_or(128) as f32,
            Plane::U16(v) => v.get(y * stride + x).copied().unwrap_or(0) as f32 * s,
            Plane::Neutral => 128.0,
        }
    }

    /// Convert to RGBA at `w × h` in DISPLAY orientation (rotation = clockwise quarter
    /// turns). Planes are resampled in Y'CbCr (a tent filter widened by the downscale
    /// factor — what ffmpeg's `scale=…:flags=bilinear` did), then converted.
    fn to_rgba(&self, w: u32, h: u32, rotation: u8) -> Vec<u8> {
        let (tw, th) = (w as usize, h as usize);
        let (sw, sh) = if rotation % 2 == 1 {
            (th, tw)
        } else {
            (tw, th)
        };
        let yp = resample(
            |x, y| self.sample(&self.y, self.ys, x, y),
            self.w,
            self.h,
            sw,
            sh,
        );
        let up = resample(
            |x, y| self.sample(&self.u, self.uvs, x, y),
            self.cw.max(1),
            self.ch.max(1),
            sw,
            sh,
        );
        let vp = resample(
            |x, y| self.sample(&self.v, self.uvs, x, y),
            self.cw.max(1),
            self.ch.max(1),
            sw,
            sh,
        );
        let (kr, kb) = match self.matrix {
            1 => (0.2126, 0.0722),
            5 | 6 => (0.299, 0.114),
            7 => (0.212, 0.087),
            9 | 10 => (0.2627, 0.0593),
            // Unspecified: what browsers assume — BT.709 for HD, BT.601 below.
            _ if self.h >= 720 => (0.2126, 0.0722),
            _ => (0.299, 0.114),
        };
        let kg = 1.0 - kr - kb;
        let mut out = vec![255u8; tw * th * 4];
        for y in 0..sh {
            for x in 0..sw {
                let i = y * sw + x;
                let (luma, cb, cr) = if self.full_range {
                    (yp[i], up[i] - 128.0, vp[i] - 128.0)
                } else {
                    (
                        (yp[i] - 16.0) * (255.0 / 219.0),
                        (up[i] - 128.0) * (255.0 / 224.0),
                        (vp[i] - 128.0) * (255.0 / 224.0),
                    )
                };
                let r = luma + 2.0 * (1.0 - kr) * cr;
                let b = luma + 2.0 * (1.0 - kb) * cb;
                let g = (luma - kr * r - kb * b) / kg;
                let (ox, oy) = match rotation % 4 {
                    1 => (sh - 1 - y, x),
                    2 => (sw - 1 - x, sh - 1 - y),
                    3 => (y, sw - 1 - x),
                    _ => (x, y),
                };
                let o = (oy * tw + ox) * 4;
                out[o] = to_u8(r);
                out[o + 1] = to_u8(g);
                out[o + 2] = to_u8(b);
            }
        }
        out
    }
}

#[inline]
fn to_u8(v: f32) -> u8 {
    (v + 0.5).clamp(0.0, 255.0) as u8
}

/// Per output coordinate: the source taps and their normalized weights.
fn taps(src: usize, dst: usize) -> Vec<Vec<(usize, f32)>> {
    let scale = src as f32 / dst as f32;
    let support = scale.max(1.0);
    (0..dst)
        .map(|o| {
            let center = (o as f32 + 0.5) * scale - 0.5;
            let lo = (center - support).ceil() as isize;
            let hi = (center + support).floor() as isize;
            let mut t: Vec<(usize, f32)> = (lo..=hi)
                .filter_map(|i| {
                    let wgt = 1.0 - ((i as f32 - center).abs() / support);
                    (wgt > 0.0).then(|| (i.clamp(0, src as isize - 1) as usize, wgt))
                })
                .collect();
            let sum: f32 = t.iter().map(|(_, w)| w).sum();
            if sum > 0.0 {
                t.iter_mut().for_each(|(_, w)| *w /= sum);
            } else {
                t = vec![(center.round().clamp(0.0, src as f32 - 1.0) as usize, 1.0)];
            }
            t
        })
        .collect()
}

/// Separable tent resample of a `sw × sh` sample grid to `dw × dh` (identity when equal).
fn resample(
    at: impl Fn(usize, usize) -> f32,
    sw: usize,
    sh: usize,
    dw: usize,
    dh: usize,
) -> Vec<f32> {
    let tx = taps(sw, dw);
    let ty = taps(sh, dh);
    // Only the source rows some output row touches are filtered horizontally.
    let mut rows: Vec<Option<Vec<f32>>> = vec![None; sh];
    for t in &ty {
        for &(sy, _) in t {
            if rows[sy].is_none() {
                rows[sy] = Some(
                    tx.iter()
                        .map(|t| t.iter().map(|&(sx, w)| at(sx, sy) * w).sum())
                        .collect(),
                );
            }
        }
    }
    let mut out = vec![0f32; dw * dh];
    for (oy, t) in ty.iter().enumerate() {
        for &(sy, w) in t {
            if let Some(row) = &rows[sy] {
                for ox in 0..dw {
                    out[oy * dw + ox] += row[ox] * w;
                }
            }
        }
    }
    out
}
