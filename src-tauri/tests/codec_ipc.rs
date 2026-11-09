//! The IPC contract `src/platform/codec.ts` relies on, driven through Tauri's mock runtime:
//! camelCase JSON args, raw binary bodies + headers in, raw binary responses out.
use dithtill_lib::codec::*;
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{
    get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY,
};
use tauri::webview::InvokeRequest;
use tauri::{WebviewWindow, WebviewWindowBuilder};

fn app() -> (tauri::App<MockRuntime>, WebviewWindow<MockRuntime>) {
    let app = mock_builder()
        .manage(CodecState::default())
        .invoke_handler(tauri::generate_handler![
            codec_encoder_new,
            codec_encoder_frame,
            codec_encoder_audio,
            codec_encoder_finish,
            codec_encoder_abort,
            codec_video_open,
            codec_video_info,
            codec_video_times,
            codec_video_decode,
            codec_video_close,
            codec_audio_decode,
        ])
        .build(mock_context(noop_assets()))
        .expect("mock app");
    let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("mock webview");
    (app, webview)
}

fn call(
    w: &WebviewWindow<MockRuntime>,
    cmd: &str,
    body: InvokeBody,
    headers: &[(&'static str, String)],
) -> Result<InvokeResponseBody, serde_json::Value> {
    let mut h = tauri::http::HeaderMap::new();
    for (k, v) in headers {
        h.insert(*k, v.parse().expect("header"));
    }
    get_ipc_response(
        w,
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "http://tauri.localhost".parse().expect("url"),
            body,
            headers: h,
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
}

fn json(v: serde_json::Value) -> InvokeBody {
    InvokeBody::Json(v)
}

fn raw_of(r: Result<InvokeResponseBody, serde_json::Value>) -> Vec<u8> {
    match r.expect("command ok") {
        InvokeResponseBody::Raw(b) => b,
        InvokeResponseBody::Json(j) => panic!("expected raw bytes, got json {j}"),
    }
}

fn json_of(r: Result<InvokeResponseBody, serde_json::Value>) -> serde_json::Value {
    r.expect("command ok")
        .deserialize::<serde_json::Value>()
        .expect("json")
}

#[test]
fn encode_then_decode_through_ipc() {
    let (_app, w) = app();
    let (fw, fh) = (64u32, 48u32);
    let opts =
        serde_json::json!({ "opts": { "container": "mp4", "width": fw, "height": fh, "fps": 10 } });
    let id = json_of(call(&w, "codec_encoder_new", json(opts), &[]))
        .as_u64()
        .expect("encoder id");

    // 10 frames: an 8-bit index ramp shifting per frame, 256-entry grey palette.
    let palette: Vec<u8> = (0..=255u8).flat_map(|v| [v, v, v]).collect();
    for f in 0..10u32 {
        let mut body: Vec<u8> = (0..fw * fh).map(|i| ((i % fw) * 4 + f * 9) as u8).collect();
        let data_len = body.len();
        body.extend_from_slice(&palette);
        let meta = format!("{fw},{fh},8,{fw},{data_len},{}", palette.len());
        call(
            &w,
            "codec_encoder_frame",
            InvokeBody::Raw(body),
            &[("x-id", id.to_string()), ("x-frame", meta)],
        )
        .expect("frame");
    }
    // 1 s of stereo sound: left ‖ right halves.
    let n = 48_000;
    let mut audio = Vec::with_capacity(n * 8);
    for half in 0..2 {
        for i in 0..n {
            let v = 0.3 * ((i as f32) * 0.05 + half as f32).sin();
            audio.extend_from_slice(&v.to_le_bytes());
        }
    }
    call(
        &w,
        "codec_encoder_audio",
        InvokeBody::Raw(audio),
        &[("x-id", id.to_string()), ("x-rate", "48000".into())],
    )
    .expect("audio");
    let finish = serde_json::json!({ "id": id, "outPath": null });
    let mp4 = raw_of(call(&w, "codec_encoder_finish", json(finish), &[]));
    assert_eq!(&mp4[4..8], b"ftyp");

    // Read it back: open (raw body), info / times (camelCase args), decode (raw out).
    let vid = json_of(call(
        &w,
        "codec_video_open",
        InvokeBody::Raw(mp4.clone()),
        &[],
    ))
    .as_u64()
    .expect("video id");
    let info = json_of(call(
        &w,
        "codec_video_info",
        json(serde_json::json!({ "id": vid })),
        &[],
    ));
    assert_eq!(info["frames"], 10);
    assert_eq!(info["width"], fw);
    assert_eq!(info["codec"], "h264");
    let times = serde_json::json!({ "id": vid, "inS": 0.0, "outS": 99.0 });
    let times = json_of(call(&w, "codec_video_times", json(times), &[]));
    assert_eq!(times.as_array().map(Vec::len), Some(10));
    let dec = serde_json::json!({ "id": vid, "inS": 0.0, "outS": 99.0, "first": 2, "count": 3, "w": 32, "h": 24 });
    let px = raw_of(call(&w, "codec_video_decode", json(dec), &[]));
    assert_eq!(px.len(), 3 * 32 * 24 * 4);
    call(
        &w,
        "codec_video_close",
        json(serde_json::json!({ "id": vid })),
        &[],
    )
    .expect("close");

    // Audio: trimmed decode via header; an EMPTY body means "no audio stream".
    let pcm = raw_of(call(
        &w,
        "codec_audio_decode",
        InvokeBody::Raw(mp4),
        &[("x-rate", "48000".into()), ("x-trim", "0,0.5".into())],
    ));
    assert_eq!(pcm.len(), 24_000 * 2 * 4);
    let none = raw_of(call(
        &w,
        "codec_audio_decode",
        InvokeBody::Raw(b"not a media file at all".to_vec()),
        &[("x-rate", "48000".into())],
    ));
    assert!(none.is_empty());
}

#[test]
fn finish_writes_the_chosen_path_and_errors_reach_the_caller() {
    let (_app, w) = app();
    let opts =
        serde_json::json!({ "opts": { "container": "gif", "width": 8, "height": 8, "fps": 12 } });
    let id = json_of(call(&w, "codec_encoder_new", json(opts), &[]))
        .as_u64()
        .expect("id");
    let mut body = vec![0u8; 8]; // 1-bit, 8x8 → 1 byte per row
    body.extend_from_slice(&[0, 0, 0, 255, 255, 255]);
    call(
        &w,
        "codec_encoder_frame",
        InvokeBody::Raw(body),
        &[("x-id", id.to_string()), ("x-frame", "8,8,1,1,8,6".into())],
    )
    .expect("frame");
    let out = std::env::temp_dir().join(format!("dithtill-ipc-test-{}.gif", std::process::id()));
    let finish = serde_json::json!({ "id": id, "outPath": out.to_string_lossy() });
    let resp = raw_of(call(&w, "codec_encoder_finish", json(finish), &[]));
    assert!(resp.is_empty(), "the file goes to disk, not over IPC");
    let file = std::fs::read(&out).expect("written gif");
    let _ = std::fs::remove_file(&out);
    assert_eq!(&file[..6], b"GIF89a");

    // A codec error surfaces as the command's error value.
    let err = call(
        &w,
        "codec_video_open",
        InvokeBody::Raw(vec![1, 2, 3, 4, 5, 6, 7, 8, 9]),
        &[],
    );
    assert!(err.is_err());
    // GIF + a cycle is refused (long exports are MP4 only).
    let opts = serde_json::json!({ "opts": { "container": "gif", "width": 8, "height": 8, "fps": 12, "cycleFrames": 4, "cycleTotal": 9 } });
    assert!(call(&w, "codec_encoder_new", json(opts), &[]).is_err());
}
