#!/bin/sh
# Compile-checks the workspace for aarch64-apple-darwin and x86_64-apple-darwin from another system: clippy with the
# feature sets test.sh uses, against stub artifacts. Nothing is linked or run; test.sh on macOS does that.
#
# Needs Zig, whose C compiler builds tree-sitter's C code against its bundled macOS headers, and each target's
# standard library: rustup installs both targets from rust-toolchain.toml. Without rustup, build them from rust-src:
# RUSTC_BOOTSTRAP=1 CARGO_UNSTABLE_BUILD_STD=std sh scripts/check-targets.sh
#
# Usage: sh scripts/check-targets.sh
# Set ZIG to the Zig command if `zig` is not the version packages/native/build.zig.zon names, such as ZIG='zig 0.17.0'
# with anyzig.
set -eu

here=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
# rustup reads rust-toolchain.toml from the working directory.
cd -- "$here"
zig=${ZIG:-zig}
# The bindings match this checkout's header, or OPENTUI_LIB_DIR's, which every platform's build shares.
header=${OPENTUI_LIB_DIR:-$here/../native/include}/opentui.h

export CARGO_TARGET_DIR="$here/target/check-targets"
tools=$CARGO_TARGET_DIR/tools
# build.rs only checks that the artifacts exist and that the header matches the bindings.
mkdir -p "$tools/lib"
cp "$header" "$tools/lib/opentui.h"
rm -f "$tools/lib/libopentui.dylib" "$tools/lib/libopentui.a"
: > "$tools/lib/libopentui.dylib"
# Read-only, as in a release or a Nix store: the static build below runs build.rs twice over its own copy.
: > "$tools/lib/libopentui.a"
chmod a-w "$tools/lib/libopentui.a"
for arch in aarch64 x86_64; do
    cat > "$tools/cc-$arch" <<EOF
#!/bin/sh
# Drops the Apple driver flags that zig cc takes from -target instead.
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
exec $zig cc -target $arch-macos.13.0 "\$@"
EOF
    chmod +x "$tools/cc-$arch"
done
printf '#!/bin/sh\nexec %s ar "$@"\n' "$zig" > "$tools/ar"
chmod +x "$tools/ar"

export OPENTUI_LIB_DIR="$tools/lib"
cargo=${CARGO:-cargo}
for arch in aarch64 x86_64; do
    target=$arch-apple-darwin
    static=opentui/static,opentui/tokio,opentui/log,opentui/tree-sitter
    for features in '' opentui/tokio,opentui/log,opentui/tree-sitter "$static" "$static"; do
        # A newer archive reruns build.rs, so the second static pass replaces the first one's copy.
        touch "$tools/lib/libopentui.a"
        env "CC_${arch}_apple_darwin=$tools/cc-$arch" "AR_${arch}_apple_darwin=$tools/ar" \
            "$cargo" clippy --locked --target "$target" --manifest-path "$here/Cargo.toml" --workspace \
            --all-targets ${features:+--features "$features"} -- -D warnings
    done
    printf 'PASS: macOS compile checks (%s)\n' "$target"
done

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
