use std::{env, path::PathBuf, process::Command};

fn main() {
    assert_eq!(
        env::var("TARGET").unwrap(),
        "x86_64-unknown-linux-gnu",
        "this example binding currently supports Linux x86_64 glibc only"
    );
    assert_eq!(
        env::var("HOST").unwrap(),
        env::var("TARGET").unwrap(),
        "cross-compilation is not supported by this example binding"
    );
    println!("cargo:rerun-if-env-changed=OPENTUI_LIB_DIR");
    println!("cargo:rerun-if-env-changed=CC");
    println!("cargo:rerun-if-changed=build.rs");
    let library = env::var_os("OPENTUI_LIB_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../../lib/x86_64-linux"));
    let library = library
        .canonicalize()
        .expect("set OPENTUI_LIB_DIR to existing native artifacts, or run bun run build at the repository root");
    let static_link = env::var_os("CARGO_FEATURE_STATIC").is_some();
    for file in ["opentui.h", if static_link { "libopentui.a" } else { "libopentui.so" }] {
        let path = library.join(file);
        assert!(path.is_file(), "missing native artifact: {}", path.display());
        println!("cargo:rerun-if-changed={}", path.display());
    }
    println!("cargo:rustc-env=OPENTUI_LIB_DIR={}", library.display());
    println!("cargo:rustc-link-search=native={}", library.display());
    if static_link {
        println!("cargo:rustc-link-lib=static=opentui");
        for name in ["c++", "c++abi", "m", "dl", "pthread"] {
            println!("cargo:rustc-link-lib={name}");
        }
    } else {
        println!("cargo:rustc-link-lib=dylib=opentui");
        // This package's tests/examples can run in place. Downstream executables
        // configure their own runtime search path, such as LD_LIBRARY_PATH.
        println!("cargo:rustc-link-arg=-Wl,-rpath,{}", library.display());
    }
    if env::var_os("CARGO_FEATURE_TERMINAL_EXAMPLE").is_some() {
        println!("cargo:rerun-if-changed=examples/terminal.c");
        let object = PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("terminal.o");
        let status = Command::new(env::var_os("CC").unwrap_or_else(|| "cc".into()))
            .args(["-std=c11", "-Wall", "-Wextra", "-Werror", "-c", "examples/terminal.c", "-o"])
            .arg(&object)
            .status()
            .expect("compile example terminal transport");
        assert!(status.success(), "example terminal transport compilation failed");
        println!("cargo:rustc-link-arg-examples={}", object.display());
    }
}
