//! Tree-sitter highlighting: the grammar registry, captures, and their conversion to styled spans.
//!
//! Like Core's parser worker, this runs each grammar's highlight query over its tree and collects every capture as
//! a range with a name. Injections, such as code in Markdown fences, parse their part of the text with another
//! grammar, recursively, and add that grammar's captures.

use super::{SyntaxTheme, filetype_for_info_string};
use crate::style::Span;
use std::borrow::Cow;
use std::cmp::Reverse;
use std::collections::hash_map::Entry as Slot;
use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, OnceLock, PoisonError};
use tree_sitter::{InputEdit, Language, Node, Parser, Point, Query, QueryCursor, Range, StreamingIterator, Tree};

/// The tree-sitter crate this build uses, for grammars that need its types.
pub use tree_sitter;

/// A range of the source's bytes; [`Range`] is tree-sitter's, with points.
type ByteRange = std::ops::Range<usize>;

/// Injections nested deeper than this keep their host's captures only. Rust macros inject Rust into themselves.
const MAX_DEPTH: usize = 8;
/// Layers per highlight beyond this are skipped. A Markdown document has one per paragraph.
const MAX_LAYERS: usize = 4096;

/// The Markdown grammar's injections with their content kept whole. The crate's own query leaves a content node's
/// children out of the injected text, but the block grammar makes punctuation such as `*` and `;` anonymous
/// children of inline text and fenced code, so emphasis and code would not parse. Named children, such as the `> `
/// of a quote, stay out. Table cells are inline content too, as in Core.
const MARKDOWN_INJECTIONS: &str = r#"
(fenced_code_block
  (info_string (language) @injection.language)
  (code_fence_content) @injection.content
  (#set! injection.include-unnamed-children))
((html_block) @injection.content (#set! injection.language "html"))
((minus_metadata) @injection.content (#set! injection.language "yaml"))
((plus_metadata) @injection.content (#set! injection.language "toml"))
([(inline) (pipe_table_cell)] @injection.content
  (#set! injection.language "markdown_inline")
  (#set! injection.include-unnamed-children))
"#;

/// A tree-sitter grammar with its queries, for [`register`].
///
/// Highlight queries follow tree-sitter's conventions: when several patterns capture one node, the last one wins.
/// Injection queries mark content with `@injection.content` and name its language with an `@injection.language`
/// capture or an `injection.language` property; `injection.include-children`,
/// `injection.include-unnamed-children`, and `injection.combined` work as in tree-sitter and Helix.
#[derive(Clone)]
pub struct Grammar {
    language: Language,
    highlights: Cow<'static, str>,
    injections: Cow<'static, str>,
    core: bool,
}

impl Grammar {
    /// A grammar and its highlight query, such as a grammar crate's `LANGUAGE` and `HIGHLIGHTS_QUERY`.
    pub fn new(language: impl Into<Language>, highlights: impl Into<Cow<'static, str>>) -> Self {
        Self { language: language.into(), highlights: highlights.into(), injections: Cow::Borrowed(""), core: false }
    }

    /// The injection query, which hands parts of the text to other grammars by filetype.
    pub fn injections(mut self, query: impl Into<Cow<'static, str>>) -> Self {
        self.injections = query.into();
        self
    }

    /// Highlights as Core does, for Core's nvim-treesitter queries. A node keeps every capture instead of the last
    /// pattern's, so `(comment) @comment @spell` styles with both. When this grammar is the one highlighted,
    /// [`highlights`] orders all captures, injected ones included, as Core cascades their styles: fewer dotted parts
    /// first, then by start. A `markup.raw.block` capture around injected text is dropped, as Core suppresses it.
    pub fn core_captures(mut self) -> Self {
        self.core = true;
        self
    }

    /// Compiles the queries, as [`register`] does, for [`register_lazy`].
    pub fn compile(&self) -> Result<CompiledGrammar, GrammarError> {
        compile(self).map(CompiledGrammar)
    }
}

impl std::fmt::Debug for Grammar {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("Grammar").field("language", &self.language.name()).finish_non_exhaustive()
    }
}

/// Why [`register`] rejected a grammar.
#[derive(Debug)]
pub enum GrammarError {
    /// The grammar was generated for a tree-sitter version this build cannot load.
    Language(tree_sitter::LanguageError),
    /// A query does not compile against the grammar.
    Query(tree_sitter::QueryError),
}

impl std::fmt::Display for GrammarError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Language(error) => write!(formatter, "unsupported grammar: {error}"),
            Self::Query(error) => write!(formatter, "invalid query: {error}"),
        }
    }
}

impl std::error::Error for GrammarError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Language(error) => Some(error),
            Self::Query(error) => Some(error),
        }
    }
}

/// A capture: a byte range of the source and the query's name for it, Core's `SimpleHighlight`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Capture {
    pub start: usize,
    pub end: usize,
    /// The capture name, such as `keyword` or `function.method`.
    pub name: &'static str,
}

/// A grammar with its queries compiled, from [`Grammar::compile`], for [`register_lazy`].
pub struct CompiledGrammar(Compiled);

impl std::fmt::Debug for CompiledGrammar {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("CompiledGrammar").field("language", &self.0.language.name()).finish_non_exhaustive()
    }
}

/// A grammar with its queries compiled.
struct Compiled {
    language: Language,
    highlights: Query,
    /// Interned names of the highlight query's captures; `None` for private ones, which start with `_`.
    names: Vec<Option<&'static str>>,
    injections: Option<Injections>,
    core: bool,
}

struct Injections {
    query: Query,
    content: Option<u32>,
    language: Option<u32>,
}

/// Loads a grammar the first time it is highlighted.
type Load = Box<dyn Fn() -> Option<Compiled> + Send + Sync>;

/// A registered grammar. Bundled and lazily registered grammars compile on first use; others when registered.
struct Entry {
    load: Load,
    compiled: OnceLock<Option<Compiled>>,
}

impl Entry {
    fn lazy(load: Load) -> Self {
        Self { load, compiled: OnceLock::new() }
    }

    fn compiled(&self) -> Option<&Compiled> {
        self.compiled.get_or_init(&self.load).as_ref()
    }
}

#[derive(Clone, Default)]
struct Registry {
    grammars: HashMap<String, Arc<Entry>>,
    aliases: HashMap<String, String>,
}

impl Registry {
    fn bundled() -> Self {
        let mut registry = Self::default();
        for (name, grammar) in bundled() {
            let load = Box::new(move || compile(&grammar).ok());
            registry.grammars.insert(name.to_owned(), Arc::new(Entry::lazy(load)));
        }
        registry.aliases.insert("javascriptreact".to_owned(), "javascript".to_owned());
        registry
    }

    /// The grammar for a filetype, an alias, or anything [`filetype_for_info_string`] resolves.
    fn resolve(&self, name: &str) -> Option<&Arc<Entry>> {
        let find = |name: &str| {
            let name = self.aliases.get(name).map_or(name, String::as_str);
            self.grammars.get(name)
        };
        find(name).or_else(|| find(&filetype_for_info_string(name)?))
    }
}

/// The grammars the `tree-sitter` feature bundles, by filetype.
fn bundled() -> [(&'static str, Grammar); 7] {
    use tree_sitter_javascript as js;
    use tree_sitter_md as md;
    use tree_sitter_rust as rust;
    use tree_sitter_typescript as ts;
    use tree_sitter_zig as zig;
    // Later patterns win, so TypeScript's own patterns go after the JavaScript ones they refine.
    let ecma = |language, queries: &[&str]| Grammar::new(language, queries.concat()).injections(js::INJECTIONS_QUERY);
    let (jsx, ts_only) = (js::JSX_HIGHLIGHT_QUERY, ts::HIGHLIGHTS_QUERY);
    [
        ("javascript", ecma(js::LANGUAGE, &[js::HIGHLIGHT_QUERY, jsx])),
        ("typescript", ecma(ts::LANGUAGE_TYPESCRIPT, &[js::HIGHLIGHT_QUERY, ts_only])),
        ("typescriptreact", ecma(ts::LANGUAGE_TSX, &[js::HIGHLIGHT_QUERY, jsx, ts_only])),
        ("markdown", Grammar::new(md::LANGUAGE, md::HIGHLIGHT_QUERY_BLOCK).injections(MARKDOWN_INJECTIONS)),
        (
            "markdown_inline",
            Grammar::new(md::INLINE_LANGUAGE, md::HIGHLIGHT_QUERY_INLINE).injections(md::INJECTION_QUERY_INLINE),
        ),
        ("rust", Grammar::new(rust::LANGUAGE, rust::HIGHLIGHTS_QUERY).injections(rust::INJECTIONS_QUERY)),
        ("zig", Grammar::new(zig::LANGUAGE, zig::HIGHLIGHTS_QUERY).injections(zig::INJECTIONS_QUERY)),
    ]
}

/// Shared, so a highlight takes a snapshot without copying it; a change copies it once if a highlight holds one.
static REGISTRY: LazyLock<Mutex<Arc<Registry>>> = LazyLock::new(|| Mutex::new(Arc::new(Registry::bundled())));

/// Every capture name compiled so far. Each distinct name is leaked once; grammars have a few dozen.
static NAMES: Mutex<BTreeSet<&'static str>> = Mutex::new(BTreeSet::new());

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn intern(name: &str) -> &'static str {
    let mut names = lock(&NAMES);
    if let Some(name) = names.get(name) {
        return name;
    }
    let name: &'static str = Box::leak(Box::from(name));
    names.insert(name);
    name
}

fn compile(grammar: &Grammar) -> Result<Compiled, GrammarError> {
    Parser::new().set_language(&grammar.language).map_err(GrammarError::Language)?;
    let highlights = Query::new(&grammar.language, &grammar.highlights).map_err(GrammarError::Query)?;
    let names = highlights.capture_names().iter().map(|name| (!name.starts_with('_')).then(|| intern(name))).collect();
    let injections = match grammar.injections.trim() {
        "" => None,
        source => {
            let query = Query::new(&grammar.language, source).map_err(GrammarError::Query)?;
            let content = query.capture_index_for_name("injection.content");
            let language = query.capture_index_for_name("injection.language");
            Some(Injections { query, content, language })
        }
    };
    Ok(Compiled { language: grammar.language.clone(), highlights, names, injections, core: grammar.core })
}

/// Registers or replaces the grammar for a filetype, compiling its queries now. Widgets use it the next time they
/// highlight.
pub fn register(filetype: &str, grammar: Grammar) -> Result<(), GrammarError> {
    let compiled = compile(&grammar)?;
    insert(filetype, Entry { load: Box::new(|| None), compiled: OnceLock::from(Some(compiled)) });
    Ok(())
}

/// Registers or replaces the grammar for a filetype without compiling anything. `load` runs, once, the first time a
/// highlight needs the filetype, on the thread that highlights; `None` leaves it plain. Registering many grammars this
/// way costs nothing until each is shown, as the bundled ones do.
///
/// ```ignore
/// use opentui::syntax::{Grammar, register_lazy};
/// register_lazy("python", || {
///     Grammar::new(tree_sitter_python::LANGUAGE, tree_sitter_python::HIGHLIGHTS_QUERY).compile().ok()
/// });
/// ```
pub fn register_lazy(filetype: &str, load: impl Fn() -> Option<CompiledGrammar> + Send + Sync + 'static) {
    insert(filetype, Entry::lazy(Box::new(move || load().map(|grammar| grammar.0))));
}

fn insert(filetype: &str, entry: Entry) {
    let mut registry = lock(&REGISTRY);
    let registry = Arc::make_mut(&mut registry);
    registry.aliases.remove(filetype);
    registry.grammars.insert(filetype.to_owned(), Arc::new(entry));
}

/// Makes `alias` another name for the grammar of `filetype`.
pub fn register_alias(alias: &str, filetype: &str) {
    Arc::make_mut(&mut lock(&REGISTRY)).aliases.insert(alias.to_owned(), filetype.to_owned());
}

/// The filetypes with a grammar, bundled or registered, sorted.
pub fn filetypes() -> Vec<String> {
    let mut names: Vec<String> = lock(&REGISTRY).grammars.keys().cloned().collect();
    names.sort();
    names
}

/// Whether a filetype has a grammar. It accepts what widgets accept: a filetype, an alias, or anything
/// [`filetype_for_info_string`] resolves, such as `"rs"` or `"main.rs"`.
pub fn has_grammar(filetype: &str) -> bool {
    lock(&REGISTRY).resolve(filetype).is_some()
}

/// Compiles the grammar for a filetype now, if nothing has yet, so the first highlight that needs it does not pay for
/// it. Call it from a worker thread before the text is shown: a highlight that needs the grammar while this compiles
/// waits for it, and nothing compiles twice. Returns whether the filetype, resolved as [`has_grammar`] does, has a
/// grammar that compiles; calls after the first cost a lookup. Grammars it injects, such as the languages of
/// Markdown fences, compile when first needed unless they are prewarmed too.
pub fn prewarm(filetype: &str) -> bool {
    // The lock is held only to look up the entry, so other highlights go on while this compiles.
    let entry = lock(&REGISTRY).resolve(filetype).cloned();
    entry.is_some_and(|entry| entry.compiled().is_some())
}

/// How an injection treats its content node's children.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Children {
    Exclude,
    ExcludeNamed,
    Include,
}

/// Text an injection hands to another grammar.
struct Target {
    language: String,
    ranges: Vec<Range>,
    /// The injection pattern, for combined injections, whose matches in one language parse as one text.
    combined: Option<usize>,
}

/// One highlight call: the parser and query cursor its layers share, and the captures they found.
struct Run<'a> {
    source: &'a str,
    registry: &'a Registry,
    parser: Parser,
    cursor: QueryCursor,
    captures: Vec<(Capture, usize, usize)>,
    layers: usize,
}

impl<'a> Run<'a> {
    /// Highlights the text in `ranges`, all of it when empty, then its injections. Returns the layer's tree, parsed
    /// reusing `old`, an edited tree of the text, if given.
    fn layer(&mut self, compiled: &'a Compiled, ranges: &[Range], depth: usize, old: Option<&Tree>) -> Option<Tree> {
        self.layers += 1;
        self.parser.set_language(&compiled.language).ok()?;
        self.parser.set_included_ranges(ranges).ok()?;
        let tree = self.parser.parse(self.source, old)?;
        let bytes = self.source.as_bytes();
        let first = self.captures.len();
        // The last pattern that captures a node wins, unless the grammar keeps every capture as Core does.
        let mut by_node: HashMap<usize, usize> = HashMap::new();
        let mut captures = self.cursor.captures(&compiled.highlights, tree.root_node(), bytes);
        while let Some((found, index)) = captures.next() {
            let capture = found.captures()[*index];
            let Some(name) = compiled.names[capture.index as usize] else { continue };
            let named = Capture { start: capture.node.start_byte(), end: capture.node.end_byte(), name };
            let entry = (named, depth, found.pattern_index);
            if compiled.core {
                self.captures.push(entry);
                continue;
            }
            match by_node.entry(capture.node.id()) {
                Slot::Occupied(slot) => {
                    let kept = &mut self.captures[*slot.get()];
                    if entry.2 >= kept.2 {
                        *kept = entry;
                    }
                }
                Slot::Vacant(slot) => {
                    slot.insert(self.captures.len());
                    self.captures.push(entry);
                }
            }
        }
        let Some(injections) = compiled.injections.as_ref().filter(|_| depth < MAX_DEPTH) else { return Some(tree) };
        let mut targets: Vec<Target> = Vec::new();
        let mut matches = self.cursor.matches(&injections.query, tree.root_node(), bytes);
        while let Some(found) = matches.next() {
            let properties = injections.query.property_settings(found.pattern_index);
            let property = |key: &str| properties.iter().find(|property| &*property.key == key);
            let mut language = property("injection.language").and_then(|property| property.value.as_deref());
            let mut nodes = Vec::new();
            for capture in found.captures() {
                if Some(capture.index) == injections.language {
                    language = capture.node.utf8_text(bytes).ok();
                } else if Some(capture.index) == injections.content {
                    nodes.push(capture.node);
                }
            }
            let Some(language) = language.filter(|_| !nodes.is_empty()) else { continue };
            let children = if property("injection.include-children").is_some() {
                Children::Include
            } else if property("injection.include-unnamed-children").is_some() {
                Children::ExcludeNamed
            } else {
                Children::Exclude
            };
            let content: Vec<Range> = nodes.into_iter().flat_map(|node| content_ranges(node, children)).collect();
            let combined = property("injection.combined").map(|_| found.pattern_index);
            let joins =
                |target: &&mut Target| combined.is_some() && target.combined == combined && target.language == language;
            match targets.iter_mut().find(joins) {
                Some(target) => target.ranges.extend(content),
                None => targets.push(Target { language: language.to_owned(), ranges: content, combined }),
            }
        }
        let registry = self.registry;
        let mut layered = Vec::new();
        for mut target in targets {
            let Some(injected) = registry.resolve(&target.language).and_then(|entry| entry.compiled()) else {
                continue;
            };
            target.ranges.sort_by_key(|range| range.start_byte);
            let target_ranges = intersect(&target.ranges, ranges);
            if !target_ranges.is_empty() {
                layered.push((injected, target_ranges));
            }
        }
        if compiled.core {
            // Core's treeSitterToTextChunks drops `markup.raw.block` inside any capture that contains injected text,
            // such as a fenced block and its fences, unless the capture is itself inside injected text.
            let injected: Vec<ByteRange> =
                layered.iter().flat_map(|(_, ranges)| ranges).map(|range| range.start_byte..range.end_byte).collect();
            let within =
                |capture: &Capture, outer: &ByteRange| outer.start <= capture.start && capture.end <= outer.end;
            let containers: Vec<ByteRange> = self.captures[first..]
                .iter()
                .map(|(capture, ..)| capture.start..capture.end)
                .filter(|range| injected.iter().any(|inner| range.start <= inner.start && inner.end <= range.end))
                .collect();
            let mut index = 0;
            self.captures.retain(|(capture, ..)| {
                index += 1;
                index <= first
                    || capture.name != "markup.raw.block"
                    || injected.iter().any(|range| within(capture, range))
                    || !containers.iter().any(|range| within(capture, range))
            });
        }
        for (injected, target_ranges) in layered {
            if self.layers >= MAX_LAYERS {
                break;
            }
            // A layer that fails to parse leaves its host's captures.
            let _ = self.layer(injected, &target_ranges, depth + 1, None);
        }
        Some(tree)
    }
}

/// A node's ranges, without the children an injection leaves out.
fn content_ranges(node: Node<'_>, children: Children) -> Vec<Range> {
    let mut ranges = Vec::new();
    let (mut start_byte, mut start_point) = (node.start_byte(), node.start_position());
    if children != Children::Include {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if children == Children::ExcludeNamed && !child.is_named() {
                continue;
            }
            if child.start_byte() > start_byte {
                let (end_byte, end_point) = (child.start_byte(), child.start_position());
                ranges.push(Range { start_byte, start_point, end_byte, end_point });
            }
            if child.end_byte() > start_byte {
                (start_byte, start_point) = (child.end_byte(), child.end_position());
            }
        }
    }
    if node.end_byte() > start_byte {
        ranges.push(Range { start_byte, start_point, end_byte: node.end_byte(), end_point: node.end_position() });
    }
    ranges
}

/// The parts of sorted `ranges` inside sorted `parents`, or `ranges` when there are no parents.
fn intersect(ranges: &[Range], parents: &[Range]) -> Vec<Range> {
    if parents.is_empty() {
        return ranges.to_vec();
    }
    let mut result = Vec::new();
    for range in ranges {
        for parent in parents.iter().filter(|parent| parent.start_byte < range.end_byte) {
            if parent.end_byte <= range.start_byte {
                continue;
            }
            let start = if parent.start_byte > range.start_byte { parent } else { range };
            let end = if parent.end_byte < range.end_byte { parent } else { range };
            result.push(Range {
                start_byte: start.start_byte,
                start_point: start.start_point,
                end_byte: end.end_byte,
                end_point: end.end_point,
            });
        }
    }
    result
}

/// The captures in `source`, sorted by start with enclosing captures first, or `None` without a grammar for
/// `filetype` or when parsing fails. Injected grammars' captures follow the captures of the text around them. For a
/// grammar with [`Grammar::core_captures`], the order is Core's cascade instead: fewer dotted parts first, then start.
pub fn highlights(source: &str, filetype: &str) -> Option<Vec<Capture>> {
    // A snapshot, so injected grammars resolve without holding the lock.
    let registry = Arc::clone(&lock(&REGISTRY));
    let compiled = registry.resolve(filetype)?.compiled()?;
    let padded = padded(compiled, source).then(|| format!("{source}\n"));
    Some(captures(&registry, compiled, padded.as_deref().unwrap_or(source), source.len(), None)?.0)
}

/// tree-sitter-md parses a heading that opens the text and ends it without a line ending as an error, where Core's
/// build recovers the heading, as in a diff of a new Markdown file. With the line ending added, it is a heading.
fn padded(compiled: &Compiled, source: &str) -> bool {
    compiled.language.name() == Some("markdown") && !source.is_empty() && !source.ends_with('\n')
}

/// The captures in the first `len` bytes of `source`, as [`highlights`] returns them, and the tree, parsed reusing
/// `old`, an edited tree of the text, if given.
fn captures(
    registry: &Registry,
    compiled: &Compiled,
    source: &str,
    len: usize,
    old: Option<&Tree>,
) -> Option<(Vec<Capture>, Tree)> {
    let mut run =
        Run { source, registry, parser: Parser::new(), cursor: QueryCursor::new(), captures: Vec::new(), layers: 0 };
    let tree = run.layer(compiled, &[], 0, old)?;
    let mut captures = run.captures;
    captures.retain_mut(|(capture, ..)| {
        capture.end = capture.end.min(len);
        let (start, end) = (capture.start, capture.end);
        start < end && source.is_char_boundary(start) && source.is_char_boundary(end)
    });
    if compiled.core {
        // Core sorts by start and then merges the styles over a piece by dotted parts, then that order. The sorts
        // are stable, so captures of one node keep the query's order.
        captures.sort_by_key(|(capture, ..)| capture.start);
        captures.sort_by_key(|(capture, ..)| capture.name.split('.').count());
    } else {
        captures.sort_by_key(|(capture, depth, pattern)| (capture.start, Reverse(capture.end), *depth, *pattern));
    }
    Some((captures.into_iter().map(|(capture, ..)| capture).collect(), tree))
}

/// A highlighter that keeps its tree, for a widget whose text changes in place. Each update edits the tree by the
/// changed bytes and parses again reusing it, then queries the whole tree, so the result is a whole highlight of the
/// widget's own tree whatever changed. Injected text parses afresh.
pub(crate) struct Incremental {
    filetype: String,
    /// The grammar of the last parse and its tree. A grammar registered for the filetype since parses afresh.
    tree: Option<(Arc<Entry>, Tree)>,
    /// The text of the tree: the text highlighted last, with Markdown's added line ending if `padded`.
    text: String,
    padded: bool,
    /// The texts highlighted since the last parse without a tree, for tests to replay.
    #[cfg(test)]
    texts: Vec<String>,
}

#[cfg(test)]
thread_local! {
    /// Parses without a tree on this thread, for tests: a highlighter replaced since still counts.
    pub(crate) static FRESH_PARSES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

impl Incremental {
    pub(crate) fn new(filetype: &str) -> Self {
        Self {
            filetype: filetype.to_owned(),
            tree: None,
            text: String::new(),
            padded: false,
            #[cfg(test)]
            texts: Vec::new(),
        }
    }

    /// Whether the filetype has a grammar that compiles, as [`Self::update`] needs.
    pub(crate) fn has_grammar(&self) -> bool {
        prewarm(&self.filetype)
    }

    /// The text highlighted last.
    pub(crate) fn text(&self) -> &str {
        &self.text[..self.text.len() - usize::from(self.padded)]
    }

    /// Highlights `text` as [`highlights`] and [`named_ranges`] do, after a parse that reuses the tree of the text
    /// highlighted last. The edit is the bytes between their common start and their common end, which is valid for
    /// any change, so tree-sitter reparses at least what changed. `None` as [`highlights`].
    pub(crate) fn update(&mut self, mut text: String) -> Option<super::NamedRanges> {
        // Taken first, so a tree and its text are kept together or not at all.
        let (last, old) = (self.tree.take(), std::mem::take(&mut self.text));
        self.padded = false;
        let registry = Arc::clone(&lock(&REGISTRY));
        let entry = registry.resolve(&self.filetype)?;
        let compiled = entry.compiled()?;
        let len = text.len();
        if padded(compiled, &text) {
            text.push('\n');
        }
        let reused = last.filter(|(last, _)| Arc::ptr_eq(last, entry)).map(|(_, mut tree)| {
            tree.edit(&edit(old.as_bytes(), text.as_bytes()));
            tree
        });
        #[cfg(test)]
        {
            FRESH_PARSES.set(FRESH_PARSES.get() + usize::from(reused.is_none()));
            if reused.is_none() {
                self.texts.clear();
            }
            self.texts.push(text[..len].to_owned());
        }
        let (captures, tree) = captures(&registry, compiled, &text, len, reused.as_ref())?;
        self.padded = text.len() > len;
        (self.tree, self.text) = (Some((Arc::clone(entry), tree)), text);
        Some(named_ranges(&self.text[..len], &captures))
    }
}

/// The edit from `old` to `new`: the bytes between their common start and, after it, their common end.
fn edit(old: &[u8], new: &[u8]) -> InputEdit {
    let start = old.iter().zip(new).take_while(|(old, new)| old == new).count();
    let same = |(old, new): &(&u8, &u8)| old == new;
    let tail = old[start..].iter().rev().zip(new[start..].iter().rev()).take_while(same).count();
    let (old_end, new_end) = (old.len() - tail, new.len() - tail);
    let start_position = advance(Point::default(), &new[..start]);
    InputEdit {
        start_byte: start,
        old_end_byte: old_end,
        new_end_byte: new_end,
        start_position,
        old_end_position: advance(start_position, &old[start..old_end]),
        new_end_position: advance(start_position, &new[start..new_end]),
    }
}

/// The position after `bytes` from `point`: rows are lines, columns bytes.
fn advance(point: Point, bytes: &[u8]) -> Point {
    match bytes.iter().rposition(|&byte| byte == b'\n') {
        Some(last) => Point {
            row: point.row + bytes.iter().filter(|&&byte| byte == b'\n').count(),
            column: bytes.len() - last - 1,
        },
        None => Point { row: point.row, column: point.column + bytes.len() },
    }
}

/// Styles `source` from its captures, as Core's `treeSitterToTextChunks`: text no capture covers gets the theme's
/// `default` style, and covered text gets `default` with each covering capture's style on top, later captures over
/// earlier ones. Unlike Core, which orders them by name length, the order is the list's: [`highlights`] puts inner
/// captures after the ones enclosing them. A capture named `none` clears the styles under it, as in Neovim.
pub fn spans(source: &str, captures: &[Capture], theme: &SyntaxTheme) -> Vec<Span<'static>> {
    let pieces = super::styled_ranges(named_ranges(source, captures), theme);
    pieces.into_iter().map(|(range, style)| Span::styled(source[range].to_owned(), style)).collect()
}

/// The lists of names whose styles [`spans`] merges, in order, and the pieces of `source` with the index of their
/// list: byte ranges in order that cover the source, neighbors with one list joined. A list holds `default`, then the
/// covering captures after the last `none`, each name at its last place.
pub(crate) fn named_ranges(source: &str, captures: &[Capture]) -> super::NamedRanges {
    // Ends sort before starts at one offset, so a range closes before the next one opens.
    let mut boundaries: Vec<(usize, bool, usize)> = Vec::with_capacity(captures.len() * 2);
    for (index, capture) in captures.iter().enumerate() {
        let (start, end) = (capture.start, capture.end);
        if start < end && source.get(start..end).is_some() {
            boundaries.extend([(start, true, index), (end, false, index)]);
        }
    }
    boundaries.sort_unstable();
    let (mut named, mut names): (super::NamedRanges, Vec<&'static str>) = Default::default();
    let (lists, pieces) = &mut named;
    let mut push = |range: ByteRange, active: &[usize]| {
        let after_none = active.iter().rposition(|&index| captures[index].name == "none").map_or(0, |at| at + 1);
        names.clear();
        names.push("default");
        for &index in &active[after_none..] {
            // A name again adds nothing to the merge but its place.
            names.retain(|&name| name != captures[index].name);
            names.push(captures[index].name);
        }
        let list = lists.iter().position(|list| *list == names).unwrap_or_else(|| {
            lists.push(names.clone());
            lists.len() - 1
        });
        match pieces.last_mut() {
            Some((last, last_list)) if *last_list == list => last.end = range.end,
            _ => pieces.push((range, list)),
        }
    };
    let (mut active, mut offset): (Vec<usize>, usize) = (Vec::new(), 0);
    for (at, start, index) in boundaries {
        if offset < at {
            push(offset..at, &active);
            offset = at;
        }
        match (active.binary_search(&index), start) {
            (Err(slot), true) => active.insert(slot, index),
            (Ok(slot), false) => _ = active.remove(slot),
            _ => {}
        }
    }
    if offset < source.len() {
        push(offset..source.len(), &[]);
    }
    named
}

/// Highlights `source` as `filetype` with `theme`: [`highlights`], then [`spans`].
pub fn highlight(source: &str, filetype: &str, theme: &SyntaxTheme) -> Option<Vec<Span<'static>>> {
    Some(spans(source, &highlights(source, filetype)?, theme))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::style::{Color, Style};

    /// A theme with a color of its own for every capture name of the Rust, JavaScript and Markdown grammars, for tests
    /// that read capture names from frames.
    pub(crate) fn injective_theme() -> SyntaxTheme {
        for filetype in ["rust", "javascript", "markdown", "markdown_inline"] {
            prewarm(filetype);
        }
        let names = lock(&NAMES).clone();
        let color = |index: usize| Color::rgb(index as u8, (index >> 8) as u8, 7);
        names.into_iter().enumerate().map(|(index, name)| (name, Style::new().fg(color(index)))).collect()
    }

    /// C4 invariant 1: the styled byte ranges a widget's syntax layer over `text` shows with `theme`, covering it in
    /// order as `highlight` styles it, and whether a fresh parse of `text` has an error. They are a fresh highlight's
    /// (1a), and where a fresh parse has an error, with `own`, the widget's highlighter that highlighted `text` last,
    /// those of its texts replayed here (1b). `None` without a grammar.
    pub(crate) fn expected_ranges(
        text: &str,
        filetype: &str,
        own: Option<&Incremental>,
        theme: &SyntaxTheme,
    ) -> Option<(super::super::StyledRanges, bool)> {
        let registry = Arc::clone(&lock(&REGISTRY));
        let compiled = registry.resolve(filetype)?.compiled()?;
        let source = if padded(compiled, text) { format!("{text}\n") } else { text.to_owned() };
        let (captures, tree) = captures(&registry, compiled, &source, text.len(), None)?;
        let error = tree.root_node().has_error();
        let own = own.filter(|_| error).map(|own| {
            assert_eq!(own.texts.last().map(String::as_str), Some(text), "the highlighter is of another text");
            replay(&registry, compiled, &own.texts)
        });
        Some((super::super::styled_ranges(own.unwrap_or_else(|| named_ranges(text, &captures)), theme), error))
    }

    /// The highlight after `texts`: a fresh parse of the first, then each next text parsed reusing the tree, edited
    /// by an edit worked out here rather than by `edit`.
    fn replay(registry: &Registry, compiled: &Compiled, texts: &[String]) -> crate::syntax::NamedRanges {
        let (mut tree, mut old, mut named) = (None::<Tree>, String::new(), Default::default());
        for text in texts {
            let new = if padded(compiled, text) { format!("{text}\n") } else { text.clone() };
            if let Some(tree) = &mut tree {
                tree.edit(&reference_edit(old.as_bytes(), new.as_bytes()));
            }
            let (captures, next) = captures(registry, compiled, &new, text.len(), tree.as_ref()).expect("a parse");
            (named, tree, old) = (named_ranges(text, &captures), Some(next), new);
        }
        named
    }

    /// The design's edit by indices: the longest common start, then the longest common end of what follows it, with
    /// positions counted from the start of each text.
    fn reference_edit(old: &[u8], new: &[u8]) -> InputEdit {
        let mut start = 0;
        while start < old.len() && start < new.len() && old[start] == new[start] {
            start += 1;
        }
        let mut tail = 0;
        while start + tail < old.len()
            && start + tail < new.len()
            && old[old.len() - 1 - tail] == new[new.len() - 1 - tail]
        {
            tail += 1;
        }
        let position = |text: &[u8], at: usize| {
            let line_start = text[..at].iter().rposition(|&byte| byte == b'\n').map_or(0, |line| line + 1);
            Point { row: text[..at].iter().filter(|&&byte| byte == b'\n').count(), column: at - line_start }
        };
        InputEdit {
            start_byte: start,
            old_end_byte: old.len() - tail,
            new_end_byte: new.len() - tail,
            start_position: position(new, start),
            old_end_position: position(old, old.len() - tail),
            new_end_position: position(new, new.len() - tail),
        }
    }

    /// The captured text and names, for readable assertions.
    fn captured(source: &str, filetype: &str) -> Vec<(String, &'static str)> {
        let captures = highlights(source, filetype).expect("a bundled grammar");
        captures.iter().map(|capture| (source[capture.start..capture.end].to_owned(), capture.name)).collect()
    }

    fn has(captures: &[(String, &str)], text: &str, name: &str) -> bool {
        captures.iter().any(|(captured, captured_name)| captured == text && *captured_name == name)
    }

    #[test]
    fn every_bundled_grammar_compiles() {
        for (name, grammar) in bundled() {
            if let Err(error) = grammar.compile() {
                panic!("{name}: {error}");
            }
        }
    }

    #[test]
    fn lazy_grammars_compile_on_first_highlight_only() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static LOADS: AtomicUsize = AtomicUsize::new(0);
        register_lazy("lazy-rust", || {
            LOADS.fetch_add(1, Ordering::SeqCst);
            Grammar::new(tree_sitter_rust::LANGUAGE, "(identifier) @variable").compile().ok()
        });
        register_alias("lr", "lazy-rust");
        assert!(has_grammar("lr"));
        assert_eq!(LOADS.load(Ordering::SeqCst), 0);
        assert_eq!(captured("x", "lr"), [("x".to_owned(), "variable")]);
        assert_eq!(captured("y", "lazy-rust"), [("y".to_owned(), "variable")]);
        assert!(prewarm("lr") && prewarm("lazy-rust"));
        assert_eq!(LOADS.load(Ordering::SeqCst), 1);
        // A load that fails leaves the filetype plain, and is not retried.
        static FAILS: AtomicUsize = AtomicUsize::new(0);
        register_lazy("lazy-broken", || {
            FAILS.fetch_add(1, Ordering::SeqCst);
            Grammar::new(tree_sitter_rust::LANGUAGE, "(no_such_node) @x").compile().ok()
        });
        assert!(!prewarm("lazy-broken") && highlights("x", "lazy-broken").is_none());
        assert!(highlights("x", "lazy-broken").is_none() && !prewarm("lazy-broken"));
        assert_eq!(FAILS.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_highlight_waits_for_a_prewarm_on_a_worker() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::mpsc;
        static LOADS: AtomicUsize = AtomicUsize::new(0);
        let (started, compiling) = mpsc::channel();
        register_lazy("prewarm-rust", move || {
            LOADS.fetch_add(1, Ordering::SeqCst);
            started.send(()).unwrap();
            let rust = Grammar::new(tree_sitter_rust::LANGUAGE, tree_sitter_rust::HIGHLIGHTS_QUERY);
            rust.injections(tree_sitter_rust::INJECTIONS_QUERY).compile().ok()
        });
        let worker = std::thread::spawn(|| prewarm("prewarm-rust"));
        compiling.recv_timeout(std::time::Duration::from_secs(30)).expect("the worker compiles");
        // The worker is compiling, so this waits for its grammar instead of compiling another or staying plain.
        let source = "fn main() { println!(\"{}\", 1); }\n";
        assert_eq!(highlights(source, "prewarm-rust"), highlights(source, "rust"));
        assert!(worker.join().unwrap() && prewarm("prewarm-rust"));
        assert_eq!(LOADS.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn rust_code_gets_tree_sitter_captures() {
        let captures = captured("fn main() {\n    let s = \"hi\"; // note\n    println!(\"{s}\");\n}\n", "rust");
        assert!(has(&captures, "fn", "keyword"), "{captures:?}");
        assert!(has(&captures, "main", "function"), "{captures:?}");
        assert!(has(&captures, "\"hi\"", "string"), "{captures:?}");
        assert!(has(&captures, "// note", "comment"), "{captures:?}");
        assert!(has(&captures, "println", "function.macro"), "{captures:?}");
        // The macro's arguments are Rust too, injected into themselves.
        assert!(has(&captures, "\"{s}\"", "string"), "{captures:?}");
    }

    #[test]
    fn typescript_refines_javascript() {
        let captures = captured("function f(n: number): string { return `${n}` }\n", "ts");
        assert!(has(&captures, "function", "keyword"), "{captures:?}");
        assert!(has(&captures, "f", "function"), "{captures:?}");
        assert!(has(&captures, "number", "type.builtin"), "{captures:?}");
        assert!(has(&captures, "n", "variable.parameter"), "{captures:?}");
        let tsx = captured("const view = <Box title=\"x\" />;\n", "tsx");
        assert!(has(&tsx, "title", "attribute"), "{tsx:?}");
    }

    #[test]
    fn markdown_injects_inline_markup_and_fenced_code() {
        let source = "# Title\n\nSome **bold** text.\n\n```rust\nlet x = a::B;\n```\n\n> ```rust\n> x;\n> ```\n";
        let captures = captured(source, "markdown");
        assert!(has(&captures, "Title", "text.title"), "{captures:?}");
        assert!(has(&captures, "**bold**", "text.strong"), "{captures:?}");
        // A heading that is the whole text, without a line ending, is a heading too.
        assert!(has(&captured("# Title", "markdown"), "Title", "text.title"));
        assert!(has(&captures, "let", "keyword"), "{captures:?}");
        // Punctuation is part of the code, but a quote's markers are not.
        assert!(has(&captures, "::", "punctuation.delimiter"), "{captures:?}");
        assert!(has(&captures, "B", "type") || has(&captures, "B", "constructor"), "{captures:?}");
        assert!(has(&captures, ";", "punctuation.delimiter"), "{captures:?}");
        // The fence's content clears the code block's style, so unhighlighted code keeps the default.
        let theme = SyntaxTheme::new().style("text.literal", Style::new().fg(Color::GREEN));
        let spans = spans(source, &highlights(source, "markdown").unwrap(), &theme);
        let x = spans.iter().find(|span| span.content.contains(" x = ")).unwrap();
        assert_eq!(x.style, Style::new(), "{spans:?}");
    }

    #[test]
    fn core_captures_keep_every_capture_in_cores_cascade() {
        let query = "(line_comment) @comment @spell\n(identifier) @variable\n\
                     (call_expression function: (identifier) @function.call)\n";
        register("core-rust", Grammar::new(tree_sitter_rust::LANGUAGE, query).core_captures()).unwrap();
        let captures = captured("f(x); // note\n", "core-rust");
        let on = |text: &str| -> Vec<&str> {
            captures.iter().filter(|(captured, _)| captured == text).map(|(_, name)| *name).collect()
        };
        assert_eq!(on("// note"), ["comment", "spell"]);
        // The more specific name comes later, so its style goes on top.
        assert_eq!(on("f"), ["variable", "function.call"]);
        let theme = SyntaxTheme::new()
            .style("comment", Style::new().fg(Color::GREEN).italic())
            .style("spell", Style::new().fg(Color::WHITE));
        let note = spans("// note", &highlights("// note", "core-rust").unwrap(), &theme);
        assert_eq!(note[0].style, Style::new().fg(Color::WHITE).italic());

        let query = "(fenced_code_block) @markup.raw.block\n(fenced_code_block_delimiter) @markup.raw.block\n";
        let markdown = Grammar::new(tree_sitter_md::LANGUAGE, query).injections(MARKDOWN_INJECTIONS).core_captures();
        register("core-markdown", markdown).unwrap();
        let fenced = |info: &str| {
            let source = format!("```{info}\nlet x = 1;\n```\n");
            let captures = captured(&source, "core-markdown");
            (has(&captures, &source, "markup.raw.block"), has(&captures, "```", "markup.raw.block"))
        };
        // Core drops the block's style and its fences' around injected code, and keeps both when no grammar takes
        // the fence.
        assert_eq!(fenced("rust"), (false, false));
        assert_eq!(fenced("cobol"), (true, true));
    }

    #[test]
    fn unknown_filetypes_have_no_grammar() {
        assert!(highlights("x", "cobol").is_none());
        assert!(has_grammar("rs") && has_grammar("main.zig") && has_grammar("JSX"));
        assert!(!has_grammar("cobol") && !prewarm("cobol"));
        assert!(prewarm("rs") && prewarm("main.zig"));
    }

    #[test]
    fn spans_cover_the_source_and_nest_styles() {
        let source = "ab cd ef";
        let captures = [
            Capture { start: 0, end: 5, name: "outer" },
            Capture { start: 3, end: 5, name: "inner.part" },
            Capture { start: 7, end: 99, name: "out_of_range" },
        ];
        let red = Style::new().fg(Color::RED);
        let theme = SyntaxTheme::new()
            .style("default", Style::new().fg(Color::WHITE))
            .style("outer", red)
            .style("inner", Style::new().bold());
        let spans = spans(source, &captures, &theme);
        let text: Vec<(&str, Style)> = spans.iter().map(|span| (&*span.content, span.style)).collect();
        let white = Style::new().fg(Color::WHITE);
        assert_eq!(text, [("ab ", red), ("cd", red.bold()), (" ef", white)]);
    }

    #[test]
    fn registered_grammars_and_aliases_resolve() {
        let rust = Grammar::new(tree_sitter_rust::LANGUAGE, "(identifier) @variable");
        register("rust-variables", rust).unwrap();
        register_alias("rv", "rust-variables");
        assert!(filetypes().contains(&"rust-variables".to_owned()));
        assert_eq!(captured("x", "rv"), [("x".to_owned(), "variable")]);
        let error = register("broken", Grammar::new(tree_sitter_rust::LANGUAGE, "(no_such_node) @x")).unwrap_err();
        assert!(matches!(error, GrammarError::Query(_)), "{error}");
        assert!(!has_grammar("broken"));
        // A highlighter reuses its tree only with the grammar that parsed it: one registered since parses afresh.
        let mut kept = Incremental::new("rv");
        kept.update("let x = 1;".to_owned());
        register("rust-variables", Grammar::new(tree_sitter_javascript::LANGUAGE, "(identifier) @variable")).unwrap();
        let text = "let x = 1; y".to_owned();
        assert_eq!(kept.update(text.clone()), Some(named_ranges(&text, &highlights(&text, "rv").unwrap())));
        // An alias that stops resolving keeps no tree of an older text for when it resolves again (bigboi-1).
        register_alias("c4-round", "rust");
        let mut round = Incremental::new("c4-round");
        round.update("fn main() { let x = 1; }\nfn g() {}\n".to_owned());
        register_alias("c4-round", "c4-nothing");
        assert!(round.update("// aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n".to_owned()).is_none());
        register_alias("c4-round", "rust");
        let text = "// aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n ".to_owned();
        assert_eq!(round.update(text.clone()), Some(named_ranges(&text, &highlights(&text, "rust").unwrap())));
    }
}
