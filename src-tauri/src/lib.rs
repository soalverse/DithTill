pub mod codec;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Logging: always write to a file in the OS app-log dir; also
    // mirror to stdout + the webview console in debug builds.
    let mut log_builder = tauri_plugin_log::Builder::new()
        .level(log::LevelFilter::Info)
        .target(tauri_plugin_log::Target::new(
            tauri_plugin_log::TargetKind::LogDir {
                file_name: Some("dithtill".into()),
            },
        ));
    if cfg!(debug_assertions) {
        log_builder = log_builder
            .target(tauri_plugin_log::Target::new(
                tauri_plugin_log::TargetKind::Stdout,
            ))
            .target(tauri_plugin_log::Target::new(
                tauri_plugin_log::TargetKind::Webview,
            ));
    }

    tauri::Builder::default()
        .plugin(log_builder.build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(codec::CodecState::default())
        .invoke_handler(tauri::generate_handler![
            codec::codec_encoder_new,
            codec::codec_encoder_frame,
            codec::codec_encoder_audio,
            codec::codec_encoder_finish,
            codec::codec_encoder_abort,
            codec::codec_video_open,
            codec::codec_video_info,
            codec::codec_video_times,
            codec::codec_video_decode,
            codec::codec_video_close,
            codec::codec_audio_decode,
        ])
        .setup(|_app| {
            log::info!("DithTill {} starting", env!("CARGO_PKG_VERSION"));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
