//! Filetype names from paths, extensions, and Markdown info strings, by the rules and tables of Core's
//! `resolve-ft.ts`.

use crate::tables::{FILETYPE_BASENAMES, FILETYPE_EXTENSIONS};

fn lookup(table: &[(&str, &'static str)], key: &str) -> Option<&'static str> {
    table.iter().find(|(known, _)| *known == key).map(|&(_, filetype)| filetype)
}

/// The filetype for a file extension, with or without its dot, such as `"rs"` or `".tsx"`.
pub fn filetype_for_extension(extension: &str) -> Option<&'static str> {
    lookup(FILETYPE_EXTENSIONS, &normalize(extension)?)
}

/// The filetype for a file name with no telling extension, such as `Makefile` or `.bashrc`. Lowercase input only.
fn filetype_for_basename(basename: &str) -> Option<&'static str> {
    lookup(FILETYPE_BASENAMES, basename)
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
        // Every row of Core's tables, as an extension, a path, and an info string.
        for &(extension, filetype) in FILETYPE_EXTENSIONS {
            let path = format!("src/file.{}", extension.to_uppercase());
            let found = [filetype_for_extension(extension), filetype_for_path(&path)];
            assert_eq!(
                (found, filetype_for_info_string(extension).as_deref()),
                ([Some(filetype); 2], Some(filetype)),
                "{extension}"
            );
        }
        for &(basename, filetype) in FILETYPE_BASENAMES {
            let found = filetype_for_path(&format!("dir/{basename}"));
            assert_eq!(
                (found, filetype_for_info_string(basename).as_deref()),
                (Some(filetype), Some(filetype)),
                "{basename}"
            );
        }
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
