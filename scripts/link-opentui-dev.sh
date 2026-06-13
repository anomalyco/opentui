#!/bin/bash

set -e

LINK_REACT=false
LINK_SOLID=false
TARGET_ROOT=""

while [[ $# -gt 0 ]]; do
  case $1 in
  --react)
    LINK_REACT=true
    shift
    ;;
  --solid)
    LINK_SOLID=true
    shift
    ;;
  *)
    TARGET_ROOT="$1"
    shift
    ;;
  esac
done

if [ -z "$TARGET_ROOT" ]; then
  echo "Usage: $0 <target-project-root> [--react] [--solid]"
  echo "Example: $0 /path/to/your/project"
  echo "Example: $0 /path/to/your/project --solid"
  echo "Example: $0 /path/to/your/project --react"
  echo ""
  echo "This script links OpenTUI dev packages into Bun's cache directory."
  echo "@opentui/core, @opentui/keymap, and @opentui/qrcode are always linked."
  echo "Framework packages can be linked with the flags below."
  echo ""
  echo "Options:"
  echo "  --react    Also link @opentui/react and React dependencies"
  echo "  --solid    Also link @opentui/solid and solid-js"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENTUI_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE_MODULES_DIR="$TARGET_ROOT/node_modules"

if [ ! -d "$TARGET_ROOT" ]; then
  echo "Error: Target project root directory does not exist: $TARGET_ROOT"
  exit 1
fi

if [ ! -d "$NODE_MODULES_DIR" ]; then
  echo "Error: node_modules directory does not exist: $NODE_MODULES_DIR"
  echo "Please run 'bun install' in the target project first."
  exit 1
fi

if [ ! -d "$NODE_MODULES_DIR/.bun" ]; then
  echo "Error: Bun cache directory not found: $NODE_MODULES_DIR/.bun"
  echo "This script is designed for Bun package manager."
  exit 1
fi

echo "Linking OpenTUI dev packages from: $OPENTUI_ROOT"
echo "To Bun cache in: $NODE_MODULES_DIR/.bun"
echo

# Helper function to link a package in Bun cache
link_in_bun_cache() {
  local package_pattern="$1"
  local package_name="$2"
  local source_path="$3"

  local cache_dirs=$(find "$NODE_MODULES_DIR/.bun" -maxdepth 1 -type d -name "$package_pattern" 2>/dev/null)

  if [ -z "$cache_dirs" ]; then
    echo "⚠ Warning: No Bun cache found for $package_name"
    return 0
  fi

  echo "$cache_dirs" | while read -r cache_dir; do
    if [ -n "$cache_dir" ] && [ -d "$cache_dir" ]; then
      local target_dir="$cache_dir/node_modules/$package_name"
      local target_parent=$(dirname "$target_dir")

      # Remove existing directory/symlink
      if [ -e "$target_dir" ] || [ -L "$target_dir" ]; then
        rm -rf "$target_dir"
      fi

      # Create parent directory if needed
      mkdir -p "$target_parent"

      # Create symlink
      ln -s "$source_path" "$target_dir"
      echo "  ✓ Linked $package_name in $(basename "$cache_dir")"
    fi
  done
}

# Always link @opentui/core
echo "Linking @opentui/core..."
link_in_bun_cache "@opentui+core@*" "@opentui/core" "$OPENTUI_ROOT/packages/core"

# Always link @opentui/keymap
echo "Linking @opentui/keymap..."
link_in_bun_cache "@opentui+keymap@*" "@opentui/keymap" "$OPENTUI_ROOT/packages/keymap"

# Always link @opentui/qrcode
echo "Linking @opentui/qrcode..."
link_in_bun_cache "@opentui+qrcode@*" "@opentui/qrcode" "$OPENTUI_ROOT/packages/qrcode"

# Link web-tree-sitter (required by core)
echo "Linking web-tree-sitter..."
if [ -d "$OPENTUI_ROOT/node_modules/web-tree-sitter" ]; then
  link_in_bun_cache "web-tree-sitter@*" "web-tree-sitter" "$OPENTUI_ROOT/node_modules/web-tree-sitter"
elif [ -d "$OPENTUI_ROOT/packages/core/node_modules/web-tree-sitter" ]; then
  link_in_bun_cache "web-tree-sitter@*" "web-tree-sitter" "$OPENTUI_ROOT/packages/core/node_modules/web-tree-sitter"
else
  echo "⚠ Warning: web-tree-sitter not found in OpenTUI node_modules"
fi

# Link @opentui/solid if requested
if [ "$LINK_SOLID" = true ]; then
  echo "Linking @opentui/solid..."
  link_in_bun_cache "@opentui+solid@*" "@opentui/solid" "$OPENTUI_ROOT/packages/solid"

  # Deduplicate solid-js: both opentui and the target must use the SAME solid-js
  # instance, otherwise Solid's context system breaks (two runtimes = two registries).
  # The target project's solid-js may be patched, so we keep that copy and point
  # opentui's resolution at it instead of the other way around.
  echo "Deduplicating solid-js..."

  # Find the target project's solid-js in its Bun cache
  TARGET_SOLIDJS=""
  for dir in "$NODE_MODULES_DIR/.bun"/solid-js@*/node_modules/solid-js; do
    if [ -d "$dir" ]; then
      TARGET_SOLIDJS="$dir"
      break
    fi
  done

  if [ -z "$TARGET_SOLIDJS" ]; then
    echo "⚠ Warning: solid-js not found in target project's Bun cache"
  else
    echo "  Using target's solid-js: $TARGET_SOLIDJS"

    # Point opentui's package-level solid-js at the target's copy.
    # Bun workspace hoisting creates packages/solid/node_modules/solid-js
    # pointing to opentui's own .bun cache — override it.
    OPENTUI_SOLID_SOLIDJS="$OPENTUI_ROOT/packages/solid/node_modules/solid-js"
    if [ -e "$OPENTUI_SOLID_SOLIDJS" ] || [ -L "$OPENTUI_SOLID_SOLIDJS" ]; then
      rm -rf "$OPENTUI_SOLID_SOLIDJS"
    fi
    ln -s "$TARGET_SOLIDJS" "$OPENTUI_SOLID_SOLIDJS"
    echo "  ✓ Linked packages/solid/node_modules/solid-js -> target's solid-js"

    # Also override the top-level resolution for any other opentui code
    # that might resolve solid-js from the workspace root.
    OPENTUI_ROOT_SOLIDJS="$OPENTUI_ROOT/node_modules/solid-js"
    if [ -e "$OPENTUI_ROOT_SOLIDJS" ] || [ -L "$OPENTUI_ROOT_SOLIDJS" ]; then
      rm -rf "$OPENTUI_ROOT_SOLIDJS"
    fi
    ln -s "$TARGET_SOLIDJS" "$OPENTUI_ROOT_SOLIDJS"
    echo "  ✓ Linked node_modules/solid-js -> target's solid-js"
  fi
fi

# Link @opentui/react if requested
if [ "$LINK_REACT" = true ]; then
  echo "Linking @opentui/react..."
  link_in_bun_cache "@opentui+react@*" "@opentui/react" "$OPENTUI_ROOT/packages/react"

  # Deduplicate react dependencies: both opentui and the target must use the
  # SAME react/react-dom/react-reconciler instances, otherwise React's context
  # system breaks. Keep the target's copies and point opentui at them.
  for react_pkg in react react-dom react-reconciler; do
    echo "Deduplicating $react_pkg..."

    TARGET_PKG=""
    for dir in "$NODE_MODULES_DIR/.bun"/${react_pkg}@*/node_modules/${react_pkg}; do
      if [ -d "$dir" ]; then
        TARGET_PKG="$dir"
        break
      fi
    done

    if [ -z "$TARGET_PKG" ]; then
      echo "  ⚠ Warning: $react_pkg not found in target project's Bun cache"
      continue
    fi

    echo "  Using target's $react_pkg: $TARGET_PKG"

    # Point opentui's package-level resolution at the target's copy
    OPENTUI_REACT_PKG="$OPENTUI_ROOT/packages/react/node_modules/$react_pkg"
    if [ -e "$OPENTUI_REACT_PKG" ] || [ -L "$OPENTUI_REACT_PKG" ]; then
      rm -rf "$OPENTUI_REACT_PKG"
    fi
    mkdir -p "$(dirname "$OPENTUI_REACT_PKG")"
    ln -s "$TARGET_PKG" "$OPENTUI_REACT_PKG"
    echo "  ✓ Linked packages/react/node_modules/$react_pkg -> target's $react_pkg"

    # Also override the top-level resolution
    OPENTUI_ROOT_PKG="$OPENTUI_ROOT/node_modules/$react_pkg"
    if [ -e "$OPENTUI_ROOT_PKG" ] || [ -L "$OPENTUI_ROOT_PKG" ]; then
      rm -rf "$OPENTUI_ROOT_PKG"
    fi
    ln -s "$TARGET_PKG" "$OPENTUI_ROOT_PKG"
    echo "  ✓ Linked node_modules/$react_pkg -> target's $react_pkg"
  done
fi

echo
echo "✓ OpenTUI development linking complete!"
echo "  Selected OpenTUI packages will now resolve to your dev version through Bun's cache."
