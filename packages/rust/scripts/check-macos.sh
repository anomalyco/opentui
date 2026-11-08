#!/bin/sh
# Compile-checks the workspace for macOS from another system: clippy for aarch64-apple-darwin and x86_64-apple-darwin,
# with the features test.sh uses. Nothing is linked or run; that needs a Mac and a macOS build of OpenTUI.
#
# Needs Zig, whose C compiler builds tree-sitter's C code against its bundled macOS headers, and the standard library's
# source (rustup's rust-src component, or a distribution's rust-src package), which -Zbuild-std compiles for each
# target. RUSTC_BOOTSTRAP lets a stable toolchain take that flag. The first run downloads the standard library's
# dependencies.
#
# Usage: sh scripts/check-macos.sh
# Set ZIG to the Zig command if `zig` is not Zig 0.16 itself, such as ZIG='zig 0.16.0' with anyzig.
set -eu

here=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
zig=${ZIG:-zig}
# The bindings match this checkout's header, or OPENTUI_LIB_DIR's, which every platform's build shares.
header=${OPENTUI_LIB_DIR:-$here/../native/include}/opentui.h

export CARGO_TARGET_DIR="$here/target/check-macos"
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

export RUSTC_BOOTSTRAP=1 OPENTUI_LIB_DIR="$tools/lib"
cargo=${CARGO:-cargo}
for arch in aarch64 x86_64; do
    target=$arch-apple-darwin
    for features in '' opentui/tokio,opentui/log,opentui/tree-sitter \
        opentui/static,opentui/tokio,opentui/log,opentui/tree-sitter; do
        env "CC_${arch}_apple_darwin=$tools/cc-$arch" "AR_${arch}_apple_darwin=$tools/ar" \
            "$cargo" clippy -Zbuild-std --target "$target" --manifest-path "$here/Cargo.toml" --workspace --all-targets \
            ${features:+--features "$features"} -- -D warnings
    done
    printf 'PASS: macOS compile checks (%s)\n' "$target"
done
