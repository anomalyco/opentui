use std::{env, fs, path::PathBuf};

/// The directory OpenTUI's build puts a target's artifacts in, under `packages/native/lib`, and its shared library.
fn platform(target: &str) -> Option<(&'static str, &'static str)> {
    match target {
        "x86_64-unknown-linux-gnu" => Some(("x86_64-linux", "libopentui.so")),
        "aarch64-apple-darwin" => Some(("aarch64-macos", "libopentui.dylib")),
        "x86_64-apple-darwin" => Some(("x86_64-macos", "libopentui.dylib")),
        "x86_64-pc-windows-msvc" | "x86_64-pc-windows-gnu" => Some(("x86_64-windows", "opentui.dll")),
        _ => None,
    }
}

fn native_lib_dir(platform: &str) -> PathBuf {
    if let Some(dir) = env::var_os("OPENTUI_LIB_DIR") {
        return PathBuf::from(dir);
    }
    if let Some(root) = env::var_os("OPENTUI_ROOT") {
        return PathBuf::from(root).join("packages/native/lib").join(platform);
    }
    panic!("set OPENTUI_LIB_DIR to OpenTUI's packages/native/lib/{platform}, or OPENTUI_ROOT to an OpenTUI checkout");
}

// Must match fnv1a64 in scripts/generate-ffi.ts.
fn fnv1a64(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, &byte| (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3))
}

fn generated_header_hash() -> u64 {
    let generated = fs::read_to_string("src/generated.rs").expect("read src/generated.rs");
    let prefix = "pub const OPENTUI_HEADER_FNV1A64: u64 = 0x";
    let line = generated.lines().find_map(|line| line.strip_prefix(prefix)).expect("generated header hash");
    u64::from_str_radix(line.trim_end_matches(';').replace('_', "").as_str(), 16).expect("hexadecimal header hash")
}

fn main() {
    let target = env::var("TARGET").unwrap();
    let Some((platform, shared_library)) = platform(&target) else {
        panic!(
            "opentui-sys supports x86_64-unknown-linux-gnu, aarch64-apple-darwin, x86_64-apple-darwin, \
             x86_64-pc-windows-msvc, and x86_64-pc-windows-gnu, not {target}"
        );
    };
    let windows = target.contains("-windows-");
    println!("cargo:rerun-if-env-changed=OPENTUI_LIB_DIR");
    println!("cargo:rerun-if-env-changed=OPENTUI_ROOT");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=src/generated.rs");
    let library = native_lib_dir(platform)
        .canonicalize()
        .expect("set OPENTUI_LIB_DIR or OPENTUI_ROOT to existing OpenTUI native artifacts");
    let static_link = env::var_os("CARGO_FEATURE_STATIC").is_some();
    // OpenTUI's Windows archive is built for MinGW with libc++, which neither Rust Windows toolchain links.
    assert!(!(windows && static_link), "the static feature is not supported on Windows; link opentui.dll instead");
    // Windows links a DLL through its import library.
    let files: &[&str] = if static_link {
        &["opentui.h", "libopentui.a"]
    } else if windows {
        &["opentui.h", shared_library, "opentui.lib"]
    } else {
        &["opentui.h", shared_library]
    };
    for file in files {
        let path = library.join(file);
        assert!(path.is_file(), "missing native artifact: {}", path.display());
        println!("cargo:rerun-if-changed={}", path.display());
    }

    // The declarations are only valid for the exact header they were generated from.
    let header = fs::read(library.join("opentui.h")).expect("read opentui.h");
    let expected = generated_header_hash();
    let actual = fnv1a64(&header);
    assert_eq!(
        actual,
        expected,
        "{} differs from the header src/generated.rs was generated from \
         (hash {actual:#018x}, expected {expected:#018x}). Rebuild OpenTUI or regenerate with \
         `OPENTUI_ROOT=/path/to/opentui bun scripts/generate-ffi.ts`.",
        library.join("opentui.h").display()
    );

    println!("cargo:rustc-link-search=native={}", library.display());
    if static_link {
        println!("cargo:rustc-link-lib=static=opentui");
        if target.ends_with("-apple-darwin") {
            // What OpenTUI's build links libopentui.dylib against: the clipboard uses AppKit, Foundation, ImageIO, and
            // the Objective-C runtime, audio CoreFoundation, CoreAudio, and AudioToolbox, and video decoding the last
            // five frameworks. macOS's libc++ includes libc++abi.
            for framework in [
                "AppKit",
                "Foundation",
                "ImageIO",
                "CoreFoundation",
                "CoreAudio",
                "AudioToolbox",
                "VideoToolbox",
                "CoreMedia",
                "CoreVideo",
                "CoreServices",
                "QuartzCore",
            ] {
                println!("cargo:rustc-link-lib=framework={framework}");
            }
            for name in ["c++", "objc"] {
                println!("cargo:rustc-link-lib={name}");
            }
        } else {
            for name in ["c++", "c++abi", "m", "dl", "pthread"] {
                println!("cargo:rustc-link-lib={name}");
            }
        }
    } else if windows {
        println!("cargo:rustc-link-lib=dylib=opentui");
        // Windows has no rpath; programs find a DLL beside them or on PATH. `cargo run` and `cargo test` put search
        // paths inside the target directory on PATH, so a copy in OUT_DIR lets this workspace's programs start.
        let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
        fs::copy(library.join(shared_library), out.join(shared_library)).expect("copy opentui.dll into OUT_DIR");
        println!("cargo:rustc-link-search=native={}", out.display());
    } else {
        println!("cargo:rustc-link-lib=dylib=opentui");
        // Lets this crate's own test binary start on macOS, whose linker keeps the library though nothing uses it.
        println!("cargo:rustc-link-arg=-Wl,-rpath,{}", library.display());
    }
    // Dependent build scripts read these as DEP_OPENTUI_LIB_DIR and DEP_OPENTUI_STATIC.
    println!("cargo:lib_dir={}", library.display());
    println!("cargo:static={}", u8::from(static_link));
}
