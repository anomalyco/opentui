use super::{
    AnyWidget, Behavior, Code, ColumnFitter, ColumnWidthMode, Container, Content, Element, Text, TextTable, View,
    Widget, build, handle,
};
use crate::app::App;
use crate::layout::{Edge, Gutter, LayoutProperty};
use crate::native::{NodeKind, WrapMode};
#[cfg(test)]
use crate::style::Attributes;
use crate::style::{Alignment, BorderStyle, Color, Sides, Span, Style};
use crate::syntax::{SyntaxTheme, filetype_for_info_string};
use crate::theme::Theme;
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::Arc;

/// A block of Markdown. Lists and quotes hold blocks of their own.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Block {
    Heading(u8, String),
    /// Inline text, with the source's line breaks.
    Paragraph(String),
    List(List),
    Quote(Vec<Block>),
    /// A code block's info string, if any, its code, and whether its fence is closed.
    Code(Option<String>, String, bool),
    Table(Table),
    Rule,
}

impl Block {
    /// Whether this block, or one inside it, matches.
    fn any(&self, matches: &impl Fn(&Block) -> bool) -> bool {
        matches(self)
            || match self {
                Block::List(list) => list.items.iter().flat_map(|item| &item.blocks).any(|block| block.any(matches)),
                Block::Quote(blocks) => blocks.iter().any(|block| block.any(matches)),
                _ => false,
            }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct List {
    /// The first number of an ordered list.
    start: Option<u64>,
    /// No blank lines between or inside items: items sit without gaps.
    tight: bool,
    items: Vec<Item>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Item {
    /// A task item's checkbox: checked or not.
    task: Option<bool>,
    blocks: Vec<Block>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Table {
    alignments: Vec<Alignment>,
    header: Vec<String>,
    rows: Vec<Vec<String>>,
}

/// Spaces of indentation, counting a tab as four.
fn indentation(line: &str) -> usize {
    line.chars().take_while(|c| *c == ' ' || *c == '\t').map(|c| if c == '\t' { 4 } else { 1 }).sum()
}

/// Removes up to `columns` columns of indentation.
fn dedent(line: &str, columns: usize) -> &str {
    let mut removed = 0;
    for (index, character) in line.char_indices() {
        if removed >= columns {
            return &line[index..];
        }
        match character {
            ' ' => removed += 1,
            '\t' => removed += 4,
            _ => return &line[index..],
        }
    }
    ""
}

fn is_blank(line: &str) -> bool {
    line.trim().is_empty()
}

/// An opening code fence: its character, length, and info string.
fn fence(line: &str) -> Option<(char, usize, &str)> {
    if indentation(line) > 3 {
        return None;
    }
    let trimmed = line.trim_start();
    let character = trimmed.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let length = trimmed.chars().take_while(|c| *c == character).count();
    let info = trimmed[length..].trim();
    (length >= 3 && !(character == '`' && info.contains('`'))).then_some((character, length, info))
}

fn heading(line: &str) -> Option<(u8, String)> {
    if indentation(line) > 3 {
        return None;
    }
    let trimmed = line.trim_start();
    let level = trimmed.bytes().take_while(|byte| *byte == b'#').count();
    let rest = &trimmed[level..];
    if !(1..=6).contains(&level) || !(rest.is_empty() || rest.starts_with([' ', '\t'])) {
        return None;
    }
    let text = rest.trim();
    // A closing run of #s goes, unless it is the whole text or glued to it.
    let text = match text.trim_end_matches('#') {
        stripped if stripped.is_empty() || stripped.ends_with([' ', '\t']) => stripped.trim_end(),
        _ => text,
    };
    Some((level as u8, text.to_owned()))
}

fn is_rule(line: &str) -> bool {
    let mut marks = line.chars().filter(|c| !c.is_whitespace());
    let Some(mark @ ('-' | '*' | '_')) = marks.next() else { return false };
    indentation(line) <= 3 && marks.try_fold(1, |count, c| (c == mark).then_some(count + 1)).is_some_and(|n| n >= 3)
}

/// A list item's start: whether it is ordered and its number, its delimiter, the column its content starts at, and
/// the content.
fn list_marker(line: &str) -> Option<(Option<u64>, char, usize, &str)> {
    let indent = indentation(line);
    if indent > 3 {
        return None;
    }
    let trimmed = line.trim_start();
    let (number, delimiter, marker_width) = match trimmed.chars().next()? {
        marker @ ('-' | '*' | '+') => (None, marker, 1),
        _ => {
            let digits = trimmed.bytes().take_while(u8::is_ascii_digit).count();
            let delimiter = trimmed[digits..].chars().next().filter(|c| *c == '.' || *c == ')')?;
            if !(1..=9).contains(&digits) {
                return None;
            }
            (Some(trimmed[..digits].parse::<u64>().ok()?), delimiter, digits + 1)
        }
    };
    let rest = &trimmed[marker_width..];
    if rest.is_empty() {
        return Some((number, delimiter, indent + marker_width + 1, ""));
    }
    let spaces = indentation(rest);
    if spaces == 0 {
        return None;
    }
    // Five or more spaces start indented code inside the item: the content starts one space in.
    let spaces = if spaces > 4 { 1 } else { spaces };
    Some((number, delimiter, indent + marker_width + spaces, dedent(rest, spaces)))
}

/// Splits a table row into cells at unescaped pipes, without the outer pipes.
fn cells(line: &str) -> Vec<String> {
    let line = line.trim();
    let line = line.strip_prefix('|').unwrap_or(line);
    let line = if line.ends_with('|') && !line.ends_with("\\|") { &line[..line.len() - 1] } else { line };
    let mut cells = vec![String::new()];
    let mut characters = line.chars().peekable();
    while let Some(character) = characters.next() {
        match character {
            '\\' if characters.peek() == Some(&'|') => {
                cells.last_mut().expect("cells is never empty").push('|');
                characters.next();
            }
            '|' => cells.push(String::new()),
            _ => cells.last_mut().expect("cells is never empty").push(character),
        }
    }
    cells.into_iter().map(|cell| cell.trim().to_owned()).collect()
}

/// A table's delimiter row, such as `| :--- | ---: |`, as alignments.
fn delimiter_row(line: &str) -> Option<Vec<Alignment>> {
    if !line.contains('-') || !line.contains(['|', ':']) && !line.trim_start().starts_with('-') {
        return None;
    }
    cells(line)
        .iter()
        .map(|cell| {
            let dashes = cell.trim_matches(':');
            (!dashes.is_empty() && dashes.bytes().all(|byte| byte == b'-')).then(|| {
                match (cell.starts_with(':'), cell.ends_with(':')) {
                    (true, true) => Alignment::Center,
                    (false, true) => Alignment::Right,
                    _ => Alignment::Left,
                }
            })
        })
        .collect()
}

/// Whether a line starts a block that interrupts a paragraph.
fn interrupts(line: &str) -> bool {
    fence(line).is_some()
        || heading(line).is_some()
        || is_rule(line)
        || line.trim_start().starts_with('>')
        || list_marker(line).is_some_and(|(number, _, _, content)| !content.is_empty() && number.is_none_or(|n| n == 1))
}

#[cfg(test)]
fn blocks(markdown: &str) -> Vec<Block> {
    document(markdown, 0).into_iter().map(|(_, block)| block).collect()
}

/// Parses Markdown blocks: ATX and setext headings, paragraphs with hard breaks, nested bullet, numbered, and task
/// lists, block quotes, fenced and indented code, GFM tables, and thematic breaks. It parses the source from byte
/// `from`, which starts a line, and returns the top-level blocks with the byte offsets they start at.
fn document(markdown: &str, from: usize) -> Vec<(usize, Block)> {
    let mut starts = Vec::new();
    let mut lines = Vec::new();
    let mut offset = from;
    for line in markdown[from..].split_inclusive('\n') {
        starts.push(offset);
        offset += line.len();
        let line = line.strip_suffix('\n').unwrap_or(line);
        lines.push(line.strip_suffix('\r').unwrap_or(line));
    }
    parse_lines(&lines).into_iter().map(|(line, block)| (starts[line], block)).collect()
}

fn parse(lines: &[&str]) -> Vec<Block> {
    parse_lines(lines).into_iter().map(|(_, block)| block).collect()
}

/// Parses blocks and the index of the line each starts at.
fn parse_lines(lines: &[&str]) -> Vec<(usize, Block)> {
    let mut blocks = Vec::new();
    let mut paragraph: Vec<&str> = Vec::new();
    // Inline parsing reads a trailing backslash as a hard break; trailing spaces break the line anyway.
    let flush = |paragraph: &mut Vec<&str>, blocks: &mut Vec<(usize, Block)>, index: usize| {
        if paragraph.is_empty() {
            return;
        }
        let text = paragraph.iter().map(|line| line.trim()).collect::<Vec<_>>().join("\n");
        blocks.push((index - paragraph.len(), Block::Paragraph(text)));
        paragraph.clear();
    };
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        let first = index;
        if is_blank(line) {
            flush(&mut paragraph, &mut blocks, index);
            index += 1;
        } else if let Some((character, length, info)) = fence(line) {
            flush(&mut paragraph, &mut blocks, index);
            let indent = indentation(line);
            let mut code = Vec::new();
            index += 1;
            // An unclosed fence runs to the end, as streamed text does until its fence arrives.
            let mut closed = false;
            while let Some(line) = lines.get(index) {
                index += 1;
                if fence(line).is_some_and(|(c, l, info)| c == character && l >= length && info.is_empty()) {
                    closed = true;
                    break;
                }
                code.push(dedent(line, indent));
            }
            let info = (!info.is_empty()).then(|| info.to_owned());
            blocks.push((first, Block::Code(info, code.join("\n"), closed)));
        } else if indentation(line) >= 4 && paragraph.is_empty() {
            let mut code = Vec::new();
            while let Some(line) = lines.get(index).filter(|line| is_blank(line) || indentation(line) >= 4) {
                code.push(dedent(line, 4));
                index += 1;
            }
            while code.last().is_some_and(|line| is_blank(line)) {
                code.pop();
            }
            blocks.push((first, Block::Code(None, code.join("\n"), true)));
        } else if let Some((level, text)) = heading(line) {
            flush(&mut paragraph, &mut blocks, index);
            blocks.push((first, Block::Heading(level, text)));
            index += 1;
        } else if !paragraph.is_empty() && indentation(line) <= 3 && {
            let marks = line.trim();
            !marks.is_empty() && (marks.bytes().all(|byte| byte == b'=') || marks.bytes().all(|byte| byte == b'-'))
        } {
            // A setext underline turns the paragraph above into a heading.
            let level = if line.trim().starts_with('=') { 1 } else { 2 };
            let text = paragraph.iter().map(|line| line.trim()).collect::<Vec<_>>().join(" ");
            blocks.push((index - paragraph.len(), Block::Heading(level, text)));
            paragraph.clear();
            index += 1;
        } else if is_rule(line) {
            flush(&mut paragraph, &mut blocks, index);
            blocks.push((first, Block::Rule));
            index += 1;
        } else if line.trim_start().starts_with('>') && indentation(line) <= 3 {
            flush(&mut paragraph, &mut blocks, index);
            let mut quoted = Vec::new();
            while let Some(line) = lines.get(index) {
                let trimmed = line.trim_start();
                if let Some(rest) = trimmed.strip_prefix('>').filter(|_| indentation(line) <= 3) {
                    quoted.push(rest.strip_prefix(' ').unwrap_or(rest));
                } else if !is_blank(line) && quoted.last().is_some_and(|last| !is_blank(last)) && !interrupts(line) {
                    // A lazy continuation of the quoted paragraph.
                    quoted.push(line);
                } else {
                    break;
                }
                index += 1;
            }
            blocks.push((first, Block::Quote(parse(&quoted))));
        } else if let Some((start, delimiter, _, content)) = list_marker(line).filter(|(number, _, _, content)| {
            paragraph.is_empty() || !content.is_empty() && number.is_none_or(|n| n == 1)
        }) {
            flush(&mut paragraph, &mut blocks, index);
            let _ = content;
            let mut list = List { start, tight: true, items: Vec::new() };
            let mut blank_between = false;
            while let Some((number, item_delimiter, width, content)) = lines.get(index).and_then(|l| list_marker(l)) {
                if item_delimiter != delimiter || number.is_some() != start.is_some() {
                    break;
                }
                if blank_between {
                    list.tight = false;
                }
                let mut item_lines = vec![content];
                index += 1;
                while let Some(line) = lines.get(index) {
                    if is_blank(line) {
                        item_lines.push("");
                    } else if indentation(line) >= width {
                        item_lines.push(dedent(line, width));
                    } else if item_lines.last().is_some_and(|last| !is_blank(last))
                        && !interrupts(line)
                        && list_marker(line).is_none()
                    {
                        // A lazy continuation of the item's paragraph.
                        item_lines.push(line.trim_start());
                    } else {
                        break;
                    }
                    index += 1;
                }
                // Blank lines at the end separate this item from the next.
                blank_between = item_lines.last().is_some_and(|last| is_blank(last));
                while item_lines.last().is_some_and(|last| is_blank(last)) {
                    item_lines.pop();
                }
                let item_blocks = parse(&item_lines);
                if item_blocks.len() > 1 && item_lines.iter().any(|line| is_blank(line)) {
                    list.tight = false;
                }
                let (task, item_blocks) = task(item_blocks);
                list.items.push(Item { task, blocks: item_blocks });
                if lines.get(index).is_some_and(|line| is_blank(line)) {
                    break;
                }
            }
            blocks.push((first, Block::List(list)));
        } else if paragraph.is_empty()
            && line.contains('|')
            && let Some(alignments) = lines.get(index + 1).and_then(|next| delimiter_row(next))
            && cells(line).len() == alignments.len()
        {
            let header = cells(line);
            let width = header.len();
            index += 2;
            let mut rows = Vec::new();
            while let Some(line) = lines.get(index).filter(|line| !is_blank(line) && !interrupts(line)) {
                let mut row = cells(line);
                row.resize(width, String::new());
                rows.push(row);
                index += 1;
            }
            blocks.push((first, Block::Table(Table { alignments, header, rows })));
        } else {
            paragraph.push(line);
            index += 1;
        }
    }
    flush(&mut paragraph, &mut blocks, index);
    blocks
}

/// Splits a leading `[ ]` or `[x]` off an item's first paragraph.
fn task(mut blocks: Vec<Block>) -> (Option<bool>, Vec<Block>) {
    if let Some(Block::Paragraph(text)) = blocks.first_mut() {
        for (prefix, checked) in [("[ ] ", false), ("[x] ", true), ("[X] ", true)] {
            if let Some(rest) = text.strip_prefix(prefix) {
                *text = rest.to_owned();
                return (Some(checked), blocks);
            }
        }
    }
    (None, blocks)
}

/// Colors for rendered Markdown.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MarkdownColors {
    pub text: Color,
    pub heading: Color,
    pub emphasis: Color,
    pub code: Color,
    pub code_bg: Color,
    pub link: Color,
    pub quote: Color,
    pub marker: Color,
    pub rule: Color,
}

impl MarkdownColors {
    pub fn from_theme(theme: &Theme) -> Self {
        Self {
            text: theme.foreground,
            heading: theme.accent,
            emphasis: theme.foreground,
            code: Color::hex(0xf0c674),
            code_bg: theme.surface,
            link: theme.focus,
            quote: theme.muted,
            marker: theme.accent,
            rule: theme.border,
        }
    }
}

/// The styles of the parts of Markdown, each a patch over the style of the text around it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct MarkdownStyles {
    /// Text outside any other part.
    pub(crate) text: Style,
    pub(crate) headings: [Style; 6],
    pub(crate) table_header: Style,
    pub(crate) strong: Style,
    pub(crate) italic: Style,
    pub(crate) strikethrough: Style,
    pub(crate) code: Style,
    /// A backslash escape.
    pub(crate) escape: Style,
    pub(crate) link_label: Style,
    /// A link's brackets and parentheses.
    pub(crate) link: Style,
    pub(crate) link_url: Style,
    /// A link's `]`, the space before a concealed link's URL, and an autolink's angle brackets.
    pub(crate) link_gap: Style,
    pub(crate) bare_url: Style,
    pub(crate) list: Style,
    pub(crate) quote: Style,
    pub(crate) quote_border: Color,
    pub(crate) rule: Color,
}

impl MarkdownStyles {
    /// The styles from `colors`, or with `syntax`, from its scopes as Core's `MarkdownRenderable` names them, where
    /// a scope the theme does not style takes its style from `colors`.
    pub(crate) fn new(colors: &MarkdownColors, syntax: Option<&SyntaxTheme>) -> Self {
        let link = Style::new().fg(colors.link).underline();
        let heading = Style::new().fg(colors.heading).bold();
        let fallback = Self {
            text: Style::new().fg(colors.text),
            headings: [
                heading.underline(),
                heading,
                Style::new().bold(),
                Style::new().bold(),
                Style::new().bold(),
                Style::new().bold(),
            ],
            table_header: heading,
            strong: Style::new().bold().fg(colors.emphasis),
            italic: Style::new().italic(),
            strikethrough: Style::new().strikethrough(),
            code: Style::new().fg(colors.code).bg(colors.code_bg),
            escape: Style::new(),
            link_label: link,
            link,
            link_url: link,
            link_gap: link,
            bare_url: link,
            list: Style::new().fg(colors.marker),
            quote: Style::new().fg(colors.quote),
            quote_border: colors.quote,
            rule: colors.rule,
        };
        let Some(syntax) = syntax else { return fallback };
        let scope = |name: &str, fallback: Style| syntax.get(name).unwrap_or(fallback);
        let fg = |name: &str| syntax.get(name).and_then(|style| style.fg);
        let level = |level: usize| scope(&format!("markup.heading.{}", level + 1), fallback.headings[level]);
        Self {
            text: fallback.text.patch(scope("default", Style::new())),
            headings: std::array::from_fn(level),
            table_header: scope("markup.heading", fallback.table_header),
            strong: scope("markup.strong", fallback.strong),
            italic: scope("markup.italic", fallback.italic),
            strikethrough: scope("markup.strikethrough", fallback.strikethrough),
            code: scope("markup.raw", fallback.code),
            escape: scope("string.escape", fallback.escape),
            link_label: scope("markup.link.label", fallback.link_label),
            link: scope("markup.link", fallback.link),
            link_url: scope("markup.link.url", fallback.link_url),
            // Core's query puts `]` in `markup.link.bracket.close`, which its lookup does not style through
            // `markup.link`, and conceals it to the space before the URL.
            link_gap: Style::new(),
            // Core styles bare URLs as link labels.
            bare_url: scope("markup.link.label", fallback.bare_url),
            list: scope("markup.list", fallback.list),
            quote: scope("markup.quote", fallback.quote),
            quote_border: fg("conceal").or_else(|| fg("default")).unwrap_or(fallback.quote_border),
            rule: fg("conceal").unwrap_or(fallback.rule),
        }
    }
}

/// The length of a URL starting at the beginning of `text`, without trailing punctuation, for bare links.
fn bare_url(text: &str) -> Option<usize> {
    if !["https://", "http://", "www."].iter().any(|scheme| text.starts_with(scheme)) {
        return None;
    }
    let end = text.find(|c: char| c.is_whitespace() || c == '<').unwrap_or(text.len());
    let url = text[..end].trim_end_matches(['.', ',', ':', ';', '!', '?', '"', '\'', '*', '_', '~']);
    // A closing parenthesis belongs to the URL only when it has an opening one.
    let mut url = url;
    while url.ends_with(')') && url.matches(')').count() > url.matches('(').count() {
        url = &url[..url.len() - 1];
    }
    (url.len() > "www.".len()).then_some(url.len())
}

/// How inline Markdown shows besides its text.
#[derive(Clone, Copy)]
pub(crate) struct Inline {
    pub(crate) styles: MarkdownStyles,
    /// Hides the Markdown markers, as rendered text does.
    pub(crate) conceal: bool,
    /// Shows a link's URL after a label that differs from it, for terminals that do not show hyperlinks.
    pub(crate) urls: bool,
}

/// Parses inline Markdown: `**strong**`, `*emphasis*`, `` `code` ``, `~~strike~~`, `[links](url)`, `<autolinks>`,
/// bare URLs, images (as their alt text), escapes, and hard breaks. Without conceal, the markers stay, styled as
/// what they mark.
pub(crate) fn inline(text: &str, base: Style, options: &Inline) -> Vec<Span<'static>> {
    let styles = &options.styles;
    let mut spans = Vec::new();
    let mut plain = String::new();
    let mut rest = text;
    let flush = |plain: &mut String, spans: &mut Vec<Span<'static>>, style: Style| {
        if !plain.is_empty() {
            spans.push(Span::styled(std::mem::take(plain), style));
        }
    };
    let marker = |spans: &mut Vec<Span<'static>>, marker: &'static str, style: Style| {
        if !options.conceal {
            spans.push(Span::styled(marker, style));
        }
    };
    let (link, link_url, link_gap) =
        (base.patch(styles.link), base.patch(styles.link_url), base.patch(styles.link_gap));
    let mut previous: Option<char> = None;
    while let Some(character) = rest.chars().next() {
        let delimited = |open: &str, close: &str| -> Option<(&str, &str)> {
            let inner = rest.strip_prefix(open)?;
            if let [delimiter @ (b'*' | b'_')] = close.as_bytes() {
                // A single delimiter skips even runs such as the `**` of nested strong text: `*a **b** c*`.
                let runs = inner
                    .match_indices(close)
                    .map(|(start, _)| start)
                    .filter(|&start| start == 0 || inner.as_bytes()[start - 1] != *delimiter);
                let length = |start: usize| inner[start..].bytes().take_while(|byte| byte == delimiter).count();
                let start = runs
                    .clone()
                    .find(|&start| start > 0 && length(start) % 2 == 1)
                    .or_else(|| runs.clone().find(|&start| start > 0))?;
                // A longer run also closes strong text opened inside: `*a **b***`.
                let nested = length(start) >= 3 && inner[..start].contains(&close.repeat(2));
                let end = if nested { start + length(start) - 1 } else { start };
                return Some((&inner[..end], &inner[end + 1..]));
            }
            let mut end = inner.find(close).filter(|&end| end > 0)?;
            // In a run such as `***`, the outer delimiter closes last: `**b *c***` is bold around `b *c*`.
            let last = close.as_bytes()[close.len() - 1];
            while close.len() > 1 && inner.as_bytes().get(end + close.len()) == Some(&last) {
                end += 1;
            }
            Some((&inner[..end], &inner[end + close.len()..]))
        };
        // Intraword underscores stay literal, as in snake_case names.
        let word_before = previous.is_some_and(char::is_alphanumeric);
        let ticks = rest.bytes().take_while(|byte| *byte == b'`').count();
        if character == '\\' && options.conceal && rest[1..].starts_with('\n') {
            // A backslash before a line break marks a hard break, which the line break already shows.
            rest = &rest[1..];
            continue;
        } else if character == '\\' && rest.len() > 1 && rest[1..].starts_with(|c: char| c.is_ascii_punctuation()) {
            let next = rest[1..].chars().next().expect("checked above");
            flush(&mut plain, &mut spans, base);
            let escape = if options.conceal { next.to_string() } else { format!("\\{next}") };
            spans.push(Span::styled(escape, base.patch(styles.escape)));
            rest = &rest[1 + next.len_utf8()..];
            previous = Some(next);
            continue;
        } else if ticks > 0
            && let Some(end) = rest[ticks..].find(&"`".repeat(ticks))
        {
            flush(&mut plain, &mut spans, base);
            let code = &rest[ticks..ticks + end];
            let code = match code {
                _ if !options.conceal => &rest[..2 * ticks + end],
                _ if code.len() > 2 && code.starts_with(' ') && code.ends_with(' ') => &code[1..code.len() - 1],
                _ => code,
            };
            spans.push(Span::styled(code.replace('\n', " "), base.patch(styles.code)));
            rest = &rest[2 * ticks + end..];
        } else if let Some((open, (inner, after))) = delimited("**", "**")
            .map(|found| ("**", found))
            .or_else(|| delimited("__", "__").filter(|_| !word_before).map(|found| ("__", found)))
        {
            flush(&mut plain, &mut spans, base);
            let style = base.patch(styles.strong);
            marker(&mut spans, open, style);
            spans.extend(inline(inner, style, options));
            marker(&mut spans, open, style);
            rest = after;
        } else if let Some((inner, after)) = delimited("~~", "~~") {
            flush(&mut plain, &mut spans, base);
            let style = base.patch(styles.strikethrough);
            marker(&mut spans, "~~", style);
            spans.extend(inline(inner, style, options));
            marker(&mut spans, "~~", style);
            rest = after;
        } else if let Some((open, (inner, after))) = delimited("*", "*")
            .map(|found| ("*", found))
            .or_else(|| delimited("_", "_").filter(|_| !word_before).map(|found| ("_", found)))
            .filter(|(_, (inner, _))| !inner.starts_with(' ') && !inner.ends_with(' '))
        {
            flush(&mut plain, &mut spans, base);
            let style = base.patch(styles.italic);
            marker(&mut spans, open, style);
            spans.extend(inline(inner, style, options));
            marker(&mut spans, open, style);
            rest = after;
        } else if let Some((label, destination, after)) = delimited("![", "](")
            .or_else(|| delimited("[", "]("))
            .and_then(|(label, after)| Some((label, after, after.find(')')?)))
            .map(|(label, after, end)| (label, &after[..end], &after[end + 1..]))
        {
            flush(&mut plain, &mut spans, base);
            let image = rest.starts_with('!');
            let url = destination.split_whitespace().next().unwrap_or_default().to_owned();
            let label_style = base.patch(styles.link_label);
            let parts = |parts: [(&str, Style); 4]| {
                parts.map(|(text, style)| Span::styled(text.to_owned(), style).link(url.clone()))
            };
            if options.conceal {
                let label = inline(if image && label.is_empty() { "image" } else { label }, label_style, options);
                let text: String = label.iter().map(|span| span.content.as_ref()).collect();
                spans.extend(label.into_iter().map(|span| span.link(url.clone())));
                // As in Core, a terminal without hyperlinks shows where the link goes.
                if options.urls && !image && text != url {
                    spans.extend(parts([(" ", link_gap), ("(", link), (&url, link_url), (")", link)]));
                }
            } else {
                spans.push(Span::styled(if image { "![" } else { "[" }, link).link(url.clone()));
                spans.extend(inline(label, label_style, options).into_iter().map(|span| span.link(url.clone())));
                // An image's `]` is part of the link in Core's query; a link's is not.
                spans.extend(parts([
                    ("]", if image { link } else { link_gap }),
                    ("(", link),
                    (destination, link_url),
                    (")", link),
                ]));
            }
            rest = after;
        } else if let Some((url, after)) = delimited("<", ">").filter(|(url, _)| {
            (url.contains("://") || url.starts_with("mailto:")) && !url.contains(char::is_whitespace)
        }) {
            flush(&mut plain, &mut spans, base);
            let link = |text: &str, style: Style| Span::styled(text.to_owned(), style).link(url.to_owned());
            if options.conceal {
                spans.push(link(url, link_url));
            } else {
                spans.extend([link("<", link_gap), link(url, link_url), link(">", link_gap)]);
            }
            rest = after;
        } else if !word_before && let Some(length) = bare_url(rest) {
            flush(&mut plain, &mut spans, base);
            let url = &rest[..length];
            let target = if url.starts_with("www.") { format!("http://{url}") } else { url.to_owned() };
            spans.push(Span::styled(url.to_owned(), base.patch(styles.bare_url)).link(target));
            rest = &rest[length..];
        } else {
            plain.push(character);
            rest = &rest[character.len_utf8()..];
            previous = Some(character);
            continue;
        }
        previous = None;
    }
    flush(&mut plain, &mut spans, base);
    spans
}

/// A fenced code block for a renderer registered with [`Markdown::code_block_renderer`].
pub struct CodeBlock<'a> {
    pub app: &'a App,
    /// The filetype the fence's info string resolves to: the language the renderer was registered for.
    pub language: &'a str,
    /// The fence's info string, such as `mermaid` or `rust,no_run`.
    pub info: &'a str,
    pub code: &'a str,
    /// Whether the closing fence has arrived. While a document streams, an open fence may still grow.
    pub closed: bool,
    /// Whether the document conceals Markdown markers. See [`Markdown::conceal`].
    pub conceal: bool,
    /// Whether the document is still streaming, so the block may be incomplete. See [`Markdown::streaming`].
    pub streaming: bool,
    /// The widget the renderer returned for this block before the block changed. Returning it again keeps it in
    /// place, for example to keep showing the last block that rendered while the rest streams in.
    pub previous: Option<&'a AnyWidget>,
}

type CodeBlockRenderer = Rc<dyn Fn(&CodeBlock<'_>) -> Option<AnyWidget>>;

/// The look of Markdown tables. See [`MarkdownTableOptions`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum MarkdownTableStyle {
    /// Lines around and between the cells, with columns that fill the width.
    #[default]
    Grid,
    /// No lines, columns as wide as their content, and two cells between columns.
    Columns,
}

/// How a [`Markdown`] document draws tables, as Core's `MarkdownTableOptions`. Each `None` takes the style's
/// default.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MarkdownTableOptions {
    pub style: MarkdownTableStyle,
    /// [`ColumnWidthMode::Full`] for [`MarkdownTableStyle::Grid`], [`ColumnWidthMode::Content`] for
    /// [`MarkdownTableStyle::Columns`].
    pub width_mode: Option<ColumnWidthMode>,
    pub column_fitter: Option<ColumnFitter>,
    /// [`WrapMode::Word`] by default.
    pub wrap: Option<WrapMode>,
    /// No padding by default.
    pub cell_padding_x: Option<u32>,
    pub cell_padding_y: Option<u32>,
    /// Lines between the cells: on for [`MarkdownTableStyle::Grid`], off for [`MarkdownTableStyle::Columns`].
    pub borders: Option<bool>,
    /// The line around the table; it follows `borders` by default.
    pub outer_border: Option<bool>,
    pub border_style: Option<BorderStyle>,
    /// The rule color of [`MarkdownColors`] by default.
    pub border_color: Option<Color>,
    /// Whether the mouse selects cell text. On by default.
    pub selectable: Option<bool>,
}

/// The settings blocks render with.
#[derive(Clone, Default)]
struct Options {
    conceal: bool,
    streaming: bool,
    /// Styles text through the syntax theme's scopes.
    scopes: bool,
    table: MarkdownTableOptions,
    /// Renderers by the filetype they render.
    code_blocks: Vec<(String, CodeBlockRenderer)>,
}

pub(crate) struct MarkdownInner {
    element: Element,
    source: RefCell<String>,
    colors: RefCell<MarkdownColors>,
    syntax: RefCell<Arc<SyntaxTheme>>,
    options: RefCell<Rc<Options>>,
    /// The styles from `colors`, `syntax` and `scopes`, built on the first refresh after one of them changes.
    styles: Cell<Option<MarkdownStyles>>,
    /// The top-level blocks shown: where each starts in the source, and its widget.
    shown: RefCell<Vec<Shown>>,
    /// Whether the terminal showed hyperlinks when the blocks were built.
    hyperlinks: Cell<bool>,
}

impl Behavior for MarkdownInner {
    fn element(&self) -> &Element {
        &self.element
    }
}

struct Shown {
    start: usize,
    block: Block,
    rendered: Rendered,
}

/// A block's widget, typed where it can change in place.
#[derive(Clone)]
enum Rendered {
    Text(Text),
    Code(View, Code),
    Table(TextTable),
    /// A code block from a registered renderer.
    Custom(AnyWidget),
    Other(AnyWidget),
}

impl Rendered {
    fn widget(&self) -> AnyWidget {
        match self {
            Self::Text(text) => text.as_any(),
            Self::Code(container, _) => container.as_any(),
            Self::Table(table) => table.as_any(),
            Self::Custom(widget) | Self::Other(widget) => widget.clone(),
        }
    }
}

/// Which blocks an update builds again even when their source is unchanged.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Rebuild {
    None,
    All,
    Code,
    Tables,
    /// Runs the code-block renderers again with the widgets they returned, for a change they read, such as the end
    /// of streaming.
    Renderers,
}

impl Rebuild {
    fn matches(self, block: &Block) -> bool {
        match self {
            Self::None | Self::Renderers => false,
            Self::All => true,
            Self::Code => block.any(&|block| matches!(block, Block::Code(..))),
            Self::Tables => block.any(&|block| matches!(block, Block::Table(_))),
        }
    }
}

/// Builds widgets for Markdown blocks.
#[derive(Clone, Copy)]
struct Renderer<'a> {
    app: &'a App,
    colors: MarkdownColors,
    styles: MarkdownStyles,
    syntax: &'a Arc<SyntaxTheme>,
    options: &'a Options,
    /// Whether link text shows URLs: the terminal does not show hyperlinks.
    urls: bool,
}

impl Renderer<'_> {
    fn base(&self) -> Style {
        self.styles.text
    }

    fn inline(&self, text: &str, style: Style) -> Vec<Span<'static>> {
        inline(text, style, &Inline { styles: self.styles, conceal: self.options.conceal, urls: self.urls })
    }

    fn heading(&self, level: u8, text: &str) -> Vec<Span<'static>> {
        let style = self.base().patch(self.styles.headings[usize::from(level.clamp(1, 6)) - 1]);
        let marker = (!self.options.conceal).then(|| Span::styled(format!("{} ", "#".repeat(level.into())), style));
        marker.into_iter().chain(self.inline(text, style)).collect()
    }

    /// A code block: from a registered renderer, or highlighted as the filetype its fence names.
    fn code_block(&self, info: Option<&str>, code: &str, closed: bool, previous: Option<&AnyWidget>) -> Rendered {
        match self.custom_code(info, code, closed, previous) {
            Some(widget) => Rendered::Custom(widget),
            None => self.default_code(info, code),
        }
    }

    fn default_code(&self, info: Option<&str>, code: &str) -> Rendered {
        let language = info.and_then(|info| info.split_whitespace().next());
        // It shows all its lines, so it has nothing to scroll and takes no focus: Tab passes over it.
        let view = Code::themed(self.app, Arc::clone(self.syntax))
            .fg(self.colors.text)
            .filetype(language)
            .set_code(code)
            .focusable(false);
        Rendered::Code(View::new(self.app).bg(self.colors.code_bg).child(&view), view)
    }

    /// Whether `block` is a code block a registered renderer may take.
    fn claims(&self, block: &Block) -> bool {
        let Block::Code(Some(info), ..) = block else { return false };
        filetype_for_info_string(info)
            .is_some_and(|language| self.options.code_blocks.iter().any(|(key, _)| *key == language))
    }

    fn custom_code(
        &self,
        info: Option<&str>,
        code: &str,
        closed: bool,
        previous: Option<&AnyWidget>,
    ) -> Option<AnyWidget> {
        let info = info?;
        let language = filetype_for_info_string(info)?;
        let (_, render) = self.options.code_blocks.iter().find(|(key, _)| *key == language)?;
        let (conceal, streaming) = (self.options.conceal, self.options.streaming);
        render(&CodeBlock { app: self.app, language: &language, info, code, closed, conceal, streaming, previous })
    }

    /// The widget for a top-level block, updating `previous`, the block shown before and its widget, in place when
    /// it can. Blocks never shrink: a document taller than its parent overflows it, as text should, instead of
    /// squeezing rows into each other.
    fn render(&self, block: &Block, previous: Option<(&Block, &Rendered)>) -> Rendered {
        let rendered = previous
            .and_then(|(old, rendered)| self.update(rendered, old, block))
            .unwrap_or_else(|| self.unsized_block(block));
        if previous.is_none_or(|(_, old)| old.widget() != rendered.widget()) {
            rendered.widget().shrink(0.0);
        }
        rendered
    }

    fn block(&self, block: &Block) -> AnyWidget {
        let widget = self.unsized_block(block).widget();
        widget.shrink(0.0);
        widget
    }

    fn unsized_block(&self, block: &Block) -> Rendered {
        let (app, colors, base) = (self.app, &self.colors, self.base());
        Rendered::Other(match block {
            Block::Heading(level, text) => return Rendered::Text(Text::new(app, self.heading(*level, text))),
            Block::Paragraph(text) => return Rendered::Text(Text::new(app, self.inline(text, base))),
            Block::List(list) => {
                let container = View::new(app).gap(if list.tight { 0 } else { 1 });
                // As in Core, bullets are dashes at every depth, and numbers align on their right.
                let numbers: Vec<String> = (0..list.items.len() as u64)
                    .map(|index| list.start.map_or_else(|| "-".to_owned(), |start| format!("{}.", start + index)))
                    .collect();
                let width = numbers.iter().map(String::len).max().unwrap_or(1);
                let marker = base.patch(self.styles.list);
                for (item, number) in list.items.iter().zip(&numbers) {
                    let task = match (item.task, self.options.conceal) {
                        (None, _) => "",
                        (Some(true), true) => " ☑",
                        (Some(false), true) => " ☐",
                        (Some(true), false) => " [x]",
                        (Some(false), false) => " [ ]",
                    };
                    let body = View::new(app).grow(1.0).gap(if list.tight { 0 } else { 1 });
                    for block in &item.blocks {
                        body.add(&self.block(block));
                    }
                    container.add(
                        &View::new(app)
                            .row()
                            .child(
                                &Text::new(app, vec![Span::styled(format!("{number:>width$}{task} "), marker)])
                                    .shrink(0.0),
                            )
                            .child(&body),
                    );
                }
                container.as_any()
            }
            Block::Quote(blocks) => {
                let quote = View::new(app)
                    .border_sides(Sides::LEFT)
                    .border_color(self.styles.quote_border)
                    .padding_edge(Edge::Left, 1)
                    .gap(1);
                let renderer = Renderer {
                    colors: MarkdownColors { text: colors.quote, ..*colors },
                    styles: MarkdownStyles { text: base.patch(self.styles.quote), ..self.styles },
                    ..*self
                };
                for block in blocks {
                    quote.add(&renderer.block(block));
                }
                quote.as_any()
            }
            Block::Code(info, code, closed) => return self.code_block(info.as_deref(), code, *closed, None),
            Block::Table(table) => return Rendered::Table(self.table(table)),
            Block::Rule => View::new(app).border_sides(Sides::TOP).border_color(self.styles.rule).height(1).as_any(),
        })
    }

    fn table(&self, table: &Table) -> TextTable {
        let options = &self.options.table;
        let columns = options.style == MarkdownTableStyle::Columns;
        let borders = options.borders.unwrap_or(!columns);
        let widget = TextTable::new(self.app).fg(self.base().fg.unwrap_or(self.colors.text));
        if let Some(style) = options.border_style {
            widget.border(style);
        }
        let width_mode = if columns { ColumnWidthMode::Content } else { ColumnWidthMode::Full };
        widget
            .grid_lines(borders)
            .outer_border(options.outer_border.unwrap_or(borders))
            .show_borders(borders)
            .border_color(options.border_color.unwrap_or(self.styles.rule))
            .column_width_mode(options.width_mode.unwrap_or(width_mode))
            .column_fitter(options.column_fitter.unwrap_or_default())
            .wrap(options.wrap.unwrap_or(WrapMode::Word))
            .cell_padding_x(options.cell_padding_x.unwrap_or(0))
            .cell_padding_y(options.cell_padding_y.unwrap_or(0))
            .column_gap(if columns && !borders { 2 } else { 0 })
            .selectable(options.selectable.unwrap_or(true));
        self.fill_table(&widget, table);
        widget
    }

    /// Fills a table: a header row in the heading color, then the body. Like Core's, cells do not follow column
    /// alignment.
    fn fill_table(&self, widget: &TextTable, table: &Table) {
        let row = |cells: &[String], style: Style| -> Vec<Content> {
            cells.iter().map(|cell| Content(self.inline(cell, style))).collect()
        };
        let header = self.base().patch(self.styles.table_header);
        let rows =
            std::iter::once(row(&table.header, header)).chain(table.rows.iter().map(|cells| row(cells, self.base())));
        widget.set_content(rows);
    }

    /// The widget for `new` made from the one built for `old` when both are blocks of one kind, or `None` to build
    /// another.
    fn update(&self, rendered: &Rendered, old: &Block, new: &Block) -> Option<Rendered> {
        match (rendered, old, new) {
            (Rendered::Text(widget), Block::Paragraph(_), Block::Paragraph(text)) => {
                widget.set_text(self.inline(text, self.base()));
            }
            (Rendered::Text(widget), Block::Heading(old_level, _), Block::Heading(level, text))
                if old_level == level =>
            {
                widget.set_text(self.heading(*level, text));
            }
            (_, Block::Code(old_info, ..), Block::Code(info, code, closed)) => {
                let previous = match rendered {
                    Rendered::Custom(widget) => Some(widget),
                    _ => None,
                };
                if let Some(widget) = self.custom_code(info.as_deref(), code, *closed, previous) {
                    return Some(Rendered::Custom(widget));
                }
                match rendered {
                    Rendered::Code(_, view) if old_info == info => view.set_code(code.as_str()),
                    _ => return Some(self.default_code(info.as_deref(), code)),
                };
            }
            (Rendered::Table(widget), Block::Table(_), Block::Table(table)) => self.fill_table(widget, table),
            _ => return None,
        }
        Some(rendered.clone())
    }
}

/// Rendered Markdown: headings, paragraphs with inline styles and links, nested lists with tasks, quotes, tables,
/// rules, and fenced code with highlighting, laid out as OpenTUI Core lays out a top-level Markdown document.
///
/// It builds native widgets, so text wraps and selects like any [`Text`]. Updates rebuild only the blocks that
/// changed, and the last paragraph or code block changes in place, so streaming text with [`Self::append`] stays
/// cheap; with [`Self::streaming`] on, an update parses only the end of the document. It covers the CommonMark and
/// GitHub subset that documents and chat messages use, but not HTML or reference links.
///
/// ```no_run
/// # use opentui::prelude::*;
/// # use opentui::widget::Markdown;
/// # let app = App::new(AppOptions::default())?;
/// let doc = Markdown::new(&app).streaming(true);
/// doc.set_markdown("# Hello\n\nSome **bold** text and a [link](https://opentui.com).");
/// doc.append("\n\n- streamed\n- items");
/// doc.streaming(false);
/// app.root().add(&doc);
/// # Ok::<(), opentui::Error>(())
/// ```
#[derive(Clone)]
pub struct Markdown(Rc<MarkdownInner>);

handle!(Markdown, MarkdownInner);

impl Markdown {
    pub fn new(app: &App) -> Self {
        let colors = MarkdownColors::from_theme(&app.theme());
        let markdown = Self(build(app, NodeKind::Box, |element| MarkdownInner {
            element,
            source: RefCell::new(String::new()),
            colors: RefCell::new(colors),
            syntax: RefCell::new(Arc::new(SyntaxTheme::from_theme(&app.theme()))),
            options: RefCell::new(Rc::new(Options { conceal: true, ..Options::default() })),
            styles: Cell::new(None),
            shown: RefCell::new(Vec::new()),
            hyperlinks: Cell::new(false),
        }));
        markdown.0.element.set_layout(LayoutProperty::Gap(Gutter::Row, 1.into()));
        markdown
    }

    /// Replaces the content, rebuilding only the blocks that changed.
    pub fn set_markdown(&self, markdown: impl Into<String>) -> Self {
        let markdown = markdown.into();
        let old = self.0.source.borrow();
        let unchanged = old.bytes().zip(markdown.bytes()).take_while(|(old, new)| old == new).count();
        drop(old);
        *self.0.source.borrow_mut() = markdown;
        self.refresh(unchanged, Rebuild::None);
        self.clone()
    }

    /// Appends to the content, as for text streamed in chunks.
    pub fn append(&self, markdown: &str) -> Self {
        let unchanged = self.0.source.borrow().len();
        self.0.source.borrow_mut().push_str(markdown);
        self.refresh(unchanged, Rebuild::None);
        self.clone()
    }

    pub fn markdown(&self) -> String {
        self.0.source.borrow().clone()
    }

    pub fn colors(&self, colors: MarkdownColors) -> Self {
        *self.0.colors.borrow_mut() = colors;
        self.0.styles.set(None);
        self.refresh(0, Rebuild::All);
        self.clone()
    }

    /// The styles for code blocks, which the `tree-sitter` feature highlights as the filetype their fence names:
    /// `rust` in ` ```rust `. It starts as [`SyntaxTheme::from_theme`] for the app's theme.
    pub fn syntax_theme(&self, theme: SyntaxTheme) -> Self {
        *self.0.syntax.borrow_mut() = Arc::new(theme);
        self.0.styles.set(None);
        self.refresh(0, Rebuild::All);
        self.clone()
    }

    /// Whether to style text through the [`Self::syntax_theme`] scopes Core's Markdown uses, so one theme styles
    /// both prose and code: `markup.heading.1` to `markup.heading.6`, `markup.strong`, `markup.italic`,
    /// `markup.strikethrough`, `markup.raw`, `markup.link`, `markup.link.label`, `markup.link.url`, `markup.list`,
    /// `markup.quote`, `string.escape`, `default` for plain text, and the `conceal` color for rules and quote bars.
    /// A scope the theme does not style takes its color from [`Self::colors`]. Off by default: text takes the
    /// colors alone.
    pub fn scope_styles(&self, on: bool) -> Self {
        if self.0.options.borrow().scopes != on {
            Rc::make_mut(&mut self.0.options.borrow_mut()).scopes = on;
            self.0.styles.set(None);
            self.refresh(0, Rebuild::All);
        }
        self.clone()
    }

    /// Whether to hide the Markdown markers and show rendered text, as by default. Off, each block shows its source,
    /// styled: `**bold**`, `` `code` ``, `[label](url)`, and `# ` before headings. List markers, quote bars, rules,
    /// code blocks, and table lines look the same either way, as in Core.
    pub fn conceal(&self, conceal: bool) -> Self {
        if self.0.options.borrow().conceal != conceal {
            Rc::make_mut(&mut self.0.options.borrow_mut()).conceal = conceal;
            self.refresh(0, Rebuild::All);
        }
        self.clone()
    }

    /// Whether the content is still streaming in. While it is, an update parses only the source from the end of
    /// the blocks that later text cannot change, and leaves the widgets before it alone. Turning it off parses the
    /// whole document once, so it ends as it would from one [`Self::set_markdown`], and runs the code-block renderers
    /// again with their widgets, because [`CodeBlock::streaming`] changed. Off by default.
    pub fn streaming(&self, streaming: bool) -> Self {
        if self.0.options.borrow().streaming != streaming {
            Rc::make_mut(&mut self.0.options.borrow_mut()).streaming = streaming;
            self.refresh(0, Rebuild::Renderers);
        }
        self.clone()
    }

    /// How tables look. [`MarkdownTableStyle::Grid`] by default.
    pub fn table_options(&self, options: MarkdownTableOptions) -> Self {
        if self.0.options.borrow().table != options {
            Rc::make_mut(&mut self.0.options.borrow_mut()).table = options;
            self.refresh(0, Rebuild::Tables);
        }
        self.clone()
    }

    /// Renders fenced code blocks of a language with `render` instead of a [`Code`] widget, as Core's
    /// `createMarkdownCodeBlockRenderer` does: diagrams for `mermaid`, math for `latex`. A fence matches when its
    /// info string resolves to the same filetype through [`filetype_for_info_string`], so `ts` and `typescript`
    /// match each other. `render` returns `None` to keep the default widget. It runs again when the block changes,
    /// with the widget it returned last in [`CodeBlock::previous`].
    pub fn code_block_renderer(
        &self,
        language: &str,
        render: impl Fn(&CodeBlock<'_>) -> Option<AnyWidget> + 'static,
    ) -> Self {
        let language = filetype_for_info_string(language).unwrap_or_else(|| language.to_owned());
        let mut options = self.0.options.borrow_mut();
        let code_blocks = &mut Rc::make_mut(&mut options).code_blocks;
        code_blocks.retain(|(key, _)| *key != language);
        code_blocks.push((language, Rc::new(render)));
        drop(options);
        self.refresh(0, Rebuild::Code);
        self.clone()
    }

    /// Removes the renderer for a language that [`Self::code_block_renderer`] registered.
    pub fn remove_code_block_renderer(&self, language: &str) -> Self {
        let language = filetype_for_info_string(language).unwrap_or_else(|| language.to_owned());
        Rc::make_mut(&mut self.0.options.borrow_mut()).code_blocks.retain(|(key, _)| *key != language);
        self.refresh(0, Rebuild::Code);
        self.clone()
    }

    /// Shows the source, of which the first `unchanged` bytes are as last shown: keeps the widgets of unchanged
    /// blocks, updates changed ones in place when it can, and builds the rest, along with the blocks `rebuild`
    /// names.
    fn refresh(&self, unchanged: usize, rebuild: Rebuild) {
        let Some(app) = self.0.element.app() else { return };
        let hyperlinks = app.hyperlinks();
        // Link text depends on hyperlink support, which the terminal reports after startup.
        let rebuild = if hyperlinks != self.0.hyperlinks.replace(hyperlinks) { Rebuild::All } else { rebuild };
        let options = Rc::clone(&self.0.options.borrow());
        let syntax = self.0.syntax.borrow();
        let colors = *self.0.colors.borrow();
        let styles =
            self.0.styles.get().unwrap_or_else(|| MarkdownStyles::new(&colors, options.scopes.then_some(&**syntax)));
        self.0.styles.set(Some(styles));
        let renderer = Renderer { app: &app, colors, styles, syntax: &syntax, options: &options, urls: !hyperlinks };
        let source = self.0.source.borrow();
        let mut shown = self.0.shown.borrow_mut();
        // While streaming, a block is complete once the next one starts in unchanged source. As Core does, the
        // last complete block is parsed again too, in case the end of the source changes how it reads.
        let stable = match rebuild {
            Rebuild::None if options.streaming => {
                shown.iter().skip(1).take_while(|next| next.start <= unchanged).count().saturating_sub(1)
            }
            _ => 0,
        };
        let from = if stable == 0 { 0 } else { shown[stable].start };
        let blocks = document(&source, from);
        let end = stable + blocks.len();
        for (index, (start, block)) in (stable..).zip(blocks) {
            let Some(old) = shown.get_mut(index) else {
                let rendered = renderer.render(&block, None);
                self.0.element.insert(rendered.widget().element(), None);
                shown.push(Shown { start, block, rendered });
                continue;
            };
            let rebuilt = rebuild.matches(&old.block) || rebuild.matches(&block);
            // Also the code blocks in a list or quote, which are built again with their block.
            let rerun = rebuild == Rebuild::Renderers && old.block.any(&|block| renderer.claims(block));
            if old.block == block && !rebuilt && !rerun {
                old.start = start;
                continue;
            }
            let rendered = renderer.render(&block, (!rebuilt).then_some((&old.block, &old.rendered)));
            if rendered.widget() != old.rendered.widget() {
                old.rendered.widget().detach();
                self.0.element.insert(rendered.widget().element(), Some(index));
            }
            *old = Shown { start, block, rendered };
        }
        let end = end.min(shown.len());
        for removed in shown.drain(end..) {
            removed.rendered.widget().detach();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paragraph(text: &str) -> Block {
        Block::Paragraph(text.into())
    }

    fn item(blocks: Vec<Block>) -> Item {
        Item { task: None, blocks }
    }

    #[test]
    fn blocks_cover_headings_paragraphs_quotes_code_and_rules() {
        let markdown = "# Title #\n\nOne\nparagraph.  \nBroken.\n\nSetext\n===\n\n> quoted\nlazy\n> > nested\n\n---\n\n```rs\nfn x() {}\n```\n\n    indented\n    code\nafter";
        assert_eq!(
            blocks(markdown),
            [
                Block::Heading(1, "Title".into()),
                paragraph("One\nparagraph.\nBroken."),
                Block::Heading(1, "Setext".into()),
                Block::Quote(vec![paragraph("quoted\nlazy"), Block::Quote(vec![paragraph("nested")])]),
                Block::Rule,
                Block::Code(Some("rs".into()), "fn x() {}".into(), true),
                Block::Code(None, "indented\ncode".into(), true),
                paragraph("after"),
            ]
        );
        // A thematic break is three or more of one mark, with spaces or tabs between, indented at most three columns.
        let rules = ["---", "***", "___", "- - -", " ** * **", "_ _ _ _", "---   ", "---\t", "   ---", "-\t-\t-"];
        let not_rules =
            ["--", "**", "*-*-", "_-_", "\t---", "    ---", "---a", "- - - x", "-é", "", "–––", "+++", "==="];
        for (line, rule) in rules.map(|line| (line, true)).into_iter().chain(not_rules.map(|line| (line, false))) {
            assert_eq!(is_rule(line), rule, "{line:?}");
        }
        // Dashes alone under a paragraph underline a heading; spaced dashes or other marks break after it.
        assert_eq!(blocks("a\n---"), [Block::Heading(2, "a".into())]);
        assert_eq!(blocks("a\n--"), [Block::Heading(2, "a".into())]);
        assert_eq!(blocks("a\n- - -"), [paragraph("a"), Block::Rule]);
        assert_eq!(blocks("a\n***"), [paragraph("a"), Block::Rule]);
        assert_eq!(blocks("---\n* * *"), [Block::Rule, Block::Rule]);
    }

    #[test]
    fn lists_nest_hold_blocks_and_track_tightness() {
        let markdown =
            "- a\n  continued\n  - nested\n    1. deep\n- [x] done\n\n3. three\n4. four\n\n   ```\n   code\n   ```\n";
        assert_eq!(
            blocks(markdown),
            [
                Block::List(List {
                    start: None,
                    tight: true,
                    items: vec![
                        item(vec![
                            paragraph("a\ncontinued"),
                            Block::List(List {
                                start: None,
                                tight: true,
                                items: vec![item(vec![
                                    paragraph("nested"),
                                    Block::List(List {
                                        start: Some(1),
                                        tight: true,
                                        items: vec![item(vec![paragraph("deep")])]
                                    }),
                                ])],
                            }),
                        ]),
                        Item { task: Some(true), blocks: vec![paragraph("done")] },
                    ],
                }),
                Block::List(List {
                    start: Some(3),
                    tight: false,
                    items: vec![
                        item(vec![paragraph("three")]),
                        item(vec![paragraph("four"), Block::Code(None, "code".into(), true)]),
                    ],
                }),
            ]
        );
    }

    #[test]
    fn tables_parse_alignment_and_ragged_rows() {
        // As in GitHub's spec, a table runs until a blank line or another block.
        let markdown = "| Name | Size |\n| :--- | ---: |\n| a \\| b | 1 |\n| c |\n\nafter";
        assert_eq!(
            blocks(markdown),
            [
                Block::Table(Table {
                    alignments: vec![Alignment::Left, Alignment::Right],
                    header: vec!["Name".into(), "Size".into()],
                    rows: vec![vec!["a | b".into(), "1".into()], vec!["c".into(), String::new()]],
                }),
                paragraph("after"),
            ]
        );
        // Without a delimiter row, pipes are text.
        assert_eq!(blocks("a | b\nc | d"), [paragraph("a | b\nc | d")]);
    }

    #[test]
    fn documents_record_where_blocks_start() {
        let markdown = "# A\r\n\r\npara\ngraph\n\n- x\n- y\n\n```\ncode";
        let starts: Vec<usize> = document(markdown, 0).iter().map(|(start, _)| *start).collect();
        assert_eq!(starts, [0, 7, 19, 28]);
        // Parsing from a block's start finds the same blocks from there.
        assert_eq!(document(markdown, 19), document(markdown, 0)[2..]);
    }

    #[test]
    fn inline_styles_nest_and_links_keep_urls() {
        let colors = MarkdownColors::from_theme(&Theme::default());
        let concealed = Inline { styles: MarkdownStyles::new(&colors, None), conceal: true, urls: false };
        let spans = inline(
            "a **b *c*** `d` [e](https://x.test) \\*f\\* snake_case_name <https://auto.test> see https://bare.test/x). ![pic](p.png)",
            Style::new(),
            &concealed,
        );
        let text: String = spans.iter().map(|span| span.content.as_ref()).collect();
        assert_eq!(text, "a b c d e *f* snake_case_name https://auto.test see https://bare.test/x). pic");
        let find = |content: &str| spans.iter().find(|span| span.content == content).unwrap();
        assert!(find("b ").style.attributes.contains(Attributes::BOLD));
        let c = find("c").style.attributes;
        assert!(c.contains(Attributes::BOLD) && c.contains(Attributes::ITALIC));
        assert_eq!(find("d").style.bg, Some(colors.code_bg));
        assert_eq!(find("e").link.as_deref(), Some("https://x.test"));
        assert_eq!(find("https://auto.test").link.as_deref(), Some("https://auto.test"));
        assert_eq!(find("https://bare.test/x").link.as_deref(), Some("https://bare.test/x"));
        assert_eq!(find("pic").link.as_deref(), Some("p.png"));
        // Double backticks hold single ones.
        let spans = inline("``a ` b``", Style::new(), &concealed);
        assert_eq!(spans[0].content, "a ` b");
        // Emphasis closes past strong text inside it, including a run that closes both.
        let styled = |text: &str| {
            let spans = inline(text, Style::new(), &concealed);
            spans.iter().map(|span| (span.content.to_string(), span.style.attributes)).collect::<Vec<_>>()
        };
        let (bold, italic) = (Attributes::BOLD, Attributes::ITALIC);
        assert_eq!(styled("*a **b***"), [("a ".into(), italic), ("b".into(), bold | italic)]);
        assert_eq!(styled("*c***"), [("c".into(), italic), ("**".into(), Attributes::default())]);
        assert_eq!(styled("*a**"), [("a".into(), italic), ("*".into(), Attributes::default())]);
    }

    #[test]
    fn inline_source_keeps_markers_and_concealed_links_show_urls() {
        let colors = MarkdownColors::from_theme(&Theme::default());
        let text = |markdown: &str, conceal: bool, urls: bool| {
            let spans =
                inline(markdown, Style::new(), &Inline { styles: MarkdownStyles::new(&colors, None), conceal, urls });
            spans.iter().map(|span| span.content.as_ref()).collect::<String>()
        };
        let markdown =
            "**a** __b__ *c* _d_ ~~e~~ ``f`` [g](https://g.test \"t\") ![h](h.png) <https://i.test> \\* j\\\nk";
        assert_eq!(text(markdown, false, true), markdown);
        assert_eq!(text(markdown, true, false), "a b c d e f g h https://i.test * j\nk");
        // Without hyperlinks, a link shows its URL unless the label already does.
        assert_eq!(text(markdown, true, true), "a b c d e f g (https://g.test) h https://i.test * j\nk");
        assert_eq!(text("[https://x.test](https://x.test)", true, true), "https://x.test");
        // Markers take the style of what they mark.
        let spans = inline(
            "**a**",
            Style::new(),
            &Inline { styles: MarkdownStyles::new(&colors, None), conceal: false, urls: false },
        );
        assert!(spans.iter().all(|span| span.style.attributes.contains(Attributes::BOLD)));
    }
}
