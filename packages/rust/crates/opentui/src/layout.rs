//! Typed flexbox layout properties for native Yoga nodes. Lengths count terminal cells.

use crate::sys;

/// A layout length.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Length {
    /// Clears the property.
    Undefined,
    /// Lets layout choose. Supported for width, height, flex basis, margin, and position.
    Auto,
    /// Terminal cells.
    Cells(f32),
    /// Percent of the parent, 0 through 100.
    Percent(f32),
}

impl Length {
    pub const fn percent(value: f32) -> Self {
        Self::Percent(value)
    }

    fn encode(self) -> (u32, f32) {
        match self {
            Self::Undefined => (sys::OT_UNIT_UNDEFINED, f32::NAN),
            Self::Auto => (sys::OT_UNIT_AUTO, f32::NAN),
            Self::Cells(value) => (sys::OT_UNIT_POINT, value),
            Self::Percent(value) => (sys::OT_UNIT_PERCENT, value),
        }
    }

    pub(crate) fn decode(unit: u32, value: f32) -> Self {
        match unit {
            sys::OT_UNIT_POINT => Self::Cells(value),
            sys::OT_UNIT_PERCENT => Self::Percent(value),
            sys::OT_UNIT_AUTO => Self::Auto,
            _ => Self::Undefined,
        }
    }
}

macro_rules! cells_from {
    ($($type:ty),*) => {$(
        impl From<$type> for Length {
            fn from(value: $type) -> Self {
                Self::Cells(value as f32)
            }
        }
    )*};
}
cells_from!(u8, u16, u32, u64, usize, i16, i32, i64, f32, f64);

macro_rules! native_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident = $constant:ident,)* }) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
        pub enum $name {
            #[default]
            $($variant,)*
        }

        impl $name {
            pub(crate) const fn raw(self) -> u32 {
                match self {
                    $(Self::$variant => sys::$constant,)*
                }
            }
        }
    };
}

native_enum!(Direction { Inherit = OT_DIRECTION_INHERIT, Ltr = OT_DIRECTION_LTR, Rtl = OT_DIRECTION_RTL, });
native_enum!(FlexDirection {
    Column = OT_FLEX_DIRECTION_COLUMN,
    ColumnReverse = OT_FLEX_DIRECTION_COLUMN_REVERSE,
    Row = OT_FLEX_DIRECTION_ROW,
    RowReverse = OT_FLEX_DIRECTION_ROW_REVERSE,
});
native_enum!(Justify {
    Start = OT_JUSTIFY_FLEX_START,
    Center = OT_JUSTIFY_CENTER,
    End = OT_JUSTIFY_FLEX_END,
    SpaceBetween = OT_JUSTIFY_SPACE_BETWEEN,
    SpaceAround = OT_JUSTIFY_SPACE_AROUND,
    SpaceEvenly = OT_JUSTIFY_SPACE_EVENLY,
});
native_enum!(Align {
    Auto = OT_ALIGN_AUTO,
    Start = OT_ALIGN_FLEX_START,
    Center = OT_ALIGN_CENTER,
    End = OT_ALIGN_FLEX_END,
    Stretch = OT_ALIGN_STRETCH,
    Baseline = OT_ALIGN_BASELINE,
    SpaceBetween = OT_ALIGN_SPACE_BETWEEN,
    SpaceAround = OT_ALIGN_SPACE_AROUND,
    SpaceEvenly = OT_ALIGN_SPACE_EVENLY,
});
native_enum!(PositionType {
    Relative = OT_POSITION_RELATIVE,
    Static = OT_POSITION_STATIC,
    Absolute = OT_POSITION_ABSOLUTE,
});
native_enum!(Wrap { NoWrap = OT_FLEX_WRAP_NONE, Wrap = OT_FLEX_WRAP_WRAP, WrapReverse = OT_FLEX_WRAP_REVERSE, });
native_enum!(Overflow { Visible = OT_OVERFLOW_VISIBLE, Hidden = OT_OVERFLOW_HIDDEN, Scroll = OT_OVERFLOW_SCROLL, });
native_enum!(Display { Flex = OT_DISPLAY_FLEX, None = OT_DISPLAY_NONE, });
native_enum!(BoxSizing { BorderBox = OT_BOX_SIZING_BORDER_BOX, ContentBox = OT_BOX_SIZING_CONTENT_BOX, });
native_enum!(
    /// How a node lays out its children. `List` stacks them as a column with `overflow: scroll` does, without a flex
    /// pass over them: they never grow or shrink, and the node's direction, wrap, and justification do not move them.
    LayoutMode { Flex = OT_LAYOUT_MODE_FLEX, List = OT_LAYOUT_MODE_LIST, }
);
native_enum!(
    /// A side or group of sides for margin, padding, and position.
    Edge {
        All = OT_EDGE_ALL,
        Left = OT_EDGE_LEFT,
        Top = OT_EDGE_TOP,
        Right = OT_EDGE_RIGHT,
        Bottom = OT_EDGE_BOTTOM,
        Start = OT_EDGE_START,
        End = OT_EDGE_END,
        Horizontal = OT_EDGE_HORIZONTAL,
        Vertical = OT_EDGE_VERTICAL,
    }
);
native_enum!(Gutter { All = OT_GUTTER_ALL, Column = OT_GUTTER_COLUMN, Row = OT_GUTTER_ROW, });

/// One flexbox property for [`Node::set_layout`](crate::native::Node::set_layout).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LayoutProperty {
    Direction(Direction),
    FlexDirection(FlexDirection),
    JustifyContent(Justify),
    AlignContent(Align),
    AlignItems(Align),
    AlignSelf(Align),
    PositionType(PositionType),
    FlexWrap(Wrap),
    Overflow(Overflow),
    Display(Display),
    BoxSizing(BoxSizing),
    LayoutMode(LayoutMode),
    Flex(f32),
    FlexGrow(f32),
    FlexShrink(f32),
    AspectRatio(f32),
    Width(Length),
    Height(Length),
    /// Width that also disables flex shrinking, applied atomically.
    FixedWidth(Length),
    /// Height that also disables flex shrinking, applied atomically.
    FixedHeight(Length),
    MinWidth(Length),
    MinHeight(Length),
    MaxWidth(Length),
    MaxHeight(Length),
    FlexBasis(Length),
    Margin(Edge, Length),
    Padding(Edge, Length),
    Position(Edge, Length),
    Gap(Gutter, Length),
}

/// The arguments of one `ot_scene_set_style` call.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct EncodedProperty {
    pub group: u32,
    pub kind: u32,
    pub edge: u32,
    pub unit: u32,
    pub value: f32,
    pub flags: u32,
}

impl LayoutProperty {
    pub(crate) fn encode(self) -> EncodedProperty {
        use LayoutProperty as P;
        let enumeration = |kind: u32, value: u32| EncodedProperty {
            group: sys::OT_STYLE_ENUM,
            kind,
            edge: sys::OT_EDGE_NONE,
            unit: sys::OT_UNIT_UNDEFINED,
            value: value as f32,
            flags: sys::OT_STYLE_FLAGS_NONE,
        };
        let float = |kind: u32, value: f32| EncodedProperty {
            group: sys::OT_STYLE_FLOAT,
            kind,
            edge: sys::OT_EDGE_NONE,
            unit: sys::OT_UNIT_UNDEFINED,
            value,
            flags: sys::OT_STYLE_FLAGS_NONE,
        };
        let length = |group: u32, kind: u32, edge: u32, length: Length, flags: u32| {
            let (unit, value) = length.encode();
            EncodedProperty { group, kind, edge, unit, value, flags }
        };
        let value = |kind: u32, edge: u32, value: Length| {
            length(sys::OT_STYLE_VALUE, kind, edge, value, sys::OT_STYLE_FLAGS_NONE)
        };
        let dimension = |kind: u32, value: Length| {
            length(sys::OT_STYLE_DIMENSION, kind, sys::OT_EDGE_NONE, value, sys::OT_STYLE_DISABLE_FLEX_SHRINK)
        };
        match self {
            P::Direction(v) => enumeration(sys::OT_STYLE_ENUM_DIRECTION, v.raw()),
            P::FlexDirection(v) => enumeration(sys::OT_STYLE_ENUM_FLEX_DIRECTION, v.raw()),
            P::JustifyContent(v) => enumeration(sys::OT_STYLE_ENUM_JUSTIFY_CONTENT, v.raw()),
            P::AlignContent(v) => enumeration(sys::OT_STYLE_ENUM_ALIGN_CONTENT, v.raw()),
            P::AlignItems(v) => enumeration(sys::OT_STYLE_ENUM_ALIGN_ITEMS, v.raw()),
            P::AlignSelf(v) => enumeration(sys::OT_STYLE_ENUM_ALIGN_SELF, v.raw()),
            P::PositionType(v) => enumeration(sys::OT_STYLE_ENUM_POSITION_TYPE, v.raw()),
            P::FlexWrap(v) => enumeration(sys::OT_STYLE_ENUM_FLEX_WRAP, v.raw()),
            P::Overflow(v) => enumeration(sys::OT_STYLE_ENUM_OVERFLOW, v.raw()),
            P::Display(v) => enumeration(sys::OT_STYLE_ENUM_DISPLAY, v.raw()),
            P::BoxSizing(v) => enumeration(sys::OT_STYLE_ENUM_BOX_SIZING, v.raw()),
            P::LayoutMode(v) => enumeration(sys::OT_STYLE_ENUM_LAYOUT_MODE, v.raw()),
            P::Flex(v) => float(sys::OT_STYLE_FLOAT_FLEX, v),
            P::FlexGrow(v) => float(sys::OT_STYLE_FLOAT_FLEX_GROW, v),
            P::FlexShrink(v) => float(sys::OT_STYLE_FLOAT_FLEX_SHRINK, v),
            P::AspectRatio(v) => float(sys::OT_STYLE_FLOAT_ASPECT_RATIO, v),
            P::Width(v) => value(sys::OT_STYLE_VALUE_WIDTH, sys::OT_EDGE_NONE, v),
            P::Height(v) => value(sys::OT_STYLE_VALUE_HEIGHT, sys::OT_EDGE_NONE, v),
            P::FixedWidth(v) => dimension(sys::OT_DIMENSION_WIDTH, v),
            P::FixedHeight(v) => dimension(sys::OT_DIMENSION_HEIGHT, v),
            P::MinWidth(v) => value(sys::OT_STYLE_VALUE_MIN_WIDTH, sys::OT_EDGE_NONE, v),
            P::MinHeight(v) => value(sys::OT_STYLE_VALUE_MIN_HEIGHT, sys::OT_EDGE_NONE, v),
            P::MaxWidth(v) => value(sys::OT_STYLE_VALUE_MAX_WIDTH, sys::OT_EDGE_NONE, v),
            P::MaxHeight(v) => value(sys::OT_STYLE_VALUE_MAX_HEIGHT, sys::OT_EDGE_NONE, v),
            P::FlexBasis(v) => value(sys::OT_STYLE_VALUE_FLEX_BASIS, sys::OT_EDGE_NONE, v),
            P::Margin(edge, v) => value(sys::OT_STYLE_VALUE_MARGIN, edge.raw(), v),
            P::Padding(edge, v) => value(sys::OT_STYLE_VALUE_PADDING, edge.raw(), v),
            P::Position(edge, v) => value(sys::OT_STYLE_VALUE_POSITION, edge.raw(), v),
            P::Gap(gutter, v) => value(sys::OT_STYLE_VALUE_GAP, gutter.raw(), v),
        }
    }
}

/// A node's computed geometry in terminal cells.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rect {
    /// Offset from the parent's left edge.
    pub left: f32,
    /// Offset from the parent's top edge.
    pub top: f32,
    pub width: f32,
    pub height: f32,
    /// Absolute column, including ancestor positions and translations.
    pub screen_x: f64,
    /// Absolute row, including ancestor positions and translations.
    pub screen_y: f64,
}

impl Rect {
    pub(crate) fn from_raw(layout: &sys::ot_scene_layout) -> Self {
        Self {
            left: layout.left,
            top: layout.top,
            width: layout.width,
            height: layout.height,
            screen_x: layout.screen_x,
            screen_y: layout.screen_y,
        }
    }

    /// Whether the absolute cell `(x, y)` lies inside the rectangle.
    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.screen_x
            && y >= self.screen_y
            && x < self.screen_x + f64::from(self.width)
            && y < self.screen_y + f64::from(self.height)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn properties_encode_their_native_groups() {
        let grow = LayoutProperty::FlexGrow(1.0).encode();
        assert_eq!((grow.group, grow.kind, grow.edge, grow.unit), (sys::OT_STYLE_FLOAT, 1, 0, sys::OT_UNIT_UNDEFINED));
        let padding = LayoutProperty::Padding(Edge::Horizontal, 2.into()).encode();
        assert_eq!(
            (padding.group, padding.kind, padding.edge, padding.unit, padding.value),
            (sys::OT_STYLE_VALUE, sys::OT_STYLE_VALUE_PADDING, sys::OT_EDGE_HORIZONTAL, sys::OT_UNIT_POINT, 2.0)
        );
        let fixed = LayoutProperty::FixedHeight(Length::percent(50.0)).encode();
        assert_eq!((fixed.group, fixed.flags, fixed.unit), (sys::OT_STYLE_DIMENSION, 1, sys::OT_UNIT_PERCENT));
        let display = LayoutProperty::Display(Display::None).encode();
        assert_eq!((display.group, display.value), (sys::OT_STYLE_ENUM, sys::OT_DISPLAY_NONE as f32));
        assert!(LayoutProperty::Width(Length::Auto).encode().value.is_nan());
    }
}
