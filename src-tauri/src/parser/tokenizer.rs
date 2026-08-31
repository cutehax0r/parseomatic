//! Byte-level line/field splitting and timestamp parsing. No allocation,
//! no regex -- every function here returns spans (offsets into the caller's
//! byte slice) rather than owned strings, per `docs/planning.md`'s parsing
//! approach.

/// A field's byte span, relative to whatever slice the caller passed in.
/// If the field was double-quoted in the source, `start`/`len` describe the
/// *inner* content (quotes already stripped) -- every consumer wants the
/// unquoted text, so stripping once here beats every call site redoing it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FieldSpan {
    pub start: u32,
    pub len: u32,
}

impl FieldSpan {
    #[inline]
    pub fn resolve<'a>(&self, data: &'a [u8]) -> &'a [u8] {
        &data[self.start as usize..self.start as usize + self.len as usize]
    }

    #[inline]
    pub fn resolve_str<'a>(&self, data: &'a [u8]) -> &'a str {
        // Combat logs are ASCII/UTF-8; a malformed byte here is a corrupt
        // file, not a recoverable state, so falling back to lossy would
        // just hide it -- but panicking on untrusted file input isn't
        // acceptable either, so replace rather than crash.
        std::str::from_utf8(self.resolve(data)).unwrap_or("")
    }
}

/// Iterates newline-terminated lines within `data[start..end]`, yielding
/// `(line_start_offset_in_data, line_bytes)` for each. Trailing `\r` (CRLF
/// logs) is trimmed from each line. Mirrors the byte-scanning style already
/// used by `parser::count_lines`, extended from "count" to "yield."
pub fn iter_lines(data: &[u8], start: usize, end: usize) -> impl Iterator<Item = (usize, &[u8])> {
    let mut pos = start;
    std::iter::from_fn(move || {
        if pos >= end {
            return None;
        }
        let line_start = pos;
        let rel_end = memchr::memchr(b'\n', &data[pos..end]).map(|i| pos + i);
        let (line_end, next_pos) = match rel_end {
            Some(nl) => (nl, nl + 1),
            None => (end, end),
        };
        pos = next_pos;
        let mut line = &data[line_start..line_end];
        if line.last() == Some(&b'\r') {
            line = &line[..line.len() - 1];
        }
        Some((line_start, line))
    })
}

/// Splits a line into its timestamp prefix and the rest of the fields,
/// separated by the two spaces documented in `docs/combat-log-format.md`
/// §1. Returns `None` for a line too short to plausibly contain both.
pub fn split_timestamp(line: &[u8]) -> Option<(&[u8], &[u8])> {
    let sep = line.windows(2).position(|w| w == b"  ")?;
    Some((&line[..sep], &line[sep + 2..]))
}

/// Splits `data[base..base+line.len()]` into top-level comma-separated
/// field spans (absolute offsets into `data`), tracking double-quote state
/// and paren/bracket nesting depth so commas inside a quoted string or
/// inside a `COMBATANT_INFO`-style `(...)`/`[...]` group don't split.
///
/// Quote and depth tracking are gated on each other (parens inside a quoted
/// string don't affect depth; quotes inside a paren'd group still toggle
/// quote state) since the two never legitimately overlap in this format.
///
/// Not used for `EMOTE`'s free-text field -- that's unquoted, unescaped,
/// and may itself contain brackets/commas as UI markup, so it's handled as
/// a fixed-count split by the event parser instead of running through this
/// general splitter.
pub fn split_fields(line: &[u8], base: usize) -> Vec<FieldSpan> {
    let mut fields = Vec::new();
    let mut field_start = 0usize;
    let mut in_quotes = false;
    let mut depth: i32 = 0;

    for (i, &b) in line.iter().enumerate() {
        match b {
            b'"' => in_quotes = !in_quotes,
            b'(' | b'[' if !in_quotes => depth += 1,
            b')' | b']' if !in_quotes => depth -= 1,
            b',' if !in_quotes && depth == 0 => {
                fields.push(make_field(line, base, field_start, i));
                field_start = i + 1;
            }
            _ => {}
        }
    }
    fields.push(make_field(line, base, field_start, line.len()));

    fields
}

/// Splits at most the first `n` top-level (quote-aware, no bracket-nesting
/// tracking) commas, returning the fields found plus the absolute offset
/// where the remainder of the line begins. For `EMOTE`'s free-text field,
/// which may itself contain bracket-shaped UI markup that would desync
/// [`split_fields`]'s nesting depth if run across it -- callers stop using
/// the general splitter after the fixed field count and treat everything
/// from the returned offset onward as one opaque span instead.
pub fn split_first_n_fields(line: &[u8], base: usize, n: usize) -> (Vec<FieldSpan>, usize) {
    let mut fields = Vec::with_capacity(n);
    let mut field_start = 0usize;
    let mut in_quotes = false;
    let mut remainder_start = line.len();

    for (i, &b) in line.iter().enumerate() {
        match b {
            b'"' => in_quotes = !in_quotes,
            b',' if !in_quotes => {
                fields.push(make_field(line, base, field_start, i));
                field_start = i + 1;
                if fields.len() == n {
                    remainder_start = field_start;
                    break;
                }
            }
            _ => {}
        }
    }
    if fields.len() < n {
        fields.push(make_field(line, base, field_start, line.len()));
        remainder_start = line.len();
    }
    (fields, base + remainder_start)
}

/// Builds a `FieldSpan` for `line[start..end]`, stripping a wrapping pair
/// of double quotes if present.
fn make_field(line: &[u8], base: usize, start: usize, end: usize) -> FieldSpan {
    let slice = &line[start..end];
    if slice.len() >= 2 && slice[0] == b'"' && slice[slice.len() - 1] == b'"' {
        FieldSpan {
            start: (base + start + 1) as u32,
            len: (slice.len() - 2) as u32,
        }
    } else {
        FieldSpan {
            start: (base + start) as u32,
            len: slice.len() as u32,
        }
    }
}

/// Parses the confirmed current-retail timestamp format
/// `M/D/YYYY HH:MM:SS.mmm-TZ` (`docs/combat-log-format.md` §1, e.g.
/// `7/25/2026 20:52:35.870-6`) into milliseconds since the Unix epoch
/// (UTC). Only whole-hour timezone offsets have been observed in the wild;
/// this parser assumes that shape and doesn't attempt to support a
/// sub-hour offset.
pub fn parse_timestamp(ts: &[u8]) -> Option<i64> {
    let mut cur = ts;

    let month = take_int(&mut cur, b'/')?;
    let day = take_int(&mut cur, b'/')?;
    let year = take_int(&mut cur, b' ')?;
    let hour = take_int(&mut cur, b':')?;
    let minute = take_int(&mut cur, b':')?;
    let second = take_int(&mut cur, b'.')?;

    // Milliseconds run up to the timezone sign, not a fixed delimiter.
    let sign_pos = cur.iter().position(|&b| b == b'+' || b == b'-')?;
    let millis: i64 = std::str::from_utf8(&cur[..sign_pos]).ok()?.parse().ok()?;
    let sign = cur[sign_pos];
    let tz_hours: i64 = std::str::from_utf8(&cur[sign_pos + 1..]).ok()?.parse().ok()?;
    let offset_hours = if sign == b'-' { -tz_hours } else { tz_hours };

    let days = days_from_civil(year, month as u32, day as u32);
    let local_millis =
        days * 86_400_000 + (hour * 3_600_000 + minute * 60_000 + second * 1_000) + millis;

    Some(local_millis - offset_hours * 3_600_000)
}

/// Reads digits from the front of `cur` up to (and consuming) the next
/// occurrence of `delim`, advancing `cur` past it.
fn take_int(cur: &mut &[u8], delim: u8) -> Option<i64> {
    let pos = cur.iter().position(|&b| b == delim)?;
    let value: i64 = std::str::from_utf8(&cur[..pos]).ok()?.parse().ok()?;
    *cur = &cur[pos + 1..];
    Some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_timestamp_from_rest() {
        let line = b"7/25/2026 20:52:35.870-6  SPELL_DAMAGE,foo";
        let (ts, rest) = split_timestamp(line).unwrap();
        assert_eq!(ts, b"7/25/2026 20:52:35.870-6");
        assert_eq!(rest, b"SPELL_DAMAGE,foo");
    }

    #[test]
    fn iterates_lines_with_absolute_offsets() {
        let data = b"line one\nline two\nline three";
        let lines: Vec<_> = iter_lines(data, 0, data.len()).collect();
        assert_eq!(
            lines,
            vec![
                (0, &b"line one"[..]),
                (9, &b"line two"[..]),
                (18, &b"line three"[..]),
            ]
        );
    }

    #[test]
    fn iter_lines_trims_trailing_cr() {
        let data = b"a\r\nb\r\n";
        let lines: Vec<_> = iter_lines(data, 0, data.len()).collect();
        assert_eq!(lines, vec![(0, &b"a"[..]), (3, &b"b"[..])]);
    }

    #[test]
    fn splits_simple_fields_and_strips_quotes() {
        let line = b"SPELL_DAMAGE,Player-1-2,\"Foo\",0x1";
        let fields = split_fields(line, 0);
        assert_eq!(fields.len(), 4);
        assert_eq!(fields[0].resolve_str(line), "SPELL_DAMAGE");
        assert_eq!(fields[1].resolve_str(line), "Player-1-2");
        assert_eq!(fields[2].resolve_str(line), "Foo");
        assert_eq!(fields[3].resolve_str(line), "0x1");
    }

    #[test]
    fn keeps_commas_inside_quotes() {
        let line = b"A,\"Foo, Bar\",C";
        let fields = split_fields(line, 0);
        assert_eq!(fields.len(), 3);
        assert_eq!(fields[1].resolve_str(line), "Foo, Bar");
    }

    #[test]
    fn keeps_commas_inside_nested_parens_and_brackets() {
        // Shaped like a COMBATANT_INFO equipped-item tuple.
        let line = b"A,(173845,90,(),(1479,4786,6502),()),[1,2],C";
        let fields = split_fields(line, 0);
        assert_eq!(fields.len(), 4);
        assert_eq!(fields[1].resolve_str(line), "(173845,90,(),(1479,4786,6502),())");
        assert_eq!(fields[2].resolve_str(line), "[1,2]");
    }

    #[test]
    fn split_fields_offsets_are_absolute_when_base_nonzero() {
        let data = b"XXXXXA,B,C";
        let fields = split_fields(&data[5..], 5);
        assert_eq!(fields[0].resolve_str(data), "A");
        assert_eq!(fields[1].resolve_str(data), "B");
        assert_eq!(fields[2].resolve_str(data), "C");
    }

    #[test]
    fn splits_first_n_and_leaves_remainder_as_raw_text() {
        let line = b"EMOTE,GUID,\"Name\",0x1,0x0,text with [brackets] and, commas";
        let (fields, offset) = split_first_n_fields(line, 0, 5);
        assert_eq!(fields.len(), 5);
        assert_eq!(fields[0].resolve_str(line), "EMOTE");
        assert_eq!(fields[1].resolve_str(line), "GUID");
        assert_eq!(fields[2].resolve_str(line), "Name");
        assert_eq!(fields[4].resolve_str(line), "0x0");
        assert_eq!(&line[offset..], b"text with [brackets] and, commas");
    }

    #[test]
    fn parses_confirmed_fixture_timestamp() {
        // 2026-07-25 20:52:35.870 local, UTC-6 -- cross-checked by hand
        // against Howard Hinnant's days_from_civil reference values.
        let ms = parse_timestamp(b"7/25/2026 20:52:35.870-6").unwrap();
        assert_eq!(ms, 1_785_034_355_870);
    }

    #[test]
    fn parses_unix_epoch() {
        let ms = parse_timestamp(b"1/1/1970 00:00:00.000+0").unwrap();
        assert_eq!(ms, 0);
    }

    #[test]
    fn positive_offset_shifts_earlier_utc() {
        // UTC+6: local time is ahead of UTC, so UTC must be 6h earlier.
        let ms = parse_timestamp(b"1/1/1970 06:00:00.000+6").unwrap();
        assert_eq!(ms, 0);
    }

    #[test]
    fn days_from_civil_matches_known_epoch_boundary() {
        // 2026-01-01 00:00:00 UTC is a well-known reference point.
        assert_eq!(days_from_civil(2026, 1, 1) * 86_400, 1_767_225_600);
    }
}

/// Days since the Unix epoch (1970-01-01) for a given proleptic Gregorian
/// civil date. Howard Hinnant's `days_from_civil` algorithm --
/// http://howardhinnant.github.io/date_algorithms.html -- chosen over
/// pulling in a date/time crate for a single well-known constant-time
/// integer formula run on every line of a multi-million-line file.
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = (m as i64 + 9) % 12; // [0, 11], Mar=0 .. Feb=11
    let doy = (153 * mp + 2) / 5 + d as i64 - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe - 719_468
}
