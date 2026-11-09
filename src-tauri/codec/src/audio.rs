//! Audio decode for imports: a song file or a video's soundtrack → planar stereo f32 at the
//! app's pinned rate (core/loop-audio AUDIO_RATE), optionally trimmed to [in, out).
//!
//! Containers: MP4/M4A/MOV, Matroska/WebM, Ogg, FLAC, WAV, AIFF, MP3 and raw ADTS AAC.
//! Codecs: AAC + Opus (FilmCraft), MP3 (nanomp3), FLAC (claxon), Vorbis (lewton), PCM.
//! Encoder delay (MP4 edit lists, Opus pre-skip, LAME tags) is removed so sound lines up with
//! the picture. The resampler is a fixed polyphase windowed sinc, so the same file decodes to
//! the same samples on every machine and in every browser.

use std::io::Cursor;

use filmcraft_isobmff as mp4;
use filmcraft_matroska as mkv;

use crate::{Error, Result};

/// Decoded audio at its native rate. `channels` are planar.
struct Pcm {
    rate: u32,
    channels: Vec<Vec<f32>>,
    order: Order,
}

/// Channel order of multichannel sources (for the stereo downmix).
#[derive(Clone, Copy)]
enum Order {
    /// WAV / SMPTE: FL FR FC LFE BL BR …
    Wav,
    /// AAC channel configurations: FC FL FR (BL BR) LFE …
    Aac,
    /// Vorbis / Opus family 1: FL FC FR BL BR LFE …
    Vorbis,
}

/// Planar stereo at `rate`, or None when the file has no audio stream.
pub fn decode_audio(
    bytes: &[u8],
    trim: Option<(f64, f64)>,
    rate: u32,
) -> Result<Option<(Vec<f32>, Vec<f32>)>> {
    let Some(pcm) = decode_native(bytes)? else {
        return Ok(None);
    };
    if pcm.rate == 0 || pcm.channels.is_empty() {
        return Ok(None);
    }
    let (mut l, mut r) = to_stereo(pcm.channels, pcm.order);
    if let Some((a, b)) = trim {
        let n = l.len();
        let s = ((a.max(0.0) * pcm.rate as f64).round() as usize).min(n);
        let e = ((b.max(a) * pcm.rate as f64).round() as usize).clamp(s, n);
        l = l[s..e].to_vec();
        r = r[s..e].to_vec();
    }
    Ok(Some((
        resample(&l, pcm.rate, rate),
        resample(&r, pcm.rate, rate),
    )))
}

fn decode_native(b: &[u8]) -> Result<Option<Pcm>> {
    if crate::is_matroska(b) {
        return decode_mkv(b);
    }
    if crate::is_isobmff(b) {
        return decode_mp4(b);
    }
    if b.starts_with(b"OggS") {
        return decode_ogg(b);
    }
    if b.starts_with(b"fLaC") {
        return decode_flac(b).map(Some);
    }
    if b.len() >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WAVE" {
        return decode_wav(b).map(Some);
    }
    if b.len() >= 12 && &b[0..4] == b"FORM" && (&b[8..12] == b"AIFF" || &b[8..12] == b"AIFC") {
        return decode_aiff(b).map(Some);
    }
    if b.len() >= 2 && b[0] == 0xFF && b[1] & 0xF6 == 0xF0 {
        return decode_adts(b).map(Some);
    }
    decode_mp3(b)
}

// ---------------------------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------------------------

fn decode_mp4(b: &[u8]) -> Result<Option<Pcm>> {
    let file = mp4::open(b).map_err(|e| Error::msg(format!("not a readable file: {e}")))?;
    let Some(ti) = file.track_of_kind(mp4::TrackKind::Audio) else {
        return Ok(None);
    };
    let t = &file.tracks[ti];
    let samples = || (0..t.samples.len()).map(|i| file.read_sample(b, ti, i).map_err(Error::msg));
    let mut pcm = match t.codec() {
        Some(mp4::CodecConfig::Aac(c)) => decode_aac_packets(&c.asc, samples())?,
        Some(mp4::CodecConfig::Opus(c)) => {
            let mut head = b"OpusHead".to_vec();
            head.push(1);
            head.push(c.output_channels);
            head.extend_from_slice(&c.pre_skip.to_le_bytes());
            head.extend_from_slice(&c.input_sample_rate.to_le_bytes());
            head.extend_from_slice(&c.output_gain.to_le_bytes());
            head.push(c.channel_mapping_family);
            head.extend_from_slice(&c.channel_mapping);
            // The edit list below removes the pre-skip.
            decode_opus_packets(&head, false, samples())?
        }
        Some(mp4::CodecConfig::Mp3) => {
            let mut all = Vec::new();
            for s in samples() {
                all.extend(s?);
            }
            return decode_mp3(&all);
        }
        Some(mp4::CodecConfig::Flac(c)) => {
            let mut all = b"fLaC".to_vec();
            all.extend_from_slice(&c.metadata_blocks);
            for s in samples() {
                all.extend(s?);
            }
            decode_flac(&all)?
        }
        Some(mp4::CodecConfig::Pcm(c)) => {
            let mut all = Vec::new();
            for s in samples() {
                all.extend(s?);
            }
            let fmt = PcmFmt {
                bits: c.bits,
                float: c.float,
                big_endian: c.big_endian,
                signed: c.signed || c.bits > 8,
            };
            pcm_from_bytes(
                &all,
                c.channels.max(1) as usize,
                c.sample_rate.round() as u32,
                fmt,
            )
        }
        other => {
            return Err(Error::msg(format!(
                "unsupported audio codec: {}",
                other.map_or("unknown", |c| c.name())
            )));
        }
    };
    // Edit list: samples before presentation time 0 are encoder delay (AAC priming / Opus pre-skip).
    if t.edit_offset < 0 && t.timescale > 0 {
        let skip = (-t.edit_offset) as u64 * pcm.rate as u64 / t.timescale as u64;
        skip_front(&mut pcm, skip as usize);
    }
    Ok(Some(pcm))
}

fn decode_mkv(b: &[u8]) -> Result<Option<Pcm>> {
    let file = mkv::open(b).map_err(|e| Error::msg(format!("not a readable file: {e}")))?;
    let Some(ti) = file.track_of_kind(mkv::TrackKind::Audio) else {
        return Ok(None);
    };
    let t = &file.tracks[ti];
    let samples = || (0..t.samples.len()).map(|i| file.read_sample(b, ti, i).map_err(Error::msg));
    let concat = || -> Result<Vec<u8>> {
        let mut all = Vec::new();
        for s in samples() {
            all.extend(s?);
        }
        Ok(all)
    };
    let pcm = match &t.codec {
        mkv::Codec::Aac { asc } => decode_aac_packets(asc, samples())?,
        mkv::Codec::Opus { head } => decode_opus_packets(head, true, samples())?,
        mkv::Codec::Vorbis { headers } => decode_vorbis_packets(headers, samples())?,
        mkv::Codec::Flac { private } => {
            let mut all = private.clone();
            all.extend(concat()?);
            decode_flac(&all)?
        }
        mkv::Codec::Mp3 | mkv::Codec::Mp2 | mkv::Codec::Mp1 => return decode_mp3(&concat()?),
        mkv::Codec::Pcm {
            float,
            big_endian,
            bits,
        } => {
            let a = t
                .audio
                .as_ref()
                .ok_or_else(|| Error::msg("PCM track without audio info"))?;
            let fmt = PcmFmt {
                bits: *bits,
                float: *float,
                big_endian: *big_endian,
                signed: *bits > 8,
            };
            pcm_from_bytes(
                &concat()?,
                a.channels.max(1) as usize,
                a.sampling_frequency.round() as u32,
                fmt,
            )
        }
        _ => {
            return Err(Error::msg(format!(
                "unsupported audio codec: {}",
                t.codec_id
            )));
        }
    };
    Ok(Some(pcm))
}

fn decode_ogg(b: &[u8]) -> Result<Option<Pcm>> {
    let file =
        filmcraft_ogg::open(b).map_err(|e| Error::msg(format!("not a readable file: {e}")))?;
    let Some(s) = file.streams.iter().find(|s| {
        matches!(
            s.codec,
            filmcraft_ogg::Codec::Opus | filmcraft_ogg::Codec::Vorbis
        )
    }) else {
        return Ok(None);
    };
    let packets = s.packets.iter().map(|p| {
        let mut data = Vec::with_capacity(p.size as usize);
        for &(off, len) in &p.parts {
            let (o, l) = (off as usize, len as usize);
            data.extend_from_slice(
                b.get(o..o + l)
                    .ok_or_else(|| Error::msg("truncated Ogg packet"))?,
            );
        }
        Ok(data)
    });
    let pcm = match s.codec {
        filmcraft_ogg::Codec::Opus => {
            let head = s
                .headers
                .first()
                .ok_or_else(|| Error::msg("Opus stream without a header"))?;
            decode_opus_packets(head, true, packets)?
        }
        _ => decode_vorbis_packets(&s.headers, packets)?,
    };
    Ok(Some(pcm))
}

// ---------------------------------------------------------------------------------------------
// Codecs
// ---------------------------------------------------------------------------------------------

fn decode_aac_packets(asc: &[u8], packets: impl Iterator<Item = Result<Vec<u8>>>) -> Result<Pcm> {
    let mut dec = filmcraft_aac::Decoder::new(asc).map_err(Error::msg)?;
    let mut ch: Vec<Vec<f32>> = vec![Vec::new(); dec.channels().max(1)];
    for p in packets {
        // A damaged frame decodes as silence of the usual length rather than ending the song.
        match dec.decode(&p?) {
            Ok(frame) => append(&mut ch, frame),
            Err(_) => {
                let n = if dec.sbr() { 2048 } else { 1024 };
                ch.iter_mut()
                    .for_each(|c| c.extend(std::iter::repeat_n(0.0, n)));
            }
        }
    }
    Ok(Pcm {
        rate: dec.sample_rate(),
        channels: ch,
        order: Order::Aac,
    })
}

fn decode_adts(b: &[u8]) -> Result<Pcm> {
    let frames = filmcraft_aac::split_adts(b).map_err(Error::msg)?;
    let (h, _) = frames.first().ok_or_else(|| Error::msg("no AAC frames"))?;
    let mut dec = filmcraft_aac::Decoder::from_adts(h).map_err(Error::msg)?;
    let mut ch: Vec<Vec<f32>> = vec![Vec::new(); dec.channels().max(1)];
    for (_, payload) in &frames {
        if let Ok(frame) = dec.decode(payload) {
            append(&mut ch, frame);
        }
    }
    Ok(Pcm {
        rate: dec.sample_rate(),
        channels: ch,
        order: Order::Aac,
    })
}

fn decode_opus_packets(
    head: &[u8],
    trim_pre_skip: bool,
    packets: impl Iterator<Item = Result<Vec<u8>>>,
) -> Result<Pcm> {
    let mut dec = filmcraft_opus::Decoder::new(head).map_err(Error::msg)?;
    dec.set_trim_pre_skip(trim_pre_skip);
    let mut ch: Vec<Vec<f32>> = vec![Vec::new(); dec.channels().max(1)];
    for p in packets {
        let p = p?;
        // A damaged packet is concealed by the decoder (packet loss).
        let frame = dec
            .decode(Some(&p))
            .or_else(|_| dec.decode(None))
            .map_err(Error::msg)?;
        append(&mut ch, frame);
    }
    Ok(Pcm {
        rate: dec.sample_rate(),
        channels: ch,
        order: Order::Vorbis,
    })
}

fn decode_vorbis_packets(
    headers: &[Vec<u8>],
    packets: impl Iterator<Item = Result<Vec<u8>>>,
) -> Result<Pcm> {
    if headers.len() < 3 {
        return Err(Error::msg("Vorbis stream without its headers"));
    }
    let ident =
        lewton::header::read_header_ident(&headers[0]).map_err(|e| Error::msg(format!("{e:?}")))?;
    let setup = lewton::header::read_header_setup(
        &headers[2],
        ident.audio_channels,
        (ident.blocksize_0, ident.blocksize_1),
    )
    .map_err(|e| Error::msg(format!("{e:?}")))?;
    let mut pwr = lewton::audio::PreviousWindowRight::new();
    let mut ch: Vec<Vec<f32>> = vec![Vec::new(); ident.audio_channels.max(1) as usize];
    for p in packets {
        let p = p?;
        if let Ok(frame) =
            lewton::audio::read_audio_packet_generic::<Vec<Vec<f32>>>(&ident, &setup, &p, &mut pwr)
        {
            append(&mut ch, frame);
        }
    }
    Ok(Pcm {
        rate: ident.audio_sample_rate,
        channels: ch,
        order: Order::Vorbis,
    })
}

fn decode_mp3(b: &[u8]) -> Result<Option<Pcm>> {
    let d = nanomp3::decode_all::<f32>(b);
    let Some(chans) = d.channels else {
        return Ok(None);
    };
    let n = chans.num() as usize;
    if n == 0 || d.sample_rate == 0 || d.samples.is_empty() {
        return Ok(None);
    }
    Ok(Some(Pcm {
        rate: d.sample_rate,
        channels: deinterleave(&d.samples, n),
        order: Order::Wav,
    }))
}

fn decode_flac(b: &[u8]) -> Result<Pcm> {
    let mut r =
        claxon::FlacReader::new(Cursor::new(b)).map_err(|e| Error::msg(format!("FLAC: {e}")))?;
    let info = r.streaminfo();
    let n = info.channels as usize;
    let scale = 1.0 / (1u64 << (info.bits_per_sample - 1)) as f32;
    let mut inter = Vec::new();
    for s in r.samples() {
        match s {
            Ok(v) => inter.push(v as f32 * scale),
            // A damaged tail ends the song where the good audio ends.
            Err(_) => break,
        }
    }
    inter.truncate(inter.len() / n * n);
    Ok(Pcm {
        rate: info.sample_rate,
        channels: deinterleave(&inter, n),
        order: Order::Wav,
    })
}

#[derive(Clone, Copy)]
struct PcmFmt {
    bits: u16,
    float: bool,
    big_endian: bool,
    signed: bool,
}

fn pcm_from_bytes(data: &[u8], channels: usize, rate: u32, f: PcmFmt) -> Pcm {
    let bps = (f.bits as usize).div_ceil(8).max(1);
    let frames = data.len() / (bps * channels);
    let mut ch = vec![Vec::with_capacity(frames); channels];
    for i in 0..frames {
        for (c, out) in ch.iter_mut().enumerate() {
            let o = (i * channels + c) * bps;
            let s = &data[o..o + bps];
            let mut raw = [0u8; 8];
            if f.big_endian {
                for k in 0..bps {
                    raw[k] = s[bps - 1 - k];
                }
            } else {
                raw[..bps].copy_from_slice(s);
            }
            let v = match (f.float, bps) {
                (true, 4) => f32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]),
                (true, 8) => f64::from_le_bytes(raw) as f32,
                (_, 1) if !f.signed => (raw[0] as f32 - 128.0) / 128.0,
                _ => {
                    let u = u64::from_le_bytes(raw);
                    let shift = 64 - bps * 8;
                    let signed = ((u << shift) as i64) >> shift;
                    signed as f32 / (1u64 << (bps * 8 - 1)) as f32
                }
            };
            out.push(v);
        }
    }
    Pcm {
        rate,
        channels: ch,
        order: Order::Wav,
    }
}

fn decode_wav(b: &[u8]) -> Result<Pcm> {
    let mut pos = 12;
    let mut fmt: Option<(u16, usize, u32, u16)> = None;
    while pos + 8 <= b.len() {
        let id = &b[pos..pos + 4];
        let len = u32::from_le_bytes([b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]]) as usize;
        let body = &b[pos + 8..(pos + 8 + len).min(b.len())];
        if id == b"fmt " && body.len() >= 16 {
            let mut tag = u16::from_le_bytes([body[0], body[1]]);
            let channels = u16::from_le_bytes([body[2], body[3]]) as usize;
            let rate = u32::from_le_bytes([body[4], body[5], body[6], body[7]]);
            let bits = u16::from_le_bytes([body[14], body[15]]);
            if tag == 0xFFFE && body.len() >= 26 {
                tag = u16::from_le_bytes([body[24], body[25]]);
            }
            fmt = Some((tag, channels, rate, bits));
        } else if id == b"data" {
            let (tag, channels, rate, bits) =
                fmt.ok_or_else(|| Error::msg("WAV without a format chunk"))?;
            if tag != 1 && tag != 3 {
                return Err(Error::msg("compressed WAV is not supported"));
            }
            return Ok(pcm_from_bytes(
                body,
                channels.max(1),
                rate,
                PcmFmt {
                    bits,
                    float: tag == 3,
                    big_endian: false,
                    signed: bits > 8,
                },
            ));
        }
        pos += 8 + len + (len & 1);
    }
    Err(Error::msg("WAV without audio data"))
}

/// 80-bit IEEE extended → f64 (AIFF sample rates).
fn extended_to_f64(e: &[u8]) -> f64 {
    let exp = (((e[0] as i32) & 0x7F) << 8) | e[1] as i32;
    let mant = u64::from_be_bytes([e[2], e[3], e[4], e[5], e[6], e[7], e[8], e[9]]);
    if exp == 0 && mant == 0 {
        return 0.0;
    }
    let sign = if e[0] & 0x80 != 0 { -1.0 } else { 1.0 };
    sign * mant as f64 * 2f64.powi(exp - 16383 - 63)
}

fn decode_aiff(b: &[u8]) -> Result<Pcm> {
    let aifc = &b[8..12] == b"AIFC";
    let mut pos = 12;
    let mut comm: Option<(usize, u16, u32, PcmFmt)> = None;
    while pos + 8 <= b.len() {
        let id = &b[pos..pos + 4];
        let len = u32::from_be_bytes([b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]]) as usize;
        let body = &b[pos + 8..(pos + 8 + len).min(b.len())];
        if id == b"COMM" && body.len() >= 18 {
            let channels = u16::from_be_bytes([body[0], body[1]]) as usize;
            let bits = u16::from_be_bytes([body[6], body[7]]);
            let rate = extended_to_f64(&body[8..18]).round() as u32;
            let mut fmt = PcmFmt {
                bits,
                float: false,
                big_endian: true,
                signed: true,
            };
            if aifc && body.len() >= 22 {
                match &body[18..22] {
                    b"NONE" | b"twos" => {}
                    b"sowt" => fmt.big_endian = false,
                    b"fl32" | b"FL32" => {
                        fmt = PcmFmt {
                            bits: 32,
                            float: true,
                            big_endian: true,
                            signed: true,
                        }
                    }
                    b"fl64" | b"FL64" => {
                        fmt = PcmFmt {
                            bits: 64,
                            float: true,
                            big_endian: true,
                            signed: true,
                        }
                    }
                    _ => return Err(Error::msg("compressed AIFF is not supported")),
                }
            }
            comm = Some((channels, bits, rate, fmt));
        } else if id == b"SSND" && body.len() >= 8 {
            let (channels, _, rate, fmt) =
                comm.ok_or_else(|| Error::msg("AIFF without a COMM chunk"))?;
            let offset = u32::from_be_bytes([body[0], body[1], body[2], body[3]]) as usize;
            let data = body.get(8 + offset..).unwrap_or(&[]);
            return Ok(pcm_from_bytes(data, channels.max(1), rate, fmt));
        }
        pos += 8 + len + (len & 1);
    }
    Err(Error::msg("AIFF without audio data"))
}

// ---------------------------------------------------------------------------------------------
// Sample plumbing
// ---------------------------------------------------------------------------------------------

fn append(ch: &mut Vec<Vec<f32>>, frame: Vec<Vec<f32>>) {
    if frame.is_empty() {
        return;
    }
    if ch.len() < frame.len() {
        let n = ch.first().map_or(0, Vec::len);
        ch.resize(frame.len(), vec![0.0; n]);
    }
    for (c, f) in ch.iter_mut().zip(frame) {
        c.extend(f);
    }
}

fn deinterleave(inter: &[f32], n: usize) -> Vec<Vec<f32>> {
    (0..n)
        .map(|c| inter.iter().skip(c).step_by(n).copied().collect())
        .collect()
}

fn skip_front(p: &mut Pcm, n: usize) {
    for c in &mut p.channels {
        c.drain(..n.min(c.len()));
    }
}

/// Planar channels → stereo: mono is duplicated (as browsers play it); surround folds the centre
/// and rear in at −3 dB, unscaled — ffmpeg's `-ac 2` mix, so levels match earlier imports.
fn to_stereo(mut ch: Vec<Vec<f32>>, order: Order) -> (Vec<f32>, Vec<f32>) {
    match ch.len() {
        1 => {
            let m = ch.pop().unwrap_or_default();
            (m.clone(), m)
        }
        2 => {
            let r = ch.pop().unwrap_or_default();
            let l = ch.pop().unwrap_or_default();
            (l, r)
        }
        n => {
            // (left, right, centre, rear-left, rear-right) per layout.
            let (l, r, c, bl, br) = match order {
                Order::Wav => (0, 1, Some(2), (n >= 6).then_some(4), (n >= 6).then_some(5)),
                Order::Aac => (1, 2, Some(0), (n >= 5).then_some(3), (n >= 5).then_some(4)),
                Order::Vorbis => (0, 2, Some(1), (n >= 5).then_some(3), (n >= 5).then_some(4)),
            };
            let len = ch.iter().map(Vec::len).min().unwrap_or(0);
            let k = std::f32::consts::FRAC_1_SQRT_2;
            let at = |i: Option<usize>, s: usize| i.and_then(|i| ch.get(i)).map_or(0.0, |c| c[s]);
            let left = (0..len)
                .map(|s| ch[l][s] + k * at(c, s) + k * at(bl, s))
                .collect();
            let right = (0..len)
                .map(|s| ch[r][s] + k * at(c, s) + k * at(br, s))
                .collect();
            (left, right)
        }
    }
}

fn gcd(a: u64, b: u64) -> u64 {
    if b == 0 { a } else { gcd(b, a % b) }
}

/// Zero crossings of the sinc on each side of the filter centre.
const SINC_ZEROS: f64 = 16.0;

/// Band-limited resample `from` → `to` Hz: a Blackman-windowed sinc evaluated on a polyphase
/// table (exact for any rational ratio up to 4096 phases, computed per sample beyond).
pub fn resample(x: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || x.is_empty() {
        return x.to_vec();
    }
    let g = gcd(from as u64, to as u64);
    let (up, down) = (to as u64 / g, from as u64 / g);
    let cutoff = (to as f64 / from as f64).min(1.0) * 0.97;
    let half = (SINC_ZEROS / cutoff).ceil() as i64;
    let kernel = |t: f64| -> f64 {
        let w = t / half as f64;
        if w.abs() >= 1.0 {
            return 0.0;
        }
        let win = 0.42
            + 0.5 * (std::f64::consts::PI * w).cos()
            + 0.08 * (2.0 * std::f64::consts::PI * w).cos();
        let a = std::f64::consts::PI * cutoff * t;
        let sinc = if a.abs() < 1e-12 { 1.0 } else { a.sin() / a };
        cutoff * sinc * win
    };
    let taps = (2 * half) as usize;
    let table: Option<Vec<f32>> = (up <= 4096).then(|| {
        let mut t = vec![0f32; up as usize * taps];
        for p in 0..up as usize {
            let frac = p as f64 / up as f64;
            for k in 0..taps {
                t[p * taps + k] = kernel((k as i64 - half + 1) as f64 - frac) as f32;
            }
        }
        t
    });
    let n_out = (x.len() as u64 * up).div_ceil(down) as usize;
    let last = x.len() as i64 - 1;
    let mut out = Vec::with_capacity(n_out);
    for n in 0..n_out as u64 {
        let pos = n * down;
        let i = (pos / up) as i64;
        let p = (pos % up) as usize;
        let mut acc = 0f32;
        let base = i - half + 1;
        match &table {
            Some(t) => {
                let row = &t[p * taps..(p + 1) * taps];
                if base >= 0 && base + taps as i64 - 1 <= last {
                    let s = &x[base as usize..base as usize + taps];
                    for k in 0..taps {
                        acc += s[k] * row[k];
                    }
                } else {
                    for (k, w) in row.iter().enumerate() {
                        let j = base + k as i64;
                        if (0..=last).contains(&j) {
                            acc += x[j as usize] * w;
                        }
                    }
                }
            }
            None => {
                let frac = p as f64 / up as f64;
                for k in 0..taps as i64 {
                    let j = base + k;
                    if (0..=last).contains(&j) {
                        acc += x[j as usize] * kernel((k - half + 1) as f64 - frac) as f32;
                    }
                }
            }
        }
        out.push(acc);
    }
    out
}
