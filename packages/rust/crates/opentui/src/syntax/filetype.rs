//! Filetype names from paths, extensions, and Markdown info strings, ported from Core's `resolve-ft.ts`.

/// The filetype for a file extension, with or without its dot, such as `"rs"` or `".tsx"`.
pub fn filetype_for_extension(extension: &str) -> Option<&'static str> {
    let extension = normalize(extension)?;
    Some(match extension.as_str() {
        "astro" => "astro",
        "bash" | "ksh" | "sh" | "zsh" => "bash",
        "c" | "h" => "c",
        "cc" | "cpp" | "cxx" | "hpp" | "hxx" | "h++" | "hh" | "c++" => "cpp",
        "cjs" | "js" | "mjs" => "javascript",
        "clj" | "cljs" | "cljc" | "edn" => "clojure",
        "cs" => "csharp",
        "cts" | "mts" | "ts" => "typescript",
        "ctsx" | "mtsx" | "tsx" => "typescriptreact",
        "dart" => "dart",
        "diff" | "patch" => "diff",
        "go" => "go",
        "gemspec" | "rb" | "rake" | "ru" => "ruby",
        "groovy" => "groovy",
        "handlebars" | "hbs" => "handlebars",
        "hrl" | "erl" => "erlang",
        "hs" => "haskell",
        "htm" | "html" => "html",
        "ini" => "ini",
        "jsx" => "javascriptreact",
        "jl" => "julia",
        "json" => "json",
        "kt" | "kts" => "kotlin",
        "latex" | "tex" => "latex",
        "less" => "less",
        "lua" => "lua",
        "markdown" | "md" | "mdown" | "mkd" => "markdown",
        "ml" | "mli" => "ocaml",
        "php" => "php",
        "pl" | "pm" => "perl",
        "ps1" | "psm1" => "powershell",
        "py" | "pyi" => "python",
        "r" => "r",
        "rs" => "rust",
        "sass" => "sass",
        "sc" | "scala" => "scala",
        "scss" => "scss",
        "sql" => "sql",
        "svelte" => "svelte",
        "swift" => "swift",
        "toml" => "toml",
        "vue" => "vue",
        "vim" => "vim",
        "xml" => "xml",
        "xsl" => "xsl",
        "yaml" | "yml" => "yaml",
        "zig" | "zon" => "zig",
        "exs" | "ex" => "elixir",
        "elm" => "elm",
        "fsharp" | "fs" | "fsx" | "fsscript" | "fsi" => "fsharp",
        "java" => "java",
        "css" => "css",
        _ => return None,
    })
}

/// The filetype for a file name with no telling extension, such as `Makefile` or `.bashrc`. Lowercase input only.
fn filetype_for_basename(basename: &str) -> Option<&'static str> {
    Some(match basename {
        ".bash_aliases" | ".bash_logout" | ".bash_profile" | ".bashrc" | ".kshrc" | ".profile" | ".zlogin"
        | ".zlogout" | ".zprofile" | ".zshenv" | ".zshrc" => "bash",
        ".vimrc" | "gvimrc" => "vim",
        "appfile" | "berksfile" | "brewfile" | "cheffile" | "fastfile" | "gemfile" | "guardfile" | "podfile"
        | "rakefile" | "thorfile" | "vagrantfile" => "ruby",
        "containerfile" | "dockerfile" => "dockerfile",
        "gnumakefile" | "makefile" => "make",
        _ => return None,
    })
}

/// Trims, drops a leading dot, and lowercases; `None` when nothing is left.
fn normalize(token: &str) -> Option<String> {
    let token = token.trim();
    let token = token.strip_prefix('.').unwrap_or(token).to_lowercase();
    (!token.is_empty()).then_some(token)
}

/// The filetype for a path, from its file name or extension: `"src/main.rs"` gives `"rust"`, `"Makefile"` gives
/// `"make"`. Both `/` and `\` separate directories.
pub fn filetype_for_path(path: &str) -> Option<&'static str> {
    let path = path.trim();
    let basename = path.rsplit(['/', '\\']).next().unwrap_or(path).to_lowercase();
    if basename.is_empty() {
        return None;
    }
    if let Some(filetype) = filetype_for_basename(&basename) {
        return Some(filetype);
    }
    let (_, extension) = basename.rsplit_once('.')?;
    filetype_for_extension(extension)
}

/// The filetype for a Markdown code fence's info string: its first word, read as a file name, a path, an
/// extension, or a filetype. ` ```ts ` gives `"typescript"` and ` ```rust ` gives `"rust"`; an unknown word comes
/// back lowercased. Unlike Core, a comma also ends the word, so rustdoc's ` ```rust,no_run ` gives `"rust"`.
pub fn filetype_for_info_string(info: &str) -> Option<String> {
    let token = info.split_whitespace().next()?.split(',').next()?;
    if let Some(filetype) = filetype_for_basename(&token.to_lowercase()) {
        return Some(filetype.to_owned());
    }
    let token = normalize(token)?;
    let known = filetype_for_basename(&token).or_else(|| filetype_for_path(&token));
    Some(known.or_else(|| filetype_for_extension(&token)).map_or(token, str::to_owned))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_resolve_by_file_name_then_extension() {
        assert_eq!(filetype_for_path("src/main.rs"), Some("rust"));
        assert_eq!(filetype_for_path("C:\\work\\App.TSX"), Some("typescriptreact"));
        assert_eq!(filetype_for_path("/home/me/.zshrc"), Some("bash"));
        assert_eq!(filetype_for_path("Makefile"), Some("make"));
        assert_eq!(filetype_for_path("notes."), None);
        assert_eq!(filetype_for_path("LICENSE"), None);
        assert_eq!(filetype_for_extension(".MJS"), Some("javascript"));
        assert_eq!(filetype_for_extension(""), None);
    }

    #[test]
    fn info_strings_resolve_like_core() {
        assert_eq!(filetype_for_info_string("ts").as_deref(), Some("typescript"));
        assert_eq!(filetype_for_info_string(" rust {.class} ").as_deref(), Some("rust"));
        assert_eq!(filetype_for_info_string("rust,no_run").as_deref(), Some("rust"));
        assert_eq!(filetype_for_info_string("Dockerfile").as_deref(), Some("dockerfile"));
        assert_eq!(filetype_for_info_string("main.zig").as_deref(), Some("zig"));
        assert_eq!(filetype_for_info_string("Haskell").as_deref(), Some("haskell"));
        assert_eq!(filetype_for_info_string("").as_deref(), None);
    }
}
