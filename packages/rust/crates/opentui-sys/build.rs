use std::{env, fs, path::PathBuf};

/// Each Rust target, its artifact directory under `packages/native/lib`, its shared library, and its release archive's
/// platform name.
const TARGETS: &[(&str, &str, &str, &str)] = &[
    ("x86_64-unknown-linux-gnu", "x86_64-linux", "libopentui.so", "linux-x64"),
    ("aarch64-unknown-linux-gnu", "aarch64-linux", "libopentui.so", "linux-arm64"),
    ("x86_64-unknown-linux-musl", "x86_64-linux-musl", "libopentui.so", "linux-x64-musl"),
    ("aarch64-unknown-linux-musl", "aarch64-linux-musl", "libopentui.so", "linux-arm64-musl"),
    ("aarch64-apple-darwin", "aarch64-macos", "libopentui.dylib", "darwin-arm64"),
    ("x86_64-apple-darwin", "x86_64-macos", "libopentui.dylib", "darwin-x64"),
    ("x86_64-pc-windows-msvc", "x86_64-windows", "opentui.dll", "windows-x64"),
    ("x86_64-pc-windows-gnu", "x86_64-windows", "opentui.dll", "windows-x64"),
    ("aarch64-pc-windows-msvc", "aarch64-windows", "opentui.dll", "windows-arm64"),
    ("aarch64-pc-windows-gnullvm", "aarch64-windows", "opentui.dll", "windows-arm64"),
];

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
    println!("cargo:rerun-if-env-changed=DOCS_RS");
    // docs.rs builds documentation, which links nothing, without the native library.
    if env::var_os("DOCS_RS").is_some() {
        return;
    }
    let target = env::var("TARGET").unwrap();
    let Some(&(_, platform, shared_library, release)) = TARGETS.iter().find(|(name, ..)| *name == target) else {
        let names: Vec<_> = TARGETS.iter().map(|(name, ..)| *name).collect();
        panic!("opentui-sys supports {}, not {target}", names.join(", "));
    };
    let windows = target.contains("-windows-");
    println!("cargo:rerun-if-env-changed=OPENTUI_LIB_DIR");
    println!("cargo:rerun-if-env-changed=OPENTUI_LIB_HINT");
    // Cargo keeps a build script's output when only RUSTFLAGS change, which would leave the crt-static check stale.
    println!("cargo:rerun-if-env-changed=RUSTFLAGS");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=src/generated.rs");
    // OpenTUI's Windows archive is built for MinGW against the UCRT and carries the parts of MinGW's runtime that MSVC
    // lacks. Rust's GNU targets bring MinGW runtimes of their own, so they link opentui.dll with or without the static
    // feature.
    let msvc = target.ends_with("-windows-msvc");
    let static_link = env::var_os("CARGO_FEATURE_STATIC").is_some() && (msvc || !windows);
    let archive = if msvc { "opentui-static.lib" } else { "libopentui.a" };
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
        &["opentui.h", archive]
    } else if windows {
        &["opentui.h", shared_library, "opentui.lib"]
    } else {
        &["opentui.h", shared_library]
    };
    // Only a checkout of OpenTUI can build the library; Cargo marks its own git checkouts with .cargo-ok. A consumer's
    // .cargo/config.toml can name its own setup step in OPENTUI_LIB_HINT.
    let version = env!("CARGO_PKG_VERSION");
    let from_release = format!(
        "extract opentui-native-v{version}-{release}.zip from OpenTUI's v{version} release and set OPENTUI_LIB_DIR to \
         that directory"
    );
    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../../../..");
    let checkout = root.join("packages/native/build.zig").is_file() && !root.join(".cargo-ok").exists();
    let advice = match env::var("OPENTUI_LIB_HINT") {
        Ok(hint) if !hint.is_empty() => hint,
        _ if env::var_os("OPENTUI_LIB_DIR").is_some() => {
            format!("OPENTUI_LIB_DIR names a directory without it: {from_release}")
        }
        _ if checkout => format!(
            "run `bun run build` at the repository root or `bun run build:native` in packages/core, or set \
             OPENTUI_LIB_DIR to OpenTUI's packages/native/lib/{platform}"
        ),
        _ => from_release,
    };
    // `OPENTUI_LIB_DIR`, else the native build of this checkout. A package from a registry has no checkout around it.
    let dir = match env::var_os("OPENTUI_LIB_DIR") {
        Some(dir) => PathBuf::from(dir),
        None if checkout => root.join("packages/native/lib").join(platform),
        None => panic!("OPENTUI_LIB_DIR is not set: {advice}"),
    };
    for file in files {
        let path = dir.join(file);
        // Watch the path as given: a canonical path follows a symlink and would keep watching its old target.
        println!("cargo:rerun-if-changed={}", path.display());
        // npm's platform packages ship the shared library only.
        let shared = if *file == archive && dir.join(shared_library).is_file() {
            format!(
                ". This directory has no static archive: to link {shared_library} instead, turn off the default static \
                 feature (default-features = false, or --no-default-features)"
            )
        } else {
            String::new()
        };
        assert!(path.is_file(), "missing native artifact {}: {advice}{shared}", path.display());
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
        #[expect(clippy::let_underscore_must_use, reason = "a first build has no copy; the copy below fails loudly")]
        let _ = fs::remove_file(out.join(archive));
        fs::copy(library.join(archive), out.join(archive)).expect("copy the static archive into OUT_DIR");
        println!("cargo:rustc-link-search=native={}", out.display());
        println!("cargo:rustc-link-lib=static={}", if msvc { "opentui-static" } else { "opentui" });
        if msvc {
            // The DLLs the archive imports from besides the C runtime, and the out-of-line printf and scanf functions
            // that MinGW's headers call and MSVC's define inline.
            for name in ["kernel32", "ntdll", "user32", "bcrypt", "legacy_stdio_definitions"] {
                println!("cargo:rustc-link-lib={name}");
            }
        } else if target.ends_with("-apple-darwin") {
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
