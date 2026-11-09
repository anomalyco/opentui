#!/bin/sh
# Compile-checks the workspace for aarch64-apple-darwin and x86_64-apple-darwin from another system: clippy with the
# feature sets test.sh uses, against stub artifacts. Nothing is linked or run; CI tests macOS after each merge.
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
: > "$tools/lib/libopentui.dylib"
: > "$tools/lib/libopentui.a"
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
    for features in '' opentui/tokio,opentui/log,opentui/tree-sitter \
        opentui/static,opentui/tokio,opentui/log,opentui/tree-sitter; do
        env "CC_${arch}_apple_darwin=$tools/cc-$arch" "AR_${arch}_apple_darwin=$tools/ar" \
            "$cargo" clippy --locked --target "$target" --manifest-path "$here/Cargo.toml" --workspace \
            --all-targets ${features:+--features "$features"} -- -D warnings
    done
    printf 'PASS: macOS compile checks (%s)\n' "$target"
done
