use std::{env, fs, path::PathBuf};

/// Each Rust target, its artifact directory under `packages/native/lib`, and its shared library.
const TARGETS: &[(&str, &str, &str)] = &[
    ("x86_64-unknown-linux-gnu", "x86_64-linux", "libopentui.so"),
    ("aarch64-unknown-linux-gnu", "aarch64-linux", "libopentui.so"),
    ("x86_64-unknown-linux-musl", "x86_64-linux-musl", "libopentui.so"),
    ("aarch64-unknown-linux-musl", "aarch64-linux-musl", "libopentui.so"),
    ("aarch64-apple-darwin", "aarch64-macos", "libopentui.dylib"),
    ("x86_64-apple-darwin", "x86_64-macos", "libopentui.dylib"),
    ("x86_64-pc-windows-msvc", "x86_64-windows", "opentui.dll"),
    ("x86_64-pc-windows-gnu", "x86_64-windows", "opentui.dll"),
    ("aarch64-pc-windows-msvc", "aarch64-windows", "opentui.dll"),
    ("aarch64-pc-windows-gnullvm", "aarch64-windows", "opentui.dll"),
];

/// `OPENTUI_LIB_DIR`, else the native build of this checkout, `packages/native/lib/<platform>`.
fn native_lib_dir(platform: &str) -> PathBuf {
    if let Some(dir) = env::var_os("OPENTUI_LIB_DIR") {
        return PathBuf::from(dir);
    }
    PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../../../native/lib").join(platform)
}

// Must match fnv1a64 in packages/core/scripts/native-abi-rust.ts.
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
    let Some(&(_, platform, shared_library)) = TARGETS.iter().find(|(name, ..)| *name == target) else {
        let names: Vec<_> = TARGETS.iter().map(|(name, ..)| *name).collect();
        panic!("opentui-sys supports {}, not {target}", names.join(", "));
    };
    let windows = target.contains("-windows-");
    println!("cargo:rerun-if-env-changed=OPENTUI_LIB_DIR");
    // Cargo keeps a build script's output when only RUSTFLAGS change, which would leave the crt-static check stale.
    println!("cargo:rerun-if-env-changed=RUSTFLAGS");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=src/generated.rs");
    let dir = native_lib_dir(platform);
    // OpenTUI's Windows archive is built for MinGW with libc++, which neither Rust Windows toolchain links, so Windows
    // links opentui.dll with or without the static feature.
    let static_link = env::var_os("CARGO_FEATURE_STATIC").is_some() && !windows;
    // A crt-static Unix executable has no dynamic loader, so nothing loads the shared library and it crashes at start.
    // Rust's musl targets default to crt-static, which CARGO_CFG_TARGET_FEATURE does not list.
    let features = env::var("CARGO_CFG_TARGET_FEATURE").unwrap_or_default();
    let crt_static = !env::var("CARGO_ENCODED_RUSTFLAGS").unwrap_or_default().contains("-crt-static")
        && (target.ends_with("-musl") || features.split(',').any(|feature| feature == "crt-static"));
    assert!(
        windows || static_link || !crt_static,
        "{target} links static executables (crt-static), which cannot load {shared_library}: build with \
         RUSTFLAGS='-C target-feature=-crt-static', or keep the default static feature, which links libopentui.a."
    );
    // Windows links a DLL through its import library.
    let files: &[&str] = if static_link {
        &["opentui.h", "libopentui.a"]
    } else if windows {
        &["opentui.h", shared_library, "opentui.lib"]
    } else {
        &["opentui.h", shared_library]
    };
    for file in files {
        let path = dir.join(file);
        // Watch the path as given: a canonical path follows a symlink and would keep watching its old target.
        println!("cargo:rerun-if-changed={}", path.display());
        assert!(
            path.is_file(),
            "missing native artifact {}: run `bun run build` at the repository root or `bun run build:native` in \
             packages/core, or set OPENTUI_LIB_DIR to OpenTUI's packages/native/lib/{platform}",
            path.display()
        );
    }
    let library = dir.canonicalize().expect("canonicalize the native artifact directory");

    // The declarations are only valid for the exact header they were generated from.
    let header = fs::read(library.join("opentui.h")).expect("read opentui.h");
    let expected = generated_header_hash();
    let actual = fnv1a64(&header);
    assert_eq!(
        actual,
        expected,
        "{} differs from the header src/generated.rs was generated from \
         (hash {actual:#018x}, expected {expected:#018x}). Rebuild OpenTUI's native library, or regenerate with \
         `bun run generate:abi` in packages/core.",
        library.join("opentui.h").display()
    );

    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    if static_link {
        // Apple's linker takes libopentui.dylib over libopentui.a from one directory, so search one without the dylib.
        // The copy keeps the source's mode, so a read-only source leaves a copy that a rerun cannot overwrite.
        let _ = fs::remove_file(out.join("libopentui.a"));
        fs::copy(library.join("libopentui.a"), out.join("libopentui.a")).expect("copy libopentui.a into OUT_DIR");
        println!("cargo:rustc-link-search=native={}", out.display());
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
        } else if target.ends_with("-gnu") {
            // The Linux archive carries Zig's libc++ and libc++abi. musl's libc includes these three; asking for them
            // there would find the build machine's glibc archives.
            for name in ["m", "dl", "pthread"] {
                println!("cargo:rustc-link-lib={name}");
            }
        }
    } else {
        println!("cargo:rustc-link-search=native={}", library.display());
        println!("cargo:rustc-link-lib=dylib=opentui");
        if windows {
            // Windows has no rpath; programs find a DLL beside them or on PATH. `cargo run` and `cargo test` put search
            // paths inside the target directory on PATH, so a copy in OUT_DIR lets this workspace's programs start.
            fs::copy(library.join(shared_library), out.join(shared_library)).expect("copy opentui.dll into OUT_DIR");
            println!("cargo:rustc-link-search=native={}", out.display());
        } else {
            // Lets this crate's own test binary start on macOS, whose linker keeps the library though nothing uses it.
            println!("cargo:rustc-link-arg=-Wl,-rpath,{}", library.display());
        }
    }
    // Dependent build scripts read these as DEP_OPENTUI_LIB_DIR and DEP_OPENTUI_STATIC.
    println!("cargo:lib_dir={}", library.display());
    println!("cargo:static={}", u8::from(static_link));
}
