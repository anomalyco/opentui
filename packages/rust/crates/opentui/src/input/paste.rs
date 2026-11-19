//! Pasted text, as Core's `decodePasteBytes` and `stripAnsiSequences` read it.

use std::iter::Peekable;
use std::ops::RangeInclusive;
use std::str::Chars;

/// Decodes pasted bytes as UTF-8, with U+FFFD for each invalid sequence and a leading byte order mark dropped, as
/// Core's `decodePasteBytes` does. [`Event::Paste`](super::Event::Paste) text is decoded this way.
pub fn decode_paste_bytes(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix("\u{feff}".as_bytes()).unwrap_or(bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

/// Removes terminal escape sequences in ESC and C1 form, as Core's `stripAnsiSequences` does: a control sequence
/// through its final byte, a control string (OSC, DCS, SOS, PM, APC) through BEL or ST, and any other escape through
/// its final byte. A sequence also ends at the first character that cannot continue it, so a lone ESC and a cut-off
/// sequence go too. Other control characters stay.
pub fn strip_ansi_sequences(text: &str) -> String {
    enum Kind {
        Control,
        String,
        Escape,
    }
    fn skip(chars: &mut Peekable<Chars<'_>>, range: RangeInclusive<char>) {
        while chars.next_if(|next| range.contains(next)).is_some() {}
    }
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(character) = chars.next() {
        let kind = match character {
            '\x1b' => match chars.next_if(|next| matches!(next, '[' | 'P' | ']' | 'X' | '^' | '_')) {
                Some('[') => Kind::Control,
                Some(_) => Kind::String,
                None => Kind::Escape,
            },
            '\u{9b}' => Kind::Control,
            '\u{90}' | '\u{98}' | '\u{9d}'..='\u{9f}' => Kind::String,
            _ => {
                out.push(character);
                continue;
            }
        };
        match kind {
            Kind::Control => {
                skip(&mut chars, '\x30'..='\x3f');
                skip(&mut chars, '\x20'..='\x2f');
                chars.next_if(|next| ('\x40'..='\x7e').contains(next));
            }
            Kind::String => {
                while chars.next_if(|next| !matches!(next, '\x07' | '\x1b' | '\u{9c}')).is_some() {}
                if chars.next_if(|next| matches!(next, '\x07' | '\u{9c}')).is_none() {
                    let mut ahead = chars.clone();
                    if (ahead.next(), ahead.next()) == (Some('\x1b'), Some('\\')) {
                        chars = ahead;
                    }
                }
            }
            Kind::Escape => {
                skip(&mut chars, '\x20'..='\x2f');
                chars.next_if(|next| ('\x30'..='\x7e').contains(next));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_drops_a_leading_bom_and_replaces_invalid_bytes() {
        assert_eq!(decode_paste_bytes(b"\xef\xbb\xbfa\xffb\xe6\x97\xef\xbb\xbf"), "a\u{fffd}b\u{fffd}\u{feff}");
        assert_eq!(decode_paste_bytes(b""), "");
    }

    /// Core's paste rows in `Textarea.paste.test.ts`: escape sequences go, other control characters stay.
    #[test]
    fn strip_matches_cores_paste_rows() {
        for (pasted, kept) in [
            (" 🌟世界👍", " 🌟世界👍"),
            ("a \x1b[31mred\x1b[0m\x1b[2 q\x1b[31", "a red"),
            ("a\x0cb\0c", "a\x0cb\0c"),
            ("\x1b]0;title\x07y\u{9d}0;t\u{9c}z\u{90}q\u{9c}\u{98}s\u{9c}\u{9e}p\u{9c}\u{9f}a\x07w", "yzw"),
            ("\x1b", ""),
            // Escapes whose final byte is a digit or `=`, such as DECSC and DECKPAM.
            ("a\x1b7b\x1b=c", "abc"),
            ("a\x1bP1$r\x1b\\b\x1bXs\x1b\\c\x1b(Bd\u{9b}1me\x1b^p\x1b\\\x1b_a\x1b\\\x1b\x07", "abcde\x07"),
            ("\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\\x1b]0;cut", "link"),
            ("p\u{85}q\x7f", "p\u{85}q\x7f"),
            ("\ty\r\nz", "\ty\r\nz"),
        ] {
            assert_eq!(strip_ansi_sequences(pasted), kept, "{}", pasted.escape_debug());
        }
    }
}
