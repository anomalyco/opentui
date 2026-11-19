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
}
