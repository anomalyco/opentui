// @generated from Core's and @opentui/keymap's tables by packages/keymap/scripts/rust-tables.ts. Do not edit.
// Regenerate with `bun scripts/rust-tables.ts` in packages/keymap.

use crate::widget::EditorAction;

/// The edit commands, their names, and their descriptions, as `@opentui/keymap`'s edit-buffer addon names them.
pub const EDIT_COMMANDS: &[(EditorAction, &str, &str)] = &[
    (EditorAction::MoveLeft, "input.move.left", "Cursor left"),
    (EditorAction::MoveRight, "input.move.right", "Cursor right"), (EditorAction::MoveUp, "input.move.up", "Cursor up"),
    (EditorAction::MoveDown, "input.move.down", "Cursor down"),
    (EditorAction::SelectLeft, "input.select.left", "Select left"),
    (EditorAction::SelectRight, "input.select.right", "Select right"),
    (EditorAction::SelectUp, "input.select.up", "Select up"),
    (EditorAction::SelectDown, "input.select.down", "Select down"),
    (EditorAction::LineHome, "input.line.home", "Line start"), (EditorAction::LineEnd, "input.line.end", "Line end"),
    (EditorAction::SelectLineHome, "input.select.line.home", "Select to line start"),
    (EditorAction::SelectLineEnd, "input.select.line.end", "Select to line end"),
    (EditorAction::VisualLineHome, "input.visual.line.home", "Visual line start"),
    (EditorAction::VisualLineEnd, "input.visual.line.end", "Visual line end"),
    (EditorAction::SelectVisualLineHome, "input.select.visual.line.home", "Select to visual line start"),
    (EditorAction::SelectVisualLineEnd, "input.select.visual.line.end", "Select to visual line end"),
    (EditorAction::BufferHome, "input.buffer.home", "Buffer start"),
    (EditorAction::BufferEnd, "input.buffer.end", "Buffer end"),
    (EditorAction::SelectBufferHome, "input.select.buffer.home", "Select to buffer start"),
    (EditorAction::SelectBufferEnd, "input.select.buffer.end", "Select to buffer end"),
    (EditorAction::DeleteLine, "input.delete.line", "Delete line"),
    (EditorAction::DeleteToLineEnd, "input.delete.to.line.end", "Delete to line end"),
    (EditorAction::DeleteToLineStart, "input.delete.to.line.start", "Delete to line start"),
    (EditorAction::Backspace, "input.backspace", "Delete backward"),
    (EditorAction::Delete, "input.delete", "Delete forward"), (EditorAction::Newline, "input.newline", "New line"),
    (EditorAction::Undo, "input.undo", "Undo"), (EditorAction::Redo, "input.redo", "Redo"),
    (EditorAction::WordForward, "input.word.forward", "Next word"),
    (EditorAction::WordBackward, "input.word.backward", "Previous word"),
    (EditorAction::SelectWordForward, "input.select.word.forward", "Select next word"),
    (EditorAction::SelectWordBackward, "input.select.word.backward", "Select previous word"),
    (EditorAction::DeleteWordForward, "input.delete.word.forward", "Delete next word"),
    (EditorAction::DeleteWordBackward, "input.delete.word.backward", "Delete previous word"),
    (EditorAction::SelectAll, "input.select.all", "Select all"), (EditorAction::Submit, "input.submit", "Submit"),
];

/// Core's default textarea bindings (`defaultTextareaKeyBindings`), in binding syntax.
pub const TEXTAREA_BINDINGS: &[(&str, EditorAction)] = &[
    ("left", EditorAction::MoveLeft), ("right", EditorAction::MoveRight), ("up", EditorAction::MoveUp),
    ("down", EditorAction::MoveDown), ("shift+left", EditorAction::SelectLeft),
    ("shift+right", EditorAction::SelectRight), ("shift+up", EditorAction::SelectUp),
    ("shift+down", EditorAction::SelectDown), ("home", EditorAction::BufferHome), ("end", EditorAction::BufferEnd),
    ("shift+home", EditorAction::SelectBufferHome), ("shift+end", EditorAction::SelectBufferEnd),
    ("ctrl+a", EditorAction::LineHome), ("ctrl+e", EditorAction::LineEnd),
    ("ctrl+shift+a", EditorAction::SelectLineHome), ("ctrl+shift+e", EditorAction::SelectLineEnd),
    ("meta+a", EditorAction::VisualLineHome), ("meta+e", EditorAction::VisualLineEnd),
    ("shift+meta+a", EditorAction::SelectVisualLineHome), ("shift+meta+e", EditorAction::SelectVisualLineEnd),
    ("ctrl+f", EditorAction::MoveRight), ("ctrl+b", EditorAction::MoveLeft),
    ("ctrl+w", EditorAction::DeleteWordBackward), ("ctrl+backspace", EditorAction::DeleteWordBackward),
    ("meta+d", EditorAction::DeleteWordForward), ("meta+delete", EditorAction::DeleteWordForward),
    ("ctrl+delete", EditorAction::DeleteWordForward), ("ctrl+shift+d", EditorAction::DeleteLine),
    ("ctrl+k", EditorAction::DeleteToLineEnd), ("ctrl+u", EditorAction::DeleteToLineStart),
    ("backspace", EditorAction::Backspace), ("shift+backspace", EditorAction::Backspace),
    ("ctrl+d", EditorAction::Delete), ("delete", EditorAction::Delete), ("shift+delete", EditorAction::Delete),
    ("return", EditorAction::Newline), ("kpenter", EditorAction::Newline), ("linefeed", EditorAction::Newline),
    ("meta+return", EditorAction::Submit), ("meta+kpenter", EditorAction::Submit), ("ctrl+-", EditorAction::Undo),
    ("ctrl+.", EditorAction::Redo), ("super+z", EditorAction::Undo), ("shift+super+z", EditorAction::Redo),
    ("meta+f", EditorAction::WordForward), ("meta+b", EditorAction::WordBackward),
    ("meta+right", EditorAction::WordForward), ("meta+left", EditorAction::WordBackward),
    ("ctrl+right", EditorAction::WordForward), ("ctrl+left", EditorAction::WordBackward),
    ("shift+meta+f", EditorAction::SelectWordForward), ("shift+meta+b", EditorAction::SelectWordBackward),
    ("shift+meta+right", EditorAction::SelectWordForward), ("shift+meta+left", EditorAction::SelectWordBackward),
    ("meta+backspace", EditorAction::DeleteWordBackward), ("super+left", EditorAction::VisualLineHome),
    ("super+right", EditorAction::VisualLineEnd), ("super+up", EditorAction::BufferHome),
    ("super+down", EditorAction::BufferEnd), ("super+backspace", EditorAction::DeleteToLineStart),
    ("shift+super+left", EditorAction::SelectVisualLineHome), ("shift+super+right", EditorAction::SelectVisualLineEnd),
    ("shift+super+up", EditorAction::SelectBufferHome), ("shift+super+down", EditorAction::SelectBufferEnd),
    ("super+a", EditorAction::SelectAll),
];

/// The same bindings as shortcuts: Core's `meta` is Alt here, and Enter is both `return` and `kpenter`.
/// Duplicate rows bind the same action.
pub(crate) const TEXTAREA_SHORTCUTS: &[(&str, EditorAction)] = &[
    ("left", EditorAction::MoveLeft), ("right", EditorAction::MoveRight), ("up", EditorAction::MoveUp),
    ("down", EditorAction::MoveDown), ("shift+left", EditorAction::SelectLeft),
    ("shift+right", EditorAction::SelectRight), ("shift+up", EditorAction::SelectUp),
    ("shift+down", EditorAction::SelectDown), ("home", EditorAction::BufferHome), ("end", EditorAction::BufferEnd),
    ("shift+home", EditorAction::SelectBufferHome), ("shift+end", EditorAction::SelectBufferEnd),
    ("ctrl+a", EditorAction::LineHome), ("ctrl+e", EditorAction::LineEnd),
    ("ctrl+shift+a", EditorAction::SelectLineHome), ("ctrl+shift+e", EditorAction::SelectLineEnd),
    ("alt+a", EditorAction::VisualLineHome), ("alt+e", EditorAction::VisualLineEnd),
    ("shift+alt+a", EditorAction::SelectVisualLineHome), ("shift+alt+e", EditorAction::SelectVisualLineEnd),
    ("ctrl+f", EditorAction::MoveRight), ("ctrl+b", EditorAction::MoveLeft),
    ("ctrl+w", EditorAction::DeleteWordBackward), ("ctrl+backspace", EditorAction::DeleteWordBackward),
    ("alt+d", EditorAction::DeleteWordForward), ("alt+delete", EditorAction::DeleteWordForward),
    ("ctrl+delete", EditorAction::DeleteWordForward), ("ctrl+shift+d", EditorAction::DeleteLine),
    ("ctrl+k", EditorAction::DeleteToLineEnd), ("ctrl+u", EditorAction::DeleteToLineStart),
    ("backspace", EditorAction::Backspace), ("shift+backspace", EditorAction::Backspace),
    ("ctrl+d", EditorAction::Delete), ("delete", EditorAction::Delete), ("shift+delete", EditorAction::Delete),
    ("return", EditorAction::Newline), ("enter", EditorAction::Newline), ("linefeed", EditorAction::Newline),
    ("alt+return", EditorAction::Submit), ("alt+enter", EditorAction::Submit), ("ctrl+-", EditorAction::Undo),
    ("ctrl+.", EditorAction::Redo), ("super+z", EditorAction::Undo), ("shift+super+z", EditorAction::Redo),
    ("alt+f", EditorAction::WordForward), ("alt+b", EditorAction::WordBackward),
    ("alt+right", EditorAction::WordForward), ("alt+left", EditorAction::WordBackward),
    ("ctrl+right", EditorAction::WordForward), ("ctrl+left", EditorAction::WordBackward),
    ("shift+alt+f", EditorAction::SelectWordForward), ("shift+alt+b", EditorAction::SelectWordBackward),
    ("shift+alt+right", EditorAction::SelectWordForward), ("shift+alt+left", EditorAction::SelectWordBackward),
    ("alt+backspace", EditorAction::DeleteWordBackward), ("super+left", EditorAction::VisualLineHome),
    ("super+right", EditorAction::VisualLineEnd), ("super+up", EditorAction::BufferHome),
    ("super+down", EditorAction::BufferEnd), ("super+backspace", EditorAction::DeleteToLineStart),
    ("shift+super+left", EditorAction::SelectVisualLineHome), ("shift+super+right", EditorAction::SelectVisualLineEnd),
    ("shift+super+up", EditorAction::SelectBufferHome), ("shift+super+down", EditorAction::SelectBufferEnd),
    ("super+a", EditorAction::SelectAll),
];

/// `@opentui/keymap`'s named keys in binding syntax.
pub(crate) const NAMED_KEYS: &[&str] = &[
    "up", "down", "left", "right", "clear", "escape", "return", "linefeed", "enter", "tab", "backspace", "delete",
    "insert", "home", "end", "pageup", "pagedown", "space", "lt", "gt", "plus", "minus", "equal", "comma", "period",
    "slash", "backslash", "semicolon", "quote", "backquote", "leftbracket", "rightbracket", "capslock", "numlock",
    "scrolllock", "printscreen", "pause", "menu", "apps", "kp0", "kp1", "kp2", "kp3", "kp4", "kp5", "kp6", "kp7", "kp8",
    "kp9", "kpdecimal", "kpdivide", "kpmultiply", "kpminus", "kpplus", "kpenter", "kpequal", "kpseparator", "kpleft",
    "kpright", "kpup", "kpdown", "kppageup", "kppagedown", "kphome", "kpend", "kpinsert", "kpdelete", "mediaplay",
    "mediapause", "mediaplaypause", "mediareverse", "mediastop", "mediafastforward", "mediarewind", "medianext",
    "mediaprev", "mediarecord", "volumedown", "volumeup", "mute", "leftshift", "leftctrl", "leftalt", "leftsuper",
    "lefthyper", "leftmeta", "rightshift", "rightctrl", "rightalt", "rightsuper", "righthyper", "rightmeta",
    "iso_level3_shift", "iso_level5_shift", "option", "alt", "meta", "super", "hyper", "control", "ctrl", "shift",
];

/// `@opentui/keymap`'s modifier names in binding syntax.
pub(crate) const MODIFIER_KEYS: &[&str] = &[
    "ctrl", "control", "shift", "meta", "alt", "option", "super", "hyper",
];

/// Core's names for the Kitty functional keys from 57428 (media play) on.
pub(crate) const KITTY_KEY_NAMES: &[&str] = &[
    "mediaplay", "mediapause", "mediaplaypause", "mediareverse", "mediastop", "mediafastforward", "mediarewind",
    "medianext", "mediaprev", "mediarecord", "volumedown", "volumeup", "mute", "leftshift", "leftctrl", "leftalt",
    "leftsuper", "lefthyper", "leftmeta", "rightshift", "rightctrl", "rightalt", "rightsuper", "righthyper",
    "rightmeta", "iso_level3_shift", "iso_level5_shift",
];

/// Core's filetypes by file extension.
pub(crate) const FILETYPE_EXTENSIONS: &[(&str, &str)] = &[
    ("astro", "astro"), ("bash", "bash"), ("c", "c"), ("cc", "cpp"), ("cjs", "javascript"), ("clj", "clojure"),
    ("cljs", "clojure"), ("cljc", "clojure"), ("cpp", "cpp"), ("cxx", "cpp"), ("cs", "csharp"), ("cts", "typescript"),
    ("ctsx", "typescriptreact"), ("dart", "dart"), ("diff", "diff"), ("edn", "clojure"), ("go", "go"),
    ("gemspec", "ruby"), ("groovy", "groovy"), ("h", "c"), ("handlebars", "handlebars"), ("hbs", "handlebars"),
    ("hpp", "cpp"), ("hxx", "cpp"), ("h++", "cpp"), ("hh", "cpp"), ("hrl", "erlang"), ("hs", "haskell"),
    ("htm", "html"), ("html", "html"), ("ini", "ini"), ("js", "javascript"), ("jsx", "javascriptreact"),
    ("jl", "julia"), ("json", "json"), ("ksh", "bash"), ("kt", "kotlin"), ("kts", "kotlin"), ("latex", "latex"),
    ("less", "less"), ("lua", "lua"), ("markdown", "markdown"), ("md", "markdown"), ("mdown", "markdown"),
    ("mkd", "markdown"), ("mjs", "javascript"), ("ml", "ocaml"), ("mli", "ocaml"), ("mts", "typescript"),
    ("mtsx", "typescriptreact"), ("patch", "diff"), ("php", "php"), ("pl", "perl"), ("pm", "perl"),
    ("ps1", "powershell"), ("psm1", "powershell"), ("py", "python"), ("pyi", "python"), ("r", "r"), ("rb", "ruby"),
    ("rake", "ruby"), ("rs", "rust"), ("ru", "ruby"), ("sass", "sass"), ("sc", "scala"), ("scala", "scala"),
    ("scss", "scss"), ("sh", "bash"), ("sql", "sql"), ("svelte", "svelte"), ("swift", "swift"), ("ts", "typescript"),
    ("tsx", "typescriptreact"), ("tex", "latex"), ("toml", "toml"), ("vue", "vue"), ("vim", "vim"), ("xml", "xml"),
    ("xsl", "xsl"), ("yaml", "yaml"), ("yml", "yaml"), ("zig", "zig"), ("zon", "zig"), ("zsh", "bash"), ("c++", "cpp"),
    ("erl", "erlang"), ("exs", "elixir"), ("ex", "elixir"), ("elm", "elm"), ("fsharp", "fsharp"), ("fs", "fsharp"),
    ("fsx", "fsharp"), ("fsscript", "fsharp"), ("fsi", "fsharp"), ("java", "java"), ("css", "css"),
];

/// Core's filetypes by lowercase file name.
pub(crate) const FILETYPE_BASENAMES: &[(&str, &str)] = &[
    (".bash_aliases", "bash"), (".bash_logout", "bash"), (".bash_profile", "bash"), (".bashrc", "bash"),
    (".kshrc", "bash"), (".profile", "bash"), (".vimrc", "vim"), (".zlogin", "bash"), (".zlogout", "bash"),
    (".zprofile", "bash"), (".zshenv", "bash"), (".zshrc", "bash"), ("appfile", "ruby"), ("berksfile", "ruby"),
    ("brewfile", "ruby"), ("cheffile", "ruby"), ("containerfile", "dockerfile"), ("dockerfile", "dockerfile"),
    ("fastfile", "ruby"), ("gemfile", "ruby"), ("gnumakefile", "make"), ("gvimrc", "vim"), ("guardfile", "ruby"),
    ("makefile", "make"), ("podfile", "ruby"), ("rakefile", "ruby"), ("thorfile", "ruby"), ("vagrantfile", "ruby"),
];
