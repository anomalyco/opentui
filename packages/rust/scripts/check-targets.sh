#!/bin/sh
# Compile-checks the workspace for every target build.rs maps except the x86_64 Linux and Windows ones, which test.sh
# checks on their own runners: clippy with the feature sets test.sh uses, against stub artifacts. Nothing is linked or
# run. test.sh runs on macOS too; nothing tests arm64 Linux, Linux with musl, or Windows on Arm beyond this check.
#
# Needs Zig, whose C compiler builds tree-sitter's and ring's C code for each target against its bundled headers, and
# each target's standard library, which the script adds with rustup. Without rustup, build them from rust-src:
# RUSTC_BOOTSTRAP=1 CARGO_UNSTABLE_BUILD_STD=std sh scripts/check-targets.sh
#
# Usage: sh scripts/check-targets.sh
# Set ZIG to the Zig command if `zig` is not the version packages/native/build.zig.zon names, such as ZIG='zig 0.17.1'
# with anyzig.
set -eu

here=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
# rustup reads rust-toolchain.toml from the working directory.
cd -- "$here"
zig=${ZIG:-zig}
# The bindings match this checkout's header, or OPENTUI_LIB_DIR's, which every platform's build shares.
header=${OPENTUI_LIB_DIR:-$here/../native/include}/opentui.h

# Each Rust target, the Zig target its C code compiles for, and its row in build.rs: artifact directory and shared
# library. Zig has no MSVC headers, so both Windows targets use MinGW's; the objects are never linked.
targets='aarch64-apple-darwin aarch64-macos.13.0 aarch64-macos libopentui.dylib
x86_64-apple-darwin x86_64-macos.13.0 x86_64-macos libopentui.dylib
aarch64-unknown-linux-gnu aarch64-linux-gnu.2.17 aarch64-linux libopentui.so
x86_64-unknown-linux-musl x86_64-linux-musl x86_64-linux-musl libopentui.so
aarch64-unknown-linux-musl aarch64-linux-musl aarch64-linux-musl libopentui.so
aarch64-pc-windows-msvc aarch64-windows-gnu aarch64-windows opentui.dll
aarch64-pc-windows-gnullvm aarch64-windows-gnu aarch64-windows opentui.dll'
if [ -z "${CARGO_UNSTABLE_BUILD_STD:-}" ] && command -v rustup > /dev/null; then
    rustup target add $(printf '%s\n' "$targets" | cut -d' ' -f1)
fi

export CARGO_TARGET_DIR="$here/target/check-targets"
tools=$CARGO_TARGET_DIR/tools
# build.rs only checks that the artifacts exist and that the header matches the bindings.
mkdir -p "$tools/lib"
cp "$header" "$tools/lib/opentui.h"
for stub in libopentui.dylib libopentui.so libopentui.a opentui.dll opentui.lib; do
    rm -f "$tools/lib/$stub"
    : > "$tools/lib/$stub"
done
# Read-only, as in a release or a Nix store: the static build below runs build.rs twice over its own copy.
chmod a-w "$tools/lib/libopentui.a"
# cc-rs gives MSVC targets lib.exe's options.
for archiver in ar lib; do
    printf '#!/bin/sh\nexec %s %s "$@"\n' "$zig" "$archiver" > "$tools/zig-$archiver"
    chmod +x "$tools/zig-$archiver"
done

export OPENTUI_LIB_DIR="$tools/lib"
cargo=${CARGO:-cargo}
while read -r target zig_target platform library; do
    # The stubs share one OPENTUI_LIB_DIR, so check build.rs's row and the native build's directory by name.
    grep -Fq "(\"$target\", \"$platform\", \"$library\")," crates/opentui-sys/build.rs ||
        { echo "FAIL: build.rs does not map $target to $platform and $library" >&2; exit 1; }
    grep -Fq ".output_name = \"$platform\"" ../native/build.zig ||
        { echo "FAIL: packages/native/build.zig builds no $platform" >&2; exit 1; }
    cat > "$tools/cc-$target" <<EOF
#!/bin/sh
# Drops the driver flags that zig cc takes from -target instead.
skip=
for arg do
    shift
    if [ -n "\$skip" ]; then skip=; continue; fi
    case \$arg in
        -arch) skip=1; continue ;;
        -mmacosx-version-min=*|--target=*) continue ;;
    esac
    set -- "\$@" "\$arg"
done
exec $zig cc -target $zig_target "\$@"
EOF
    chmod +x "$tools/cc-$target"
    # The static feature is a default one.
    shared='--no-default-features --features opentui/tokio,opentui/log,opentui/tree-sitter'
    static='--features opentui/tokio,opentui/log,opentui/tree-sitter'
    archiver=ar
    rustflags=
    case $target in
        *-msvc) archiver=lib ;;
        # build.rs refuses shared linking under crt-static, the musl targets' default.
        *-musl) rustflags='-C target-feature=-crt-static' ;;
    esac
    case $target in
        # Windows links opentui.dll with or without the static feature.
        *-windows-*) feature_sets="--no-default-features '$shared' '$static'" ;;
        *) feature_sets="--no-default-features '$shared' '$static' '$static'" ;;
    esac
    eval "set -- $feature_sets"
    for features do
        # A newer archive reruns build.rs, so the second static pass replaces the first one's copy.
        touch "$tools/lib/libopentui.a"
        env "CC_$(printf %s "$target" | tr - _)=$tools/cc-$target" "AR_$(printf %s "$target" | tr - _)=$tools/zig-$archiver" \
            ${rustflags:+"RUSTFLAGS=$rustflags"} "$cargo" clippy --locked --target "$target" --manifest-path "$here/Cargo.toml" --workspace \
            --all-targets $features -- -D warnings < /dev/null
    done
    printf 'PASS: compile checks (%s)\n' "$target"
done <<EOF
$targets
EOF

# A crt-static executable has no dynamic loader and would crash at start, so build.rs refuses to link it shared.
if "$cargo" check --locked --target x86_64-unknown-linux-musl --manifest-path "$here/Cargo.toml" -p opentui-sys \
    --no-default-features < /dev/null 2> "$tools/crt-static"; then
    echo 'FAIL: a crt-static musl build links the shared library' >&2
    exit 1
fi
grep -Fq "RUSTFLAGS='-C target-feature=-crt-static'" "$tools/crt-static" || { cat "$tools/crt-static" >&2; exit 1; }
echo 'PASS: build.rs refuses shared linking under crt-static'

# Apple's linker takes libopentui.dylib over libopentui.a from one directory, so a static build must not search one
# that holds both. Rewriting the stubs reran each build script after the header copy, so -newer skips stale outputs.
find "$CARGO_TARGET_DIR" -path '*-apple-darwin/debug/build/opentui-sys-*/output' -newer "$tools/lib/opentui.h" \
    -exec grep -qx 'cargo:static=1' {} \; -print > "$tools/static-outputs"
[ "$(wc -l < "$tools/static-outputs")" -eq 2 ] || { echo 'FAIL: no static build per macOS target' >&2; exit 1; }
while IFS= read -r output; do
    sed -En 's/^cargo::?rustc-link-search=((native|all|crate|dependency|framework)=)?//p' "$output" > "$tools/dirs"
    archive=
    while IFS= read -r dir; do
        [ ! -e "$dir/libopentui.dylib" ] || { echo "FAIL: the static build searches $dir" >&2; exit 1; }
        [ ! -f "$dir/libopentui.a" ] || archive=1
    done < "$tools/dirs"
    [ -n "$archive" ] || { echo "FAIL: the static build searches no libopentui.a: $output" >&2; exit 1; }
done < "$tools/static-outputs"
echo 'PASS: static macOS builds search libopentui.a and no libopentui.dylib'

# Windows links opentui.dll with the static feature too, though the stubs include a libopentui.a.
find "$CARGO_TARGET_DIR" -path '*-windows-*/debug/build/opentui-sys-*/output' -newer "$tools/lib/opentui.h" \
    -print > "$tools/windows-outputs"
[ -s "$tools/windows-outputs" ] || { echo 'FAIL: no Windows build' >&2; exit 1; }
while IFS= read -r output; do
    grep -qx 'cargo:static=0' "$output" || { echo "FAIL: a Windows build links libopentui.a: $output" >&2; exit 1; }
done < "$tools/windows-outputs"
echo 'PASS: Windows builds link opentui.dll with and without the static feature'
