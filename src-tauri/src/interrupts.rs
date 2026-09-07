//! Raid-level interrupt list for one UI-picked window -- backs the
//! Interrupts view (`src/views/interrupts.ts`). One live windowed scan:
//!
//! - **interrupts** -- one per `SPELL_INTERRUPT`: who kicked, whose cast,
//!   the interrupt ability, the spell that was being cast, and how long
//!   that cast had been running (`interrupt ts - CAST_START ts`).
//! - **failed casts** -- notable `SPELL_CAST_FAILED` by a player, heavily
//!   noise-filtered (the common "not yet recovered" / "out of range" /
//!   "no target" spam is dropped), adjacent identical ones collapsed.
//!
//! No total cast time -- the combat log doesn't carry it and no spell
//! data is bundled yet -- so rows show elapsed only, no progress bar.

use std::collections::HashMap;

use crate::parser::event::{EventStore, LineKind, Suffix};
use crate::parser::intern::{InternTables, UnitKind, NO_SPELL, NO_UNIT};

/// One `SPELL_INTERRUPT`.
pub struct Interrupt {
    pub t_ms: i64,
    /// The interrupter.
    pub source_unit: u32,
    /// The unit whose cast was interrupted.
    pub target_unit: u32,
    /// The interrupt ability (Kick / Wind Shear / ...); `NO_SPELL` if unresolved.
    pub ability_id: u16,
    /// The spell that was being cast; `NO_SPELL` if the `extraSpellId`
    /// never interned (essentially never happens -- it had a CAST_START).
    pub interrupted_id: u16,
    /// `interrupt ts - CAST_START ts`, when a matching open cast was seen.
    pub elapsed_ms: Option<i64>,
}

/// A notable `SPELL_CAST_FAILED` by a player.
pub struct FailedCast {
    pub t_ms: i64,
    pub source_unit: u32,
    pub ability_id: u16,
    pub reason: String,
    /// Adjacent identical `(unit, spell, reason)` failures within 3 s,
    /// collapsed -- `1` for a lone one.
    pub count: u32,
}

pub struct InterruptReport {
    pub interrupts: Vec<Interrupt>,
    pub failed_casts: Vec<FailedCast>,
}

/// `SPELL_CAST_FAILED` reasons that are pure noise (cooldown / resource /
/// positioning / already-covered-by-SPELL_INTERRUPT). Lowercased
/// `contains` match. Tunable -- start conservative, widen as real logs
/// show what's worth surfacing.
const NOISE_REASONS: &[&str] = &[
    "not yet recovered",
    "not enough",
    "no target",
    "out of range",
    "another action is in progress",
    "you can't do that yet",
    "while moving",
    "while stunned",
    "is not ready yet",
    "interrupted", // SPELL_INTERRUPT already lists these
    "already",
];

const FAIL_COLLAPSE_MS: i64 = 3000;

pub fn series(
    events: &EventStore,
    tables: &InternTables,
    mmap: &[u8],
    start_ms: i64,
    end_ms: i64,
) -> InterruptReport {
    let mut out = InterruptReport { interrupts: Vec::new(), failed_casts: Vec::new() };
    if end_ms <= start_ms {
        return out;
    }

    let (lo, hi) = crate::query::window(events, start_ms, end_ms);
    let is_player = |id: u32| id != NO_UNIT && tables.guids.get(id).kind == UnitKind::Player;

    // (unit, spell) -> ts of its last unresolved CAST_START, for the
    // "N.Ns into the cast" measure.
    let mut open_casts: HashMap<(u32, u16), i64> = HashMap::new();

    for row in lo..hi {
        let ts = events.timestamp_ms[row];
        if ts < start_ms || ts > end_ms {
            continue;
        }
        let src = events.source_unit[row];
        let dst = events.dest_unit[row];

        match events.kind[row] {
            LineKind::Composed { suffix: Suffix::CastStart, .. } if src != NO_UNIT => {
                open_casts.insert((src, events.spell[row]), ts);
            }
            LineKind::Composed { suffix: Suffix::CastSuccess, .. } if src != NO_UNIT => {
                open_casts.remove(&(src, events.spell[row]));
            }
            LineKind::Composed { suffix: Suffix::CastFailed, .. } if src != NO_UNIT => {
                open_casts.remove(&(src, events.spell[row]));
                if !is_player(src) {
                    continue;
                }
                let reason = events
                    .raw_fields(row)
                    .first()
                    .map(|f| f.resolve_str(mmap))
                    .unwrap_or("");
                if reason.is_empty() {
                    continue;
                }
                let lc = reason.to_ascii_lowercase();
                if NOISE_REASONS.iter().any(|n| lc.contains(n)) {
                    continue;
                }
                let spell = events.spell[row];
                match out.failed_casts.last_mut() {
                    Some(prev)
                        if prev.source_unit == src
                            && prev.ability_id == spell
                            && prev.reason == reason
                            && ts - prev.t_ms <= FAIL_COLLAPSE_MS =>
                    {
                        prev.count += 1;
                    }
                    _ => out.failed_casts.push(FailedCast {
                        t_ms: ts,
                        source_unit: src,
                        ability_id: spell,
                        reason: reason.to_string(),
                        count: 1,
                    }),
                }
            }
            LineKind::Composed { suffix: Suffix::Interrupt, .. } if dst != NO_UNIT => {
                // `raw_fields` = [extraSpellId, extraSpellName, extraSchool]
                // (no advanced block on an interrupt).
                let interrupted_id = events
                    .raw_fields(row)
                    .first()
                    .and_then(|f| f.resolve_str(mmap).parse::<u32>().ok())
                    .and_then(|wow_id| tables.spells.get_dense(wow_id))
                    .unwrap_or(NO_SPELL);
                let elapsed_ms = open_casts.remove(&(dst, interrupted_id)).map(|hs| ts - hs);
                out.interrupts.push(Interrupt {
                    t_ms: ts,
                    source_unit: src,
                    target_unit: dst,
                    ability_id: events.spell[row],
                    interrupted_id,
                    elapsed_ms,
                });
            }
            _ => {}
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::event::parse_line;

    fn store(lines: &[&str]) -> (InternTables, EventStore, Vec<u8>) {
        let data = lines.join("\n").into_bytes();
        let mut tables = InternTables::default();
        let mut store = EventStore::default();
        let mut off = 0usize;
        for line in data.split(|&b| b == b'\n') {
            parse_line(&data, off, line, &mut tables, &mut store);
            off += line.len() + 1;
        }
        (tables, store, data)
    }

    const P: &str = "Player-1-1,\"Kicker-R-US\",0x514,0x0";
    const V: &str = "Player-2-2,\"Victim-R-US\",0x511,0x0";
    const C: &str = "Creature-0-0-0-0-1-0,\"Add\",0xa48,0x0";

    #[test]
    fn interrupt_resolves_and_measures_elapsed() {
        let (tables, s, data) = store(&[
            &format!("9/3/2026 19:23:00.000-6  SPELL_CAST_START,{V},{V},1290147,\"Poison Bolt\",0x8"),
            &format!(
                "9/3/2026 19:23:01.500-6  SPELL_INTERRUPT,{P},{V},1766,\"Kick\",0x1,1290147,\"Poison Bolt\",8"
            ),
        ]);
        let r = series(&s, &tables, &data, s.timestamp_ms[0] - 1, s.timestamp_ms[1] + 1);
        assert_eq!(r.interrupts.len(), 1);
        let i = &r.interrupts[0];
        assert_eq!(i.source_unit, s.source_unit[1]); // the kicker
        assert_eq!(i.target_unit, s.dest_unit[1]); // the victim
        assert_ne!(i.ability_id, NO_SPELL);
        assert_eq!(i.interrupted_id, s.spell[0]); // the Poison Bolt that started
        assert_eq!(i.elapsed_ms, Some(1500));
    }

    #[test]
    fn cast_success_between_starts_resets_the_elapsed_anchor() {
        let (tables, s, data) = store(&[
            &format!("9/3/2026 19:23:00.000-6  SPELL_CAST_START,{V},{V},1290147,\"Poison Bolt\",0x8"),
            &format!("9/3/2026 19:23:02.000-6  SPELL_CAST_SUCCESS,{V},{V},1290147,\"Poison Bolt\",0x8"),
            &format!("9/3/2026 19:23:05.000-6  SPELL_CAST_START,{V},{V},1290147,\"Poison Bolt\",0x8"),
            &format!(
                "9/3/2026 19:23:06.000-6  SPELL_INTERRUPT,{P},{V},1766,\"Kick\",0x1,1290147,\"Poison Bolt\",8"
            ),
        ]);
        let r = series(&s, &tables, &data, s.timestamp_ms[0] - 1, s.timestamp_ms[3] + 1);
        assert_eq!(r.interrupts[0].elapsed_ms, Some(1000)); // from the 2nd start
    }

    #[test]
    fn failed_casts_are_player_only_noise_filtered_and_collapsed() {
        let (tables, s, data) = store(&[
            &format!("9/3/2026 19:23:00.000-6  SPELL_CAST_FAILED,{P},0000000000000000,nil,0x0,0x0,5143,\"Arcane Missiles\",0x40,\"Not yet recovered\""),
            &format!("9/3/2026 19:23:01.000-6  SPELL_CAST_FAILED,{P},0000000000000000,nil,0x0,0x0,5143,\"Arcane Missiles\",0x40,\"Spell not learned\""),
            &format!("9/3/2026 19:23:02.000-6  SPELL_CAST_FAILED,{P},0000000000000000,nil,0x0,0x0,5143,\"Arcane Missiles\",0x40,\"Spell not learned\""),
            &format!("9/3/2026 19:23:03.000-6  SPELL_CAST_FAILED,{C},0000000000000000,nil,0x0,0x0,5143,\"Arcane Missiles\",0x40,\"Spell not learned\""),
        ]);
        let r = series(&s, &tables, &data, s.timestamp_ms[0] - 1, s.timestamp_ms[3] + 1);
        // "Not yet recovered" dropped; the creature's row dropped; the two
        // adjacent "Spell not learned" collapse.
        assert_eq!(r.failed_casts.len(), 1);
        assert_eq!(r.failed_casts[0].reason, "Spell not learned");
        assert_eq!(r.failed_casts[0].count, 2);
    }
}
