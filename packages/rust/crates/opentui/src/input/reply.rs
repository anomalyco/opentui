//! Classifies terminal replies, following OpenTUI Core's `terminal-capability-detection.ts`.

use crate::style::Color;

const ST: &[u8] = b"\x1b\\";

/// Index after one or more ASCII digits starting at `start`, or `None` if there are none.
fn digits(bytes: &[u8], start: usize) -> Option<usize> {
    let end = start + bytes.get(start..)?.iter().take_while(|byte| byte.is_ascii_digit()).count();
    (end > start).then_some(end)
}

/// Index after `digits (; digits)*`.
fn digit_list(bytes: &[u8], start: usize) -> Option<usize> {
    let mut end = digits(bytes, start)?;
    while bytes.get(end) == Some(&b';') {
        end = digits(bytes, end + 1)?;
    }
    Some(end)
}

/// The body of a string sequence `introducer ... terminator`, accepting BEL when `bel` is set.
fn string_body<'a>(reply: &'a [u8], introducer: &[u8], bel: bool) -> Option<&'a [u8]> {
    let rest = reply.strip_prefix(introducer)?;
    rest.strip_suffix(ST).or_else(|| if bel { rest.strip_suffix(b"\x07") } else { None })
}

fn contains(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| window == needle)
}

/// Whether a complete reply carries terminal capability information that native code should receive through
/// [`Control::CapabilityResponse`](crate::native::Control::CapabilityResponse).
pub fn is_capability_response(reply: &[u8]) -> bool {
    // DECRPM: ESC [ ? digits (; digits)* $ y
    if let Some(rest) = reply.strip_prefix(b"\x1b[?") {
        if digit_list(rest, 0).is_some_and(|end| &rest[end..] == b"$y") {
            return true;
        }
        // Kitty keyboard query: ESC [ ? digits (; digits)? u
        if let Some(end) = digits(rest, 0) {
            let end = if rest.get(end) == Some(&b';') { digits(rest, end + 1).unwrap_or(usize::MAX) } else { end };
            if rest.get(end..) == Some(b"u".as_slice()) {
                return true;
            }
        }
        // DA1: ESC [ ? [0-9;]* c
        if is_device_attributes(reply) {
            return true;
        }
    }
    // Explicit-width probe, which runs on row 2 where no modified F3 key reports: ESC [ 2 ; 2 R or ESC [ 2 ; 3 R.
    if matches!(reply, b"\x1b[2;2R" | b"\x1b[2;3R") {
        return true;
    }
    if let Some(body) = string_body(reply, b"\x1bP", false) {
        // XTVERSION
        if body.starts_with(b">|") {
            return true;
        }
        // XTGETTCAP for Ms (OSC 52 clipboard support), and RGB and Tc (24-bit color).
        let body = body.to_ascii_lowercase();
        if body == b"0+r" {
            return true;
        }
        if let Some((answer, rest)) = body.split_at_checked(3)
            && (answer == b"1+r" || answer == b"0+r")
            && let Some(value) =
                [b"4d73".as_slice(), b"524742", b"5463"].iter().find_map(|name| rest.strip_prefix(*name))
            && (value.is_empty() || (answer == b"1+r" && value[0] == b'='))
        {
            return true;
        }
    }
    // Kitty graphics.
    if string_body(reply, b"\x1b_G", false).is_some() {
        return true;
    }
    // Kitty notification capability reply.
    if let Some(body) = string_body(reply, b"\x1b]99;", true)
        && contains(body, b"i=opentui-notifications").is_some_and(|start| contains(&body[start..], b"p=?").is_some())
    {
        return true;
    }
    // Program status query reply: ESC ] 7501 ; ? [: pairs] ST
    if string_body(reply, b"\x1b]7501;", true)
        .is_some_and(|body| body.iter().find(|&&byte| byte != b' ') == Some(&b'?'))
    {
        return true;
    }
    // iTerm2 feature report.
    string_body(reply, b"\x1b]1337;Capabilities=", true).is_some()
}

/// Whether a reply is a cursor position report, `ESC [ row ; column R`.
pub fn is_cursor_report(reply: &[u8]) -> bool {
    reply
        .strip_prefix(b"\x1b[")
        .and_then(|rest| digits(rest, 0).filter(|&end| rest.get(end) == Some(&b';')).map(|end| (rest, end)))
        .is_some_and(|(rest, end)| digits(rest, end + 1).is_some_and(|end| &rest[end..] == b"R"))
}

/// Whether a reply is a primary device attributes report, `ESC [ ? ... c`. Every terminal answers that query, so it
/// marks the end of the replies to queries sent before it.
pub fn is_device_attributes(reply: &[u8]) -> bool {
    reply
        .strip_prefix(b"\x1b[?")
        .and_then(|rest| rest.split_last())
        .is_some_and(|(&last, body)| last == b'c' && body.iter().all(|byte| byte.is_ascii_digit() || *byte == b';'))
}

/// Parses a reply to the pixel size query `CSI 14 t`, `ESC [ 4 ; height ; width t`, into width and height. A size of
/// zero or above `i32::MAX`, which Core rejects too, gives `(0, 0)`: the terminal answered without a usable size.
pub fn pixel_resolution(reply: &[u8]) -> Option<(u32, u32)> {
    let rest = reply.strip_prefix(b"\x1b[4;")?.strip_suffix(b"t")?;
    let height = digits(rest, 0)?;
    let width = digits(rest, height + 1).filter(|&end| rest[height] == b';' && end == rest.len())?;
    let size =
        |field: &[u8]| std::str::from_utf8(field).ok()?.parse().ok().filter(|size| (1..=0x7fff_ffff).contains(size));
    Some(size(&rest[height + 1..width]).zip(size(&rest[..height])).unwrap_or((0, 0)))
}

/// Whether a reply is the terminal's notice that its color scheme changed, `ESC [ ? 997 ; 1 n` (dark) or `2 n`
/// (light), sent while mode 2031 is on.
pub fn is_color_scheme_notice(reply: &[u8]) -> bool {
    reply == b"\x1b[?997;1n" || reply == b"\x1b[?997;2n"
}

/// A color the terminal reports for an OSC 10 or OSC 11 query.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThemeColor {
    Foreground(Color),
    Background(Color),
}

/// A color the terminal reports for an OSC color query.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OscColor {
    /// A palette entry, from OSC 4.
    Palette(u8, Color),
    /// The default foreground, from OSC 10.
    Foreground(Color),
    /// The default background, from OSC 11.
    Background(Color),
    /// The cursor color, from OSC 12.
    Cursor(Color),
}

/// Parses a reply to an OSC 4, 10, 11, or 12 color query, such as `ESC ] 4 ; 1 ; rgb:cd/00/00 BEL`.
pub fn osc_color(reply: &[u8]) -> Option<OscColor> {
    let body = string_body(reply, b"\x1b]", true)?;
    let (code, rest) = body.split_at(body.iter().position(|&byte| byte == b';')?);
    let rest = &rest[1..];
    match code {
        b"4" => {
            let (index, color) = rest.split_at(rest.iter().position(|&byte| byte == b';')?);
            let index = std::str::from_utf8(index).ok()?.parse().ok()?;
            Some(OscColor::Palette(index, color_spec(&color[1..])?))
        }
        b"10" => Some(OscColor::Foreground(color_spec(rest)?)),
        b"11" => Some(OscColor::Background(color_spec(rest)?)),
        b"12" => Some(OscColor::Cursor(color_spec(rest)?)),
        _ => None,
    }
}

/// Parses a reply to an OSC 10 (foreground) or OSC 11 (background) query: `ESC ] 10 ; rgb:R/G/B` with one to four
/// hex digits per channel, or `#rrggbb`, ended by BEL or ST.
pub fn theme_color(reply: &[u8]) -> Option<ThemeColor> {
    match osc_color(reply)? {
        OscColor::Foreground(color) => Some(ThemeColor::Foreground(color)),
        OscColor::Background(color) => Some(ThemeColor::Background(color)),
        _ => None,
    }
}

/// An X11 color spec as terminals report it: `rgb:R/G/B` with one to four hex digits per channel, or `#rrggbb`.
fn color_spec(body: &[u8]) -> Option<Color> {
    let color = if let Some(channels) = body.strip_prefix(b"rgb:") {
        let mut parts = channels.split(|&byte| byte == b'/');
        let mut channel = || {
            let part = parts.next().filter(|part| (1..=4).contains(&part.len()))?;
            let value = u32::from_str_radix(std::str::from_utf8(part).ok()?, 16).ok()?;
            let max = (1u32 << (4 * part.len() as u32)) - 1;
            Some(((value * 255 + max / 2) / max) as u8)
        };
        let (red, green, blue) = (channel()?, channel()?, channel()?);
        if parts.next().is_some() {
            return None;
        }
        Color::rgb(red, green, blue)
    } else {
        let hex = body.strip_prefix(b"#").filter(|hex| hex.len() == 6)?;
        Color::hex(u32::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?)
    };
    Some(color)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_theme_colors_and_scheme_notices() {
        assert_eq!(
            theme_color(b"\x1b]11;rgb:ffff/8080/0000\x1b\\"),
            Some(ThemeColor::Background(Color::rgb(255, 128, 0)))
        );
        assert_eq!(theme_color(b"\x1b]10;rgb:f/80/000\x07"), Some(ThemeColor::Foreground(Color::rgb(255, 128, 0))));
        assert_eq!(theme_color(b"\x1b]11;#1A2b3c\x07"), Some(ThemeColor::Background(Color::hex(0x1a2b3c))));
        for invalid in [
            b"\x1b]11;rgb:ffff/ffff\x07".as_slice(),
            b"\x1b]11;rgb:fffff/0/0\x07",
            b"\x1b]11;rgb:1/2/3/4\x07",
            b"\x1b]12;rgb:0/0/0\x07",
            b"\x1b]11;#12345\x07",
            b"\x1b]11;rgb:0/0/0",
        ] {
            assert_eq!(theme_color(invalid), None, "{}", String::from_utf8_lossy(invalid).escape_debug());
        }
        assert_eq!(osc_color(b"\x1b]4;12;rgb:00/80/ff\x1b\\"), Some(OscColor::Palette(12, Color::rgb(0, 128, 255))));
        assert_eq!(osc_color(b"\x1b]12;#ff0000\x07"), Some(OscColor::Cursor(Color::rgb(255, 0, 0))));
        assert_eq!(osc_color(b"\x1b]4;300;rgb:0/0/0\x07"), None);
        assert!(is_color_scheme_notice(b"\x1b[?997;2n"));
        assert!(!is_color_scheme_notice(b"\x1b[?997;3n"));
        assert!(is_device_attributes(b"\x1b[?62;22c"));
        assert!(!is_device_attributes(b"\x1b[>1;2c"));
    }

    #[test]
    fn recognizes_core_capability_replies() {
        // Forms that Core's vectors below lack.
        for reply in [
            b"\x1b[?1016;1;2$y".as_slice(),
            b"\x1bP1+r4d73=1b5d35323b\x1b\\",
            b"\x1bP1+R4D73\x1b\\",
            b"\x1b_Gi=31;OK\x1b\\",
            b"\x1b[?31;2u",
            b"\x1b[?c",
            b"\x1b]99;i=opentui-notifications:p=?;a=focus\x07",
            b"\x1b]1337;Capabilities=T3Lr\x1b\\",
        ] {
            assert!(is_capability_response(reply), "{}", String::from_utf8_lossy(reply).escape_debug());
        }
    }

    #[test]
    fn rejects_other_replies_and_partial_forms() {
        for reply in [
            b"\x1b[1;1R".as_slice(),
            b"\x1b[1;2R",
            b"\x1b[2;1R",
            b"\x1b[12;40R",
            b"\x1b[?2026;2$",
            b"\x1b[?u",
            b"\x1b[?1;2;3u",
            b"\x1b[>41;1;0c",
            b"\x1b[?xc",
            b"\x1b]11;rgb:0000/0000/0000\x1b\\",
            b"\x1bP>|unterminated",
            b"\x1bP1+r4d74\x1b\\",
            b"\x1bP1+r52474\x1b\\",
            b"\x1bP0+r546374\x1b\\",
            b"\x1b]99;p=?:i=opentui-notifications\x07",
            b"\x1b[4;600;800t",
        ] {
            assert!(!is_capability_response(reply), "{}", String::from_utf8_lossy(reply).escape_debug());
        }
    }

    /// `terminal-capability-detection.test.ts`, including its real-world kitty, Ghostty, Alacritty, and VS Code replies.
    #[test]
    fn core_capability_detection_vectors() {
        for reply in [
            b"\x1b[?1016;2$y".as_slice(),
            b"\x1b[?2027;0$y",
            b"\x1b[?2031;2$y",
            b"\x1b[?1004;1$y",
            b"\x1b[?2026;2$y",
            b"\x1b[?2004;2$y",
            b"\x1b[?1016;0$y",
            b"\x1b[2;2R",
            b"\x1b[2;3R",
            b"\x1bP>|kitty(0.40.1)\x1b\\",
            b"\x1bP>|ghostty 1.1.3\x1b\\",
            b"\x1bP>|tmux 3.5a\x1b\\",
            b"\x1bP1+r4d73=2570312573\x1b\\",
            b"\x1bP1+r4d73\x1b\\",
            b"\x1bP1+r4d73=\x1b\\",
            b"\x1bP0+r\x1b\\",
            b"\x1bP0+r4D73\x1b\\",
            b"\x1bP1+r4d73=abc\x1b\\",
            b"\x1bP1+r4d73=zz\x1b\\",
            b"\x1bP1+r524742=382F382F38\x1b\\",
            b"\x1bP1+r5463\x1b\\",
            b"\x1bP0+r524742\x1b\\",
            b"\x1bP0+r5463\x1b\\",
            b"\x1b_Gi=1;OK\x1b\\",
            b"\x1b_Gi=1;EINVAL:Zero width/height not allowed\x1b\\",
            b"\x1b[?62;c",
            b"\x1b[?62;22c",
            b"\x1b[?1;2;4c",
            b"\x1b[?6c",
            b"\x1b[?0u",
            b"\x1b[?1u",
            b"\x1b[?31u",
            b"\x1b]99;i=opentui-notifications:p=?;p=title,body\x1b\\",
            b"\x1b]99;i=opentui-notifications:p=?;p=title,body\x07",
            b"\x1b]1337;Capabilities=T2NoH\x1b\\",
            b"\x1b]7501;?\x1b\\",
            b"\x1b]7501;?:states=idle,working:kinds=auth\x07",
            b"\x1b]7501; ? : states=idle\x1b\\",
        ] {
            assert!(is_capability_response(reply), "{}", String::from_utf8_lossy(reply).escape_debug());
        }
        for reply in [
            b"\x1b[10;5R".as_slice(),
            b"\x1b[20;30R",
            b"\x1bP1+r544e=787465726d\x1b\\",
            b"a",
            b"A",
            b"\x1b",
            b"\x1ba",
            b"\x1b[A",
            b"\x1b[B",
            b"\x1b[C",
            b"\x1b[D",
            b"\x1bOP",
            b"\x1b[11~",
            b"\x1b[24~",
            b"\x1b[1;2A",
            b"\x1b[1;5C",
            b"\x1b[<35;20;5m",
            b"\x1b[<0;10;10M",
            b"\x1b]9;hello\x1b\\",
            b"\x1b]777;notify;title;body\x1b\\",
            b"\x1b]99;i=other:p=?;p=title\x1b\\",
            b"\x1b]7501;state=idle\x1b\\",
            b"\x1b]75010;?\x1b\\",
        ] {
            assert!(!is_capability_response(reply), "{}", String::from_utf8_lossy(reply).escape_debug());
        }
    }

    #[test]
    fn pixel_sizes_need_two_positive_numbers_up_to_i32_max() {
        for (reply, size) in [
            (b"\x1b[4;480;800t".as_slice(), Some((800, 480))),
            (b"\x1b[4;2147483647;1t", Some((1, 0x7fff_ffff))),
            (b"\x1b[4;0;0t", Some((0, 0))),
            (b"\x1b[4;0;800t", Some((0, 0))),
            (b"\x1b[4;2240852502;2147483648t", Some((0, 0))),
            (b"\x1b[4;99999999999;800t", Some((0, 0))),
            (b"\x1b[4;+480;+800t", None),
            (b"\x1b[4;480;800", None),
            (b"\x1b[4;480t", None),
            (b"\x1b[4;480;800;1t", None),
            (b"\x1b[4;a;bt", None),
            (b"\x1b[4;;800t", None),
            (b"\x1b[3;480;800t", None),
        ] {
            assert_eq!(pixel_resolution(reply), size, "{}", String::from_utf8_lossy(reply).escape_debug());
        }
    }

    #[test]
    fn cursor_reports_need_two_numbers() {
        assert!(is_cursor_report(b"\x1b[12;40R"));
        assert!(is_cursor_report(b"\x1b[1;1R"));
        for reply in [b"\x1b[12R".as_slice(), b"\x1b[;40R", b"\x1b[12;R", b"\x1b[12;40", b"\x1b[?12;40R"] {
            assert!(!is_cursor_report(reply), "{reply:?}");
        }
    }
}
