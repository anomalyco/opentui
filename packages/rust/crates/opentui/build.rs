use std::env;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    // opentui-sys exports these through its `links = "opentui"` metadata.
    let static_link = env::var("DEP_OPENTUI_STATIC").as_deref() == Ok("1");
    // Windows has no rpath; opentui-sys puts the DLL where `cargo run` and `cargo test` find it.
    let windows = env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows");
    if let (false, false, Ok(dir)) = (static_link, windows, env::var("DEP_OPENTUI_LIB_DIR")) {
        // Lets this package's tests and examples run in place. Downstream executables choose their own runtime
        // search path, or enable the `static` feature.
        println!("cargo:rustc-link-arg=-Wl,-rpath,{dir}");
    }
}
