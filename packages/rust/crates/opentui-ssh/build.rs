use std::env;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    // As in the opentui crate: opentui-sys exports these through its `links = "opentui"` metadata.
    let static_link = env::var("DEP_OPENTUI_STATIC").as_deref() == Ok("1");
    let windows = env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows");
    if let (false, false, Ok(dir)) = (static_link, windows, env::var("DEP_OPENTUI_LIB_DIR")) {
        // Lets this package's tests and examples run in place.
        println!("cargo:rustc-link-arg=-Wl,-rpath,{dir}");
    }
}
