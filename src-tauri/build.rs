fn main() {
    // The codec IPC unit tests (src/codec.rs) spin up Tauri's mock runtime, which links
    // comctl32 v6 APIs; Windows resolves those only with the Common-Controls manifest, and
    // tauri-build embeds it into the APP binary alone — without it the test exe dies with
    // STATUS_ENTRYPOINT_NOT_FOUND. Test targets only; the shipped app is unchanged.
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg-tests=/MANIFESTDEPENDENCY:type='win32' \
             name='Microsoft.Windows.Common-Controls' version='6.0.0.0' \
             processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
        );
    }
    tauri_build::build()
}
