//! Default widget colors.

use crate::style::Color;

/// The colors widgets use unless told otherwise. Widgets read the theme when they are created.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Theme {
    /// The app background, behind everything.
    pub background: Color,
    /// Panels and other raised areas.
    pub surface: Color,
    pub foreground: Color,
    /// Secondary text: hints, descriptions, placeholders.
    pub muted: Color,
    pub accent: Color,
    pub border: Color,
    /// Borders and highlights of the focused widget.
    pub focus: Color,
    /// Text selected with the mouse or keyboard.
    pub selection_bg: Color,
    pub selection_fg: Color,
    /// The current item of a list or tab bar.
    pub highlight_bg: Color,
    pub highlight_fg: Color,
    /// Text input fields.
    pub input_bg: Color,
    pub input_focused_bg: Color,
    pub cursor: Color,
    /// Slider and scrollbar tracks.
    pub track: Color,
    /// Slider and scrollbar thumbs.
    pub thumb: Color,
    pub success: Color,
    pub warning: Color,
    pub error: Color,
}

impl Default for Theme {
    fn default() -> Self {
        Self::dark()
    }
}

impl Theme {
    /// A dark palette with explicit colors, so the app looks the same in every terminal.
    pub const fn dark() -> Self {
        Self {
            background: Color::hex(0x12161c),
            surface: Color::hex(0x1a2028),
            foreground: Color::hex(0xdbe2ea),
            muted: Color::hex(0x7d8a99),
            accent: Color::hex(0x68d3a8),
            border: Color::hex(0x435363),
            focus: Color::hex(0x5fb3ff),
            selection_bg: Color::hex(0x2f4a63),
            selection_fg: Color::hex(0xffffff),
            highlight_bg: Color::hex(0x26384a),
            highlight_fg: Color::hex(0xffffff),
            input_bg: Color::hex(0x1e252e),
            input_focused_bg: Color::hex(0x243040),
            cursor: Color::hex(0xdbe2ea),
            track: Color::hex(0x252b33),
            thumb: Color::hex(0x6b7a8c),
            success: Color::hex(0x68d3a8),
            warning: Color::hex(0xf0c674),
            error: Color::hex(0xff6b6b),
        }
    }

    /// A light palette with explicit colors.
    pub const fn light() -> Self {
        Self {
            background: Color::hex(0xf7f8fa),
            surface: Color::hex(0xeceff3),
            foreground: Color::hex(0x1f2933),
            muted: Color::hex(0x6b7785),
            accent: Color::hex(0x0f8a64),
            border: Color::hex(0xb8c2cc),
            focus: Color::hex(0x1f6feb),
            selection_bg: Color::hex(0xc8ddf7),
            selection_fg: Color::hex(0x1f2933),
            highlight_bg: Color::hex(0xdce7f3),
            highlight_fg: Color::hex(0x0b1620),
            input_bg: Color::hex(0xeceff3),
            input_focused_bg: Color::hex(0xe1e8f0),
            cursor: Color::hex(0x1f2933),
            track: Color::hex(0xdde3e9),
            thumb: Color::hex(0x8a97a6),
            success: Color::hex(0x0f8a64),
            warning: Color::hex(0xb7791f),
            error: Color::hex(0xc53030),
        }
    }

    /// The terminal's own colors: its default foreground and background and its 16-color palette.
    pub const fn terminal() -> Self {
        Self {
            background: Color::TRANSPARENT,
            surface: Color::TRANSPARENT,
            foreground: Color::DEFAULT_FOREGROUND,
            muted: Color::BRIGHT_BLACK,
            accent: Color::CYAN,
            border: Color::BRIGHT_BLACK,
            focus: Color::BRIGHT_BLUE,
            selection_bg: Color::BLUE,
            selection_fg: Color::BRIGHT_WHITE,
            highlight_bg: Color::BRIGHT_BLACK,
            highlight_fg: Color::BRIGHT_WHITE,
            input_bg: Color::TRANSPARENT,
            input_focused_bg: Color::TRANSPARENT,
            cursor: Color::DEFAULT_FOREGROUND,
            track: Color::BRIGHT_BLACK,
            thumb: Color::WHITE,
            success: Color::GREEN,
            warning: Color::YELLOW,
            error: Color::RED,
        }
    }
}

/// Whether the terminal has a dark or a light background.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ThemeMode {
    Dark,
    Light,
}

impl ThemeMode {
    /// Classifies a background color by its perceived brightness, as Core does.
    pub fn from_background(color: Color) -> Self {
        let brightness = (u32::from(color.r) * 299 + u32::from(color.g) * 587 + u32::from(color.b) * 114) / 1000;
        if brightness > 128 { Self::Light } else { Self::Dark }
    }
}

impl Theme {
    /// [`Theme::dark`] or [`Theme::light`].
    pub const fn for_mode(mode: ThemeMode) -> Self {
        match mode {
            ThemeMode::Dark => Self::dark(),
            ThemeMode::Light => Self::light(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backgrounds_classify_by_brightness() {
        assert_eq!(ThemeMode::from_background(Color::hex(0x1e1e1e)), ThemeMode::Dark);
        assert_eq!(ThemeMode::from_background(Color::hex(0xfdf6e3)), ThemeMode::Light);
        // Pure blue is dark even at full intensity.
        assert_eq!(ThemeMode::from_background(Color::rgb(0, 0, 255)), ThemeMode::Dark);
        assert_eq!(Theme::for_mode(ThemeMode::Light), Theme::light());
    }
}
