use super::{Hooks, Session};
use crate::error::{Result, check, cleanup, count};
use crate::layout::{LayoutProperty, Length, Rect};
use crate::style::{Alignment, Attributes, BorderStyle, Color, EncodedSpans, Sides, Span};
use crate::sys;

/// The built-in node kinds of the native scene.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum NodeKind {
    /// The top of a Session's scene. Creating it creates the scene.
    Root,
    /// A flexbox container with optional border, background, and titles.
    Box,
    /// Text with its own private buffer and view.
    Text,
    Slider,
    Arrow,
    /// An editor view bound with `ot_scene_set_editor_view`.
    Editor,
    /// A node the host paints through paint hooks or a bound surface.
    Custom,
    /// A shared text buffer view bound with `ot_scene_set_text_view`.
    TextView,
    Image,
    /// A video player, opened with [`Node::video_open`].
    Video,
}

impl NodeKind {
    const fn raw(self) -> u32 {
        match self {
            Self::Root => sys::OT_SCENE_ROOT,
            Self::Box => sys::OT_SCENE_BOX,
            Self::Text => sys::OT_SCENE_TEXT,
            Self::Slider => sys::OT_SCENE_SLIDER,
            Self::Arrow => sys::OT_SCENE_ARROW,
            Self::Editor => sys::OT_SCENE_EDITOR,
            Self::Custom => sys::OT_SCENE_CUSTOM,
            Self::TextView => sys::OT_SCENE_TEXT_VIEW,
            Self::Image => sys::OT_SCENE_IMAGE,
            Self::Video => sys::OT_SCENE_VIDEO,
        }
    }
}

/// Common paint properties. `set_paint` replaces all of them; the defaults match a new native node.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Paint {
    /// Paint order among siblings.
    pub z_index: i32,
    /// Multiplies with ancestor opacity, 0 through 1.
    pub opacity: f32,
    /// Offset in cells, applied after layout.
    pub translate: (f64, f64),
    pub border: Sides,
    pub border_style: BorderStyle,
    pub border_color: Color,
    /// Fill the node's area with `background`.
    pub fill: bool,
    pub background: Color,
    /// Whether this box uses `focused_border_color` while it or a descendant has scene focus.
    pub focusable: bool,
    pub focused_border_color: Color,
}

impl Default for Paint {
    fn default() -> Self {
        Self {
            z_index: 0,
            opacity: 1.0,
            translate: (0.0, 0.0),
            border: Sides::NONE,
            border_style: BorderStyle::Single,
            border_color: Color::rgb(255, 255, 255),
            fill: true,
            background: Color::TRANSPARENT,
            focusable: false,
            focused_border_color: Color::rgb(0, 170, 255),
        }
    }
}

/// How text wraps at the node's width.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum WrapMode {
    None,
    Char,
    #[default]
    Word,
}

impl WrapMode {
    pub(crate) const fn raw(self) -> u32 {
        match self {
            Self::None => sys::OT_SCENE_WRAP_NONE,
            Self::Char => sys::OT_SCENE_WRAP_CHAR,
            Self::Word => sys::OT_SCENE_WRAP_WORD,
        }
    }
}

/// Text node options. `set_text_options` replaces all of them; the defaults match a new native text node.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TextOptions {
    /// Color for text without a span color.
    pub fg: Color,
    /// Background for text without a span background.
    pub bg: Color,
    pub attributes: Attributes,
    pub wrap: WrapMode,
    /// Truncate lines that do not fit instead of overflowing.
    pub truncate: bool,
    /// Display columns reserved before the first line.
    pub first_line_offset: u32,
    /// Scroll offset in display columns and virtual rows.
    pub scroll: (f64, f64),
    /// Glyph drawn at tab starts, or `None` to hide tab indicators.
    pub tab_indicator: Option<char>,
    pub tab_color: Option<Color>,
    pub align: Alignment,
}

impl Default for TextOptions {
    fn default() -> Self {
        Self {
            fg: Color::rgb(255, 255, 255),
            bg: Color::TRANSPARENT,
            attributes: Attributes::NONE,
            wrap: WrapMode::Word,
            truncate: false,
            first_line_offset: 0,
            scroll: (0.0, 0.0),
            tab_indicator: None,
            tab_color: None,
            align: Alignment::Left,
        }
    }
}

/// Text measurements. Widths count display columns, not bytes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TextInfo {
    pub byte_count: u32,
    /// Sum of unwrapped line widths, excluding line separators.
    pub width_total: u32,
    pub line_count: u32,
    /// Lines after wrapping.
    pub virtual_line_count: u32,
    /// The widest unwrapped line.
    pub width_max: u32,
}

/// Box titles and custom border glyphs. `set_box_details` replaces all of them.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BoxDetails<'a> {
    /// Single-row title drawn on the top border.
    pub title: &'a str,
    pub title_alignment: Alignment,
    /// Single-row title drawn on the bottom border.
    pub bottom_title: &'a str,
    pub bottom_title_alignment: Alignment,
    /// Title color; the border color when `None`.
    pub title_color: Option<Color>,
    /// Single-cell border glyphs in [`BorderStyle::chars`] order, replacing the border style's glyphs.
    pub border_chars: Option<[char; 11]>,
}

/// Which geometry [`Node::layout`] reads.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Observation {
    /// Geometry from the latest frame preparation, with current screen coordinates.
    #[default]
    Public,
    /// Raw Yoga results, with zero screen coordinates.
    Yoga,
    /// Prepared paint geometry.
    Paint,
}

/// One native scene node.
///
/// A `Node` owns its native node: dropping it destroys the node and detaches its surviving children. Tree
/// relationships control layout and painting, not lifetime. Each node keeps its Session alive.
pub struct Node {
    session: Session,
    handle: sys::ot_handle,
    kind: NodeKind,
    num: u32,
}

impl Drop for Node {
    fn drop(&mut self) {
        cleanup("ot_scene_destroy_node", unsafe { sys::ot_scene_destroy_node(self.context(), &self.handle) });
        super::measure::forget(&self.handle);
    }
}

impl std::fmt::Debug for Node {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("Node").field("kind", &self.kind).field("num", &self.num).finish()
    }
}

impl Node {
    /// Creates a detached node. `num` is the node's public number for hit tests, or zero for none. Nonzero numbers
    /// are immutable for the node's lifetime.
    pub fn new(session: &Session, kind: NodeKind, num: u32) -> Result<Self> {
        let mut handle = sys::ot_handle::default();
        let session_handle = session.handle();
        check("ot_scene_create_node", unsafe {
            sys::ot_scene_create_node(session.context().as_raw(), &session_handle, kind.raw(), num, &mut handle)
        })?;
        Ok(Self { session: session.clone(), handle, kind, num })
    }

    fn context(&self) -> *mut sys::ot_context {
        self.session.context().as_raw()
    }

    pub(crate) fn context_raw(&self) -> *mut sys::ot_context {
        self.context()
    }

    pub fn session(&self) -> &Session {
        &self.session
    }

    pub fn handle(&self) -> sys::ot_handle {
        self.handle
    }

    pub fn kind(&self) -> NodeKind {
        self.kind
    }

    pub fn num(&self) -> u32 {
        self.num
    }

    /// Moves this node under `parent` at child position `index`, which may not exceed the parent's child count.
    pub fn insert_into(&self, parent: &Node, index: u32) -> Result<()> {
        check("ot_scene_move_node", unsafe {
            sys::ot_scene_move_node(self.context(), &self.handle, &parent.handle, index)
        })
    }

    pub fn detach(&self) -> Result<()> {
        check("ot_scene_move_node", unsafe {
            sys::ot_scene_move_node(self.context(), &self.handle, std::ptr::null(), 0)
        })
    }

    /// Detaches every child, first to last, in time linear in the child count. On error no child is detached.
    pub fn clear_children(&self) -> Result<()> {
        check("ot_scene_clear_children", unsafe { sys::ot_scene_clear_children(self.context(), &self.handle) })
    }

    pub fn set_layout(&self, property: LayoutProperty) -> Result<()> {
        let p = property.encode();
        check("ot_scene_set_style", unsafe {
            sys::ot_scene_set_style(self.context(), &self.handle, p.group, p.kind, p.edge, p.unit, p.value, p.flags)
        })
    }

    /// Reads a requested length, such as `LayoutProperty::Width(Length::Undefined)` for the width. Native code
    /// stores finite margin, padding, position, and gap values beyond ±1e30 as ±1e30.
    pub fn layout_length(&self, property: LayoutProperty) -> Result<Length> {
        let p = property.encode();
        let mut value = sys::ot_scene_style_value::default();
        check("ot_scene_get_style", unsafe {
            sys::ot_scene_get_style(self.context(), &self.handle, p.group, p.kind, p.edge, &mut value)
        })?;
        Ok(Length::decode(value.unit, value.value))
    }

    pub fn set_paint(&self, paint: &Paint) -> Result<()> {
        let raw = sys::ot_scene_paint_options {
            z_index: paint.z_index,
            opacity: paint.opacity,
            translate_x: paint.translate.0,
            translate_y: paint.translate.1,
            border_sides: u32::from(paint.border.bits()),
            should_fill: u32::from(paint.fill),
            background: paint.background.to_raw(),
            border_color: paint.border_color.to_raw(),
            border_style: paint.border_style.raw(),
            focusable: u32::from(paint.focusable),
            focused_border_color: paint.focused_border_color.to_raw(),
            ..Default::default()
        };
        check("ot_scene_set_paint", unsafe { sys::ot_scene_set_paint(self.context(), &self.handle, &raw) })
    }

    pub fn set_box_details(&self, details: &BoxDetails<'_>) -> Result<()> {
        let mut raw = sys::ot_scene_box_details {
            title_alignment: details.title_alignment.raw(),
            bottom_title_alignment: details.bottom_title_alignment.raw(),
            ..Default::default()
        };
        if let Some(color) = details.title_color {
            raw.flags |= 1;
            raw.title_color = color.to_raw();
        }
        if let Some(chars) = details.border_chars {
            raw.flags |= 2;
            raw.border_characters = chars.map(u32::from);
        }
        let title = count("ot_scene_set_box_details", details.title.len())?;
        let bottom = count("ot_scene_set_box_details", details.bottom_title.len())?;
        check("ot_scene_set_box_details", unsafe {
            sys::ot_scene_set_box_details(
                self.context(),
                &self.handle,
                &raw,
                details.title.as_ptr(),
                title,
                details.bottom_title.as_ptr(),
                bottom,
            )
        })
    }

    /// Replaces the text of a text node. Native code copies the bytes and rejects invalid UTF-8.
    pub fn set_text(&self, text: impl AsRef<[u8]>) -> Result<()> {
        let bytes = text.as_ref();
        let length = count("ot_scene_set_text", bytes.len())?;
        check("ot_scene_set_text", unsafe {
            sys::ot_scene_set_text(self.context(), &self.handle, bytes.as_ptr(), length)
        })
    }

    /// Replaces the text with styled spans. A rejected replacement keeps the accepted content.
    pub fn set_spans(&self, spans: &[Span<'_>]) -> Result<()> {
        let encoded = EncodedSpans::new(spans);
        if encoded.chunks.is_empty() {
            return self.set_text("");
        }
        self.set_styled_raw(&encoded.bytes, &encoded.chunks, &encoded.urls)
    }

    /// The raw form of [`Self::set_spans`].
    pub fn set_styled_raw(&self, bytes: &[u8], chunks: &[sys::ot_styled_text_chunk], urls: &[u8]) -> Result<()> {
        const OPERATION: &str = "ot_scene_set_styled_text";
        let (byte_count, chunk_count, url_count) =
            (count(OPERATION, bytes.len())?, count(OPERATION, chunks.len())?, count(OPERATION, urls.len())?);
        check(OPERATION, unsafe {
            sys::ot_scene_set_styled_text(
                self.context(),
                &self.handle,
                bytes.as_ptr(),
                byte_count,
                chunks.as_ptr(),
                chunk_count,
                urls.as_ptr(),
                url_count,
            )
        })
    }

    /// The text's UTF-8 bytes, with line endings normalized to LF.
    pub fn text_bytes(&self) -> Result<Vec<u8>> {
        let mut length = 0;
        check("ot_scene_get_text", unsafe {
            sys::ot_scene_get_text(self.context(), &self.handle, std::ptr::null_mut(), 0, &mut length)
        })?;
        let mut bytes = vec![0; length as usize];
        check("ot_scene_get_text", unsafe {
            sys::ot_scene_get_text(self.context(), &self.handle, bytes.as_mut_ptr(), length, &mut length)
        })?;
        bytes.truncate(length as usize);
        Ok(bytes)
    }

    pub fn text(&self) -> Result<String> {
        Ok(String::from_utf8_lossy(&self.text_bytes()?).into_owned())
    }

    pub fn set_text_options(&self, options: &TextOptions) -> Result<()> {
        let raw = sys::ot_scene_text_options {
            foreground: options.fg.to_raw(),
            background: options.bg.to_raw(),
            attributes: u32::from(options.attributes.bits()),
            wrap_mode: options.wrap.raw(),
            truncate: u32::from(options.truncate),
            first_line_offset: options.first_line_offset,
            scroll_x: options.scroll.0,
            scroll_y: options.scroll.1,
            tab_indicator: options.tab_indicator.map_or(0, u32::from),
            tab_color_set: u32::from(options.tab_color.is_some()),
            tab_color: options.tab_color.map_or([0; 4], Color::to_raw),
            text_align: options.align.raw(),
            ..Default::default()
        };
        check("ot_scene_set_text_options", unsafe {
            sys::ot_scene_set_text_options(self.context(), &self.handle, &raw)
        })
    }

    pub fn text_info(&self) -> Result<TextInfo> {
        let mut raw = sys::ot_scene_text_info::default();
        check("ot_scene_get_text_info", unsafe {
            sys::ot_scene_get_text_info(self.context(), &self.handle, &mut raw)
        })?;
        Ok(TextInfo {
            byte_count: raw.byte_count,
            width_total: raw.text_length,
            line_count: raw.line_count,
            virtual_line_count: raw.virtual_line_count,
            width_max: raw.width_cols_max,
        })
    }

    /// Stores this node as the scene's focus target, or clears it if it is the target.
    pub fn set_focus(&self, focused: bool) -> Result<()> {
        check("ot_scene_set_focus", unsafe {
            sys::ot_scene_set_focus(self.context(), &self.handle, u32::from(focused))
        })
    }

    /// Reads stored geometry without running layout.
    pub fn layout(&self, observation: Observation) -> Result<Rect> {
        let selector = match observation {
            Observation::Public => sys::OT_LAYOUT_PUBLIC,
            Observation::Yoga => sys::OT_LAYOUT_YOGA,
            Observation::Paint => sys::OT_LAYOUT_PAINT,
        };
        let mut raw = sys::ot_scene_layout::default();
        check("ot_scene_get_layout", unsafe {
            sys::ot_scene_get_layout(self.context(), &self.handle, selector, &mut raw)
        })?;
        Ok(Rect::from_raw(&raw))
    }

    /// Registers frame hooks. `generation` must be nonzero and increase on every change.
    pub fn set_hooks(&self, hooks: Hooks, generation: u64, initial_size: (f64, f64)) -> Result<()> {
        let raw = sys::ot_scene_hooks {
            flags: hooks.bits(),
            generation,
            initial_width: initial_size.0,
            initial_height: initial_size.1,
            ..Default::default()
        };
        check("ot_scene_set_hooks", unsafe { sys::ot_scene_set_hooks(self.context(), &self.handle, &raw) })
    }

    /// Paints only the direct children that overlap `viewport`. `None` disables filtering.
    pub fn set_viewport(&self, viewport: Option<&Node>) -> Result<()> {
        let viewport = viewport.map_or(std::ptr::null(), |node| &node.handle as *const _);
        check("ot_scene_set_viewport", unsafe { sys::ot_scene_set_viewport(self.context(), &self.handle, viewport) })
    }

    pub fn mark_dirty(&self) -> Result<()> {
        check("ot_scene_mark_dirty", unsafe { sys::ot_scene_mark_dirty(self.context(), &self.handle) })
    }

    pub fn set_slider(&self, options: &SliderOptions) -> Result<()> {
        let raw = sys::ot_scene_slider_options {
            orientation: u32::from(options.vertical),
            min: options.min,
            max: options.max,
            value: options.value,
            viewport_size: options.viewport_size,
            foreground: options.fg.to_raw(),
            background: options.bg.to_raw(),
            ..Default::default()
        };
        check("ot_scene_set_slider", unsafe { sys::ot_scene_set_slider(self.context(), &self.handle, &raw) })
    }

    /// The slider thumb's (size, start), in half cells along the slider.
    pub fn slider_thumb(&self) -> Result<(f64, f64)> {
        let mut raw = sys::ot_scene_slider_thumb::default();
        check("ot_scene_get_slider_thumb", unsafe {
            sys::ot_scene_get_slider_thumb(self.context(), &self.handle, &mut raw)
        })?;
        Ok((raw.size, raw.start))
    }

    /// Configures an arrow node. `glyph` replaces the standard triangle for the direction.
    pub fn set_arrow(&self, options: &ArrowOptions, glyph: Option<&str>) -> Result<()> {
        let raw = sys::ot_scene_arrow_options {
            direction: options.direction as u32,
            attributes: u32::from(options.attributes.bits()),
            foreground: options.fg.to_raw(),
            background: options.bg.to_raw(),
            ..Default::default()
        };
        let (pointer, length) = match glyph {
            Some(glyph) => (glyph.as_ptr(), count("ot_scene_set_arrow", glyph.len())?),
            None => (std::ptr::null(), 0),
        };
        check("ot_scene_set_arrow", unsafe {
            sys::ot_scene_set_arrow(self.context(), &self.handle, &raw, pointer, length)
        })
    }

    /// Selects text between two node-local cells, as a mouse drag does. `extend` keeps the existing anchor.
    /// Returns whether the selection changed.
    pub fn select_text(
        &self,
        anchor: (i32, i32),
        focus: (i32, i32),
        extend: bool,
        unit: super::SelectionUnit,
        colors: super::SelectionColors,
    ) -> Result<bool> {
        let mut raw = sys::ot_scene_text_selection_options {
            operation: if extend { sys::OT_SCENE_TEXT_SELECTION_UPDATE } else { sys::OT_SCENE_TEXT_SELECTION_SET },
            behavior: unit.raw(),
            anchor_x: anchor.0,
            anchor_y: anchor.1,
            focus_x: focus.0,
            focus_y: focus.1,
            ..Default::default()
        };
        if let Some(color) = colors.bg {
            raw.flags |= sys::OT_SCENE_TEXT_SELECTION_BACKGROUND;
            raw.background = color.to_raw();
        }
        if let Some(color) = colors.fg {
            raw.flags |= sys::OT_SCENE_TEXT_SELECTION_FOREGROUND;
            raw.foreground = color.to_raw();
        }
        let mut changed = 0;
        check("ot_scene_set_text_selection", unsafe {
            sys::ot_scene_set_text_selection(self.context(), &self.handle, &raw, &mut changed)
        })?;
        Ok(changed != 0)
    }

    pub fn clear_text_selection(&self) -> Result<bool> {
        let raw = sys::ot_scene_text_selection_options {
            operation: sys::OT_SCENE_TEXT_SELECTION_RESET,
            ..Default::default()
        };
        let mut changed = 0;
        check("ot_scene_set_text_selection", unsafe {
            sys::ot_scene_set_text_selection(self.context(), &self.handle, &raw, &mut changed)
        })?;
        Ok(changed != 0)
    }

    /// The selected range in display-column offsets, start inclusive and end exclusive.
    pub fn text_selection(&self) -> Result<Option<(u32, u32)>> {
        let mut packed = 0;
        check("ot_scene_get_text_selection", unsafe {
            sys::ot_scene_get_text_selection(self.context(), &self.handle, &mut packed)
        })?;
        Ok((packed != u64::MAX).then_some(((packed >> 32) as u32, packed as u32)))
    }

    pub fn selected_text(&self) -> Result<String> {
        let context = self.context();
        super::resource::read_string("ot_scene_get_selected_text", |bytes, capacity, length| unsafe {
            sys::ot_scene_get_selected_text(context, &self.handle, bytes, capacity, length)
        })
    }
}

/// Slider options. `set_slider` replaces all of them.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SliderOptions {
    pub vertical: bool,
    pub min: f64,
    pub max: f64,
    pub value: f64,
    /// The thumb's share of the range, as a scrollbar's visible size.
    pub viewport_size: f64,
    /// Thumb color.
    pub fg: Color,
    /// Track color.
    pub bg: Color,
}

impl Default for SliderOptions {
    fn default() -> Self {
        Self {
            vertical: false,
            min: 0.0,
            max: 100.0,
            value: 0.0,
            viewport_size: 10.0,
            fg: Color::hex(0x9a9ea3),
            bg: Color::hex(0x252527),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum ArrowDirection {
    #[default]
    Up = 0,
    Down = 1,
    Left = 2,
    Right = 3,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ArrowOptions {
    pub direction: ArrowDirection,
    pub attributes: Attributes,
    pub fg: Color,
    pub bg: Color,
}

impl Default for ArrowOptions {
    fn default() -> Self {
        Self {
            direction: ArrowDirection::Up,
            attributes: Attributes::NONE,
            fg: Color::rgb(255, 255, 255),
            bg: Color::TRANSPARENT,
        }
    }
}
