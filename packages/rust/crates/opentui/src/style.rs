//! Colors, text attributes, and styled text.

use crate::sys;
use std::borrow::Cow;
use std::ops::{BitAnd, BitOr, BitOrAssign, Not};

/// How the terminal should interpret a [`Color`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Intent {
    /// A literal RGB color.
    Rgb,
    /// A palette slot. Terminals with a palette use their own color for the slot.
    Indexed(u8),
    /// The terminal's default foreground or background.
    Default,
}

/// A terminal color: an RGBA snapshot plus the intent native code encodes.
///
/// The snapshot is the color itself for [`Intent::Rgb`]. For indexed and default colors it is the fallback used for
/// blending and for terminals without the matching capability.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[must_use]
pub struct Color {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
    intent: Intent,
}

const ANSI16: [(u8, u8, u8); 16] = [
    (0x00, 0x00, 0x00),
    (0x80, 0x00, 0x00),
    (0x00, 0x80, 0x00),
    (0x80, 0x80, 0x00),
    (0x00, 0x00, 0x80),
    (0x80, 0x00, 0x80),
    (0x00, 0x80, 0x80),
    (0xc0, 0xc0, 0xc0),
    (0x80, 0x80, 0x80),
    (0xff, 0x00, 0x00),
    (0x00, 0xff, 0x00),
    (0xff, 0xff, 0x00),
    (0x00, 0x00, 0xff),
    (0xff, 0x00, 0xff),
    (0x00, 0xff, 0xff),
    (0xff, 0xff, 0xff),
];

const fn ansi256(index: u8) -> (u8, u8, u8) {
    const LEVELS: [u8; 6] = [0, 95, 135, 175, 215, 255];
    match index {
        0..=15 => ANSI16[index as usize],
        16..=231 => {
            let cube = (index - 16) as usize;
            (LEVELS[cube / 36], LEVELS[cube / 6 % 6], LEVELS[cube % 6])
        }
        _ => {
            let value = 8 + (index - 232) * 10;
            (value, value, value)
        }
    }
}

impl Color {
    pub const TRANSPARENT: Self = Self::rgba(0, 0, 0, 0);
    /// The terminal's default foreground, with white as its fallback snapshot.
    pub const DEFAULT_FOREGROUND: Self = Self::default_with(255, 255, 255);
    /// The terminal's default background, with black as its fallback snapshot.
    pub const DEFAULT_BACKGROUND: Self = Self::default_with(0, 0, 0);

    pub const BLACK: Self = Self::indexed(0);
    pub const RED: Self = Self::indexed(1);
    pub const GREEN: Self = Self::indexed(2);
    pub const YELLOW: Self = Self::indexed(3);
    pub const BLUE: Self = Self::indexed(4);
    pub const MAGENTA: Self = Self::indexed(5);
    pub const CYAN: Self = Self::indexed(6);
    pub const WHITE: Self = Self::indexed(7);
    pub const BRIGHT_BLACK: Self = Self::indexed(8);
    pub const BRIGHT_RED: Self = Self::indexed(9);
    pub const BRIGHT_GREEN: Self = Self::indexed(10);
    pub const BRIGHT_YELLOW: Self = Self::indexed(11);
    pub const BRIGHT_BLUE: Self = Self::indexed(12);
    pub const BRIGHT_MAGENTA: Self = Self::indexed(13);
    pub const BRIGHT_CYAN: Self = Self::indexed(14);
    pub const BRIGHT_WHITE: Self = Self::indexed(15);

    pub const fn rgb(r: u8, g: u8, b: u8) -> Self {
        Self::rgba(r, g, b, 255)
    }

    pub const fn rgba(r: u8, g: u8, b: u8, a: u8) -> Self {
        Self { r, g, b, a, intent: Intent::Rgb }
    }

    /// An opaque color from `0xRRGGBB`.
    pub const fn hex(value: u32) -> Self {
        Self::rgb((value >> 16) as u8, (value >> 8) as u8, value as u8)
    }

    /// A palette slot whose fallback snapshot is the standard xterm color for that slot.
    pub const fn indexed(index: u8) -> Self {
        let (r, g, b) = ansi256(index);
        Self { r, g, b, a: 255, intent: Intent::Indexed(index) }
    }

    /// A terminal default color with the given fallback snapshot.
    pub const fn default_with(r: u8, g: u8, b: u8) -> Self {
        Self { r, g, b, a: 255, intent: Intent::Default }
    }

    /// Parses `#rgb`, `#rrggbb`, or `#rrggbbaa`. The `#` is optional. [`str::parse`] does the same with an error.
    pub fn parse(text: &str) -> Option<Self> {
        let digits = text.strip_prefix('#').unwrap_or(text);
        if !digits.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        let value = u32::from_str_radix(digits, 16).ok()?;
        match digits.len() {
            3 => {
                let expand = |shift: u32| ((value >> shift) & 0xf) as u8 * 17;
                Some(Self::rgb(expand(8), expand(4), expand(0)))
            }
            6 => Some(Self::hex(value)),
            8 => Some(Self::rgba((value >> 24) as u8, (value >> 16) as u8, (value >> 8) as u8, value as u8)),
            _ => None,
        }
    }

    /// An RGB color with each channel scaled down by `amount`, from 0 (unchanged) to 1 (black). Alpha stays.
    pub fn darken(self, amount: f32) -> Self {
        let scale = |channel: u8| (f32::from(channel) * (1.0 - amount.clamp(0.0, 1.0))).round() as u8;
        Self::rgba(scale(self.r), scale(self.g), scale(self.b), self.a)
    }

    pub const fn with_alpha(self, a: u8) -> Self {
        Self { a, ..self }
    }

    pub const fn intent(self) -> Intent {
        self.intent
    }

    /// Encodes the native color words: RGBA bytes in the low bytes, palette slot and intent in the high bytes.
    pub const fn to_raw(self) -> [u16; 4] {
        let (slot, intent) = match self.intent {
            Intent::Rgb => (0, sys::OT_COLOR_RGB),
            Intent::Indexed(slot) => (slot as u16, sys::OT_COLOR_INDEXED),
            Intent::Default => (0, sys::OT_COLOR_DEFAULT),
        };
        let shift = sys::OT_COLOR_META_SHIFT;
        [self.r as u16 | (slot << shift), self.g as u16 | ((intent as u16) << shift), self.b as u16, self.a as u16]
    }

    /// Decodes native color words. Unknown intents decode as RGB.
    pub const fn from_raw(raw: [u16; 4]) -> Self {
        let shift = sys::OT_COLOR_META_SHIFT;
        let intent = match (raw[1] >> shift) as u32 {
            sys::OT_COLOR_INDEXED => Intent::Indexed((raw[0] >> shift) as u8),
            sys::OT_COLOR_DEFAULT => Intent::Default,
            _ => Intent::Rgb,
        };
        Self { r: raw[0] as u8, g: raw[1] as u8, b: raw[2] as u8, a: raw[3] as u8, intent }
    }
}

impl std::str::FromStr for Color {
    type Err = ParseColorError;

    /// Parses `#rgb`, `#rrggbb`, or `#rrggbbaa`, as [`Color::parse`] does.
    fn from_str(text: &str) -> Result<Self, ParseColorError> {
        Self::parse(text).ok_or(ParseColorError)
    }
}

/// The error from parsing a [`Color`] that is not `#rgb`, `#rrggbb`, or `#rrggbbaa`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ParseColorError;

impl std::fmt::Display for ParseColorError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("expected a color as #rgb, #rrggbb, or #rrggbbaa")
    }
}

impl std::error::Error for ParseColorError {}

/// Text attributes. Native code accepts the low eight bits.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
#[must_use]
pub struct Attributes(u8);

impl Attributes {
    pub const NONE: Self = Self(0);
    pub const BOLD: Self = Self(1 << 0);
    pub const DIM: Self = Self(1 << 1);
    pub const ITALIC: Self = Self(1 << 2);
    pub const UNDERLINE: Self = Self(1 << 3);
    pub const BLINK: Self = Self(1 << 4);
    pub const INVERSE: Self = Self(1 << 5);
    pub const HIDDEN: Self = Self(1 << 6);
    pub const STRIKETHROUGH: Self = Self(1 << 7);

    pub const fn bits(self) -> u8 {
        self.0
    }

    pub const fn from_bits(bits: u8) -> Self {
        Self(bits)
    }

    pub const fn contains(self, other: Self) -> bool {
        self.0 & other.0 == other.0
    }

    pub const fn union(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }

    pub const fn is_empty(self) -> bool {
        self.0 == 0
    }
}

impl BitOr for Attributes {
    type Output = Self;
    fn bitor(self, other: Self) -> Self {
        self.union(other)
    }
}

impl BitOrAssign for Attributes {
    fn bitor_assign(&mut self, other: Self) {
        *self = self.union(other);
    }
}

impl BitAnd for Attributes {
    type Output = Self;
    fn bitand(self, other: Self) -> Self {
        Self(self.0 & other.0)
    }
}

impl Not for Attributes {
    type Output = Self;
    fn not(self) -> Self {
        Self(!self.0)
    }
}

/// Colors and attributes for a run of text. Absent colors inherit from the node.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
#[must_use]
pub struct Style {
    pub fg: Option<Color>,
    pub bg: Option<Color>,
    pub attributes: Attributes,
}

impl Style {
    pub const fn new() -> Self {
        Self { fg: None, bg: None, attributes: Attributes::NONE }
    }

    pub const fn fg(self, color: Color) -> Self {
        Self { fg: Some(color), ..self }
    }

    pub const fn bg(self, color: Color) -> Self {
        Self { bg: Some(color), ..self }
    }

    pub const fn add(self, attributes: Attributes) -> Self {
        Self { attributes: self.attributes.union(attributes), ..self }
    }

    pub const fn bold(self) -> Self {
        self.add(Attributes::BOLD)
    }

    pub const fn dim(self) -> Self {
        self.add(Attributes::DIM)
    }

    pub const fn italic(self) -> Self {
        self.add(Attributes::ITALIC)
    }

    pub const fn underline(self) -> Self {
        self.add(Attributes::UNDERLINE)
    }

    pub const fn inverse(self) -> Self {
        self.add(Attributes::INVERSE)
    }

    pub const fn strikethrough(self) -> Self {
        self.add(Attributes::STRIKETHROUGH)
    }

    /// Applies `other` on top of `self`: its present colors replace these and its attributes add to these.
    pub const fn patch(self, other: Self) -> Self {
        Self {
            fg: if other.fg.is_some() { other.fg } else { self.fg },
            bg: if other.bg.is_some() { other.bg } else { self.bg },
            attributes: self.attributes.union(other.attributes),
        }
    }
}

/// A run of text with one style and an optional hyperlink.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
#[must_use]
pub struct Span<'a> {
    pub content: Cow<'a, str>,
    pub style: Style,
    pub link: Option<Cow<'a, str>>,
}

impl<'a> Span<'a> {
    pub fn raw(content: impl Into<Cow<'a, str>>) -> Self {
        Self { content: content.into(), style: Style::new(), link: None }
    }

    pub fn styled(content: impl Into<Cow<'a, str>>, style: Style) -> Self {
        Self { content: content.into(), style, link: None }
    }

    /// Makes the span an OSC 8 hyperlink. Native code ignores empty URLs, URLs over 512 bytes, and URLs with control
    /// characters.
    pub fn link(mut self, url: impl Into<Cow<'a, str>>) -> Self {
        self.link = Some(url.into());
        self
    }

    pub fn style(mut self, style: Style) -> Self {
        self.style = self.style.patch(style);
        self
    }

    pub fn into_owned(self) -> Span<'static> {
        Span {
            content: Cow::Owned(self.content.into_owned()),
            style: self.style,
            link: self.link.map(|link| Cow::Owned(link.into_owned())),
        }
    }
}

impl<'a> From<&'a str> for Span<'a> {
    fn from(content: &'a str) -> Self {
        Self::raw(content)
    }
}

impl From<String> for Span<'static> {
    fn from(content: String) -> Self {
        Self::raw(content)
    }
}

/// Builds styled spans from strings: `"done".fg(Color::GREEN).bold()`.
pub trait Stylize<'a>: Sized {
    fn into_span(self) -> Span<'a>;

    fn fg(self, color: Color) -> Span<'a> {
        self.into_span().style(Style::new().fg(color))
    }

    fn bg(self, color: Color) -> Span<'a> {
        self.into_span().style(Style::new().bg(color))
    }

    fn attributes(self, attributes: Attributes) -> Span<'a> {
        self.into_span().style(Style::new().add(attributes))
    }

    fn bold(self) -> Span<'a> {
        self.attributes(Attributes::BOLD)
    }

    fn dim(self) -> Span<'a> {
        self.attributes(Attributes::DIM)
    }

    fn italic(self) -> Span<'a> {
        self.attributes(Attributes::ITALIC)
    }

    fn underline(self) -> Span<'a> {
        self.attributes(Attributes::UNDERLINE)
    }

    fn inverse(self) -> Span<'a> {
        self.attributes(Attributes::INVERSE)
    }

    fn strikethrough(self) -> Span<'a> {
        self.attributes(Attributes::STRIKETHROUGH)
    }
}

impl<'a> Stylize<'a> for &'a str {
    fn into_span(self) -> Span<'a> {
        Span::raw(self)
    }
}

impl Stylize<'static> for String {
    fn into_span(self) -> Span<'static> {
        Span::raw(self)
    }
}

impl<'a> Stylize<'a> for Span<'a> {
    fn into_span(self) -> Span<'a> {
        self
    }
}

/// Built-in border line styles.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum BorderStyle {
    #[default]
    Single,
    Double,
    Rounded,
    Heavy,
}

impl BorderStyle {
    pub(crate) const fn raw(self) -> u32 {
        match self {
            Self::Single => sys::OT_BORDER_SINGLE,
            Self::Double => sys::OT_BORDER_DOUBLE,
            Self::Rounded => sys::OT_BORDER_ROUNDED,
            Self::Heavy => sys::OT_BORDER_HEAVY,
        }
    }

    /// The eleven border scalars in native order: corners (top-left, top-right, bottom-left, bottom-right),
    /// horizontal, vertical, then the top, bottom, left, and right tees and the cross.
    pub const fn chars(self) -> [char; 11] {
        match self {
            Self::Single => ['┌', '┐', '└', '┘', '─', '│', '┬', '┴', '├', '┤', '┼'],
            Self::Double => ['╔', '╗', '╚', '╝', '═', '║', '╦', '╩', '╠', '╣', '╬'],
            Self::Rounded => ['╭', '╮', '╰', '╯', '─', '│', '┬', '┴', '├', '┤', '┼'],
            Self::Heavy => ['┏', '┓', '┗', '┛', '━', '┃', '┳', '┻', '┣', '┫', '╋'],
        }
    }
}

/// Which sides of a box draw a border. The bits match native paint masks.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
#[must_use]
pub struct Sides(u8);

impl Sides {
    pub const NONE: Self = Self(0);
    pub const LEFT: Self = Self(sys::OT_BORDER_LEFT as u8);
    pub const BOTTOM: Self = Self(sys::OT_BORDER_BOTTOM as u8);
    pub const RIGHT: Self = Self(sys::OT_BORDER_RIGHT as u8);
    pub const TOP: Self = Self(sys::OT_BORDER_TOP as u8);
    pub const ALL: Self = Self(sys::OT_BORDER_ALL as u8);

    pub const fn bits(self) -> u8 {
        self.0
    }

    pub const fn contains(self, other: Self) -> bool {
        self.0 & other.0 == other.0
    }

    pub const fn union(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }

    pub const fn is_empty(self) -> bool {
        self.0 == 0
    }
}

impl BitOr for Sides {
    type Output = Self;
    fn bitor(self, other: Self) -> Self {
        self.union(other)
    }
}

impl BitOrAssign for Sides {
    fn bitor_assign(&mut self, other: Self) {
        *self = self.union(other);
    }
}

/// Horizontal alignment for titles and text.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Alignment {
    #[default]
    Left,
    Center,
    Right,
}

impl Alignment {
    pub(crate) const fn raw(self) -> u32 {
        match self {
            Self::Left => sys::OT_SCENE_ALIGN_LEFT,
            Self::Center => sys::OT_SCENE_ALIGN_CENTER,
            Self::Right => sys::OT_SCENE_ALIGN_RIGHT,
        }
    }
}

/// Spans encoded for `ot_scene_set_styled_text`: concatenated UTF-8, one chunk per non-empty span, and URL bytes.
#[derive(Default)]
pub(crate) struct EncodedSpans {
    pub bytes: Vec<u8>,
    pub chunks: Vec<sys::ot_styled_text_chunk>,
    pub urls: Vec<u8>,
}

impl EncodedSpans {
    pub fn new(spans: &[Span<'_>]) -> Self {
        let mut encoded = Self::default();
        for span in spans {
            // Native code requires a positive byte count for every chunk.
            if span.content.is_empty() {
                continue;
            }
            let mut chunk = Self::chunk(span.style, span.content.len());
            if let Some(url) = span.link.as_deref().filter(|url| !url.is_empty()) {
                chunk.flags |= sys::OT_SCENE_TEXT_LINK;
                chunk.link_offset = encoded.urls.len() as u32;
                chunk.link_byte_count = url.len() as u32;
                encoded.urls.extend_from_slice(url.as_bytes());
            }
            encoded.bytes.extend_from_slice(span.content.as_bytes());
            encoded.chunks.push(chunk);
        }
        encoded
    }

    /// The chunk for `byte_count` bytes in `style`, without a link.
    pub fn chunk(style: Style, byte_count: usize) -> sys::ot_styled_text_chunk {
        let mut chunk = sys::ot_styled_text_chunk {
            byte_count: byte_count as u32,
            attributes: u32::from(style.attributes.bits()),
            ..Default::default()
        };
        if let Some(color) = style.fg {
            chunk.flags |= sys::OT_SCENE_TEXT_FOREGROUND;
            chunk.foreground = color.to_raw();
        }
        if let Some(color) = style.bg {
            chunk.flags |= sys::OT_SCENE_TEXT_BACKGROUND;
            chunk.background = color.to_raw();
        }
        chunk
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colors_round_trip_through_native_words() {
        for color in [
            Color::rgb(1, 2, 3),
            Color::rgba(250, 128, 0, 7),
            Color::indexed(200),
            Color::RED,
            Color::DEFAULT_FOREGROUND,
            Color::TRANSPARENT,
        ] {
            assert_eq!(Color::from_raw(color.to_raw()), color);
        }
        // Header example: indexed red at slot 1.
        let shift = sys::OT_COLOR_META_SHIFT;
        assert_eq!(
            Color::indexed(1).with_alpha(255).to_raw(),
            [0x80 | (1 << shift), (sys::OT_COLOR_INDEXED as u16) << shift, 0, 255]
        );
        assert_eq!(Color::DEFAULT_FOREGROUND.to_raw(), [255, 255 | (2 << shift), 255, 255]);
    }

    #[test]
    fn palette_snapshots_follow_xterm() {
        assert_eq!(ansi256(1), (0x80, 0, 0));
        assert_eq!(ansi256(16), (0, 0, 0));
        assert_eq!(ansi256(196), (255, 0, 0));
        assert_eq!(ansi256(231), (255, 255, 255));
        assert_eq!(ansi256(232), (8, 8, 8));
        assert_eq!(ansi256(255), (238, 238, 238));
    }

    #[test]
    fn parse_accepts_short_long_and_alpha_hex() {
        assert_eq!(Color::parse("#fa0"), Some(Color::rgb(0xff, 0xaa, 0x00)));
        assert_eq!(Color::parse("12ab34"), Some(Color::rgb(0x12, 0xab, 0x34)));
        assert_eq!(Color::parse("#12ab3480"), Some(Color::rgba(0x12, 0xab, 0x34, 0x80)));
        for invalid in ["", "#", "#12", "#12345", "#gggggg", "+12345", "#1234567"] {
            assert_eq!(Color::parse(invalid), None, "{invalid}");
            assert_eq!(invalid.parse::<Color>(), Err(ParseColorError), "{invalid}");
        }
        assert_eq!("#fa0".parse::<Color>(), Ok(Color::rgb(0xff, 0xaa, 0x00)));
    }

    #[test]
    fn styles_patch_colors_and_merge_attributes() {
        let base = Style::new().fg(Color::RED).bg(Color::BLUE).bold();
        let patched = base.patch(Style::new().fg(Color::GREEN).underline());
        assert_eq!(patched.fg, Some(Color::GREEN));
        assert_eq!(patched.bg, Some(Color::BLUE));
        assert_eq!(patched.attributes, Attributes::BOLD | Attributes::UNDERLINE);
    }

    #[test]
    fn spans_encode_skip_empty_runs_and_index_links() {
        let spans = ["".into(), "Open".fg(Color::RED).bold(), "TUI".into_span().link("https://opentui.com")];
        let encoded = EncodedSpans::new(&spans);
        assert_eq!(encoded.bytes, b"OpenTUI");
        assert_eq!(encoded.urls, b"https://opentui.com");
        assert_eq!(encoded.chunks.len(), 2);
        assert_eq!(encoded.chunks[0].byte_count, 4);
        assert_eq!(encoded.chunks[0].flags, sys::OT_SCENE_TEXT_FOREGROUND);
        assert_eq!(encoded.chunks[0].attributes, 1);
        assert_eq!(encoded.chunks[1].flags, sys::OT_SCENE_TEXT_LINK);
        assert_eq!((encoded.chunks[1].link_offset, encoded.chunks[1].link_byte_count), (0, 19));
    }
}
