//! Damage / heal event classification shared by the per-player window
//! scans -- `movement::events` (the Movement view's side table) and
//! `timeline::series` (the Timeline view's lanes). One place for the
//! direction logic and the same-millisecond `SWING_DAMAGE` /
//! `SWING_DAMAGE_LANDED` dedup, so the two views can never drift.

use crate::parser::event::{EventStore, LineKind, Prefix, Suffix};

/// A `_DAMAGE` or `_HEAL` row that touches the scanned unit, already
/// collapsed against its SWING twin.
#[derive(Clone, Copy)]
pub struct Hit {
    pub t_ms: i64,
    /// `false` = damage, `true` = heal.
    pub heal: bool,
    /// `true` = dealt by the unit, `false` = taken by the unit.
    pub done: bool,
    /// `SPELL_PERIODIC_*` -- a DoT / HoT tick rather than a direct hit.
    pub periodic: bool,
    /// Intern id, or `NO_SPELL` for a melee swing.
    pub spell_id: u16,
    pub amount: i64,
    /// The other party: dest when `done`, source when taken.
    pub other_unit: u32,
}

/// Stateful classifier -- feed it rows in file order and it yields the
/// unit's damage/heal `Hit`s. It collapses the `SWING_DAMAGE` /
/// `SWING_DAMAGE_LANDED` pair: identical fields, one row the attacker's
/// and one the victim's, which the parser classifies the same way and
/// can't otherwise tell apart.
#[derive(Default)]
pub struct HitScanner {
    /// `(ts, dir, source, dest, spell, amount)` of the last emitted hit.
    prev: Option<(i64, u8, u32, u32, u16, i64)>,
}

impl HitScanner {
    /// Classify one row against `unit_id`. `None` when the row isn't a
    /// `_DAMAGE` / `_HEAL` touching the unit, or is the dropped SWING
    /// twin of the row just before it.
    pub fn classify(&mut self, events: &EventStore, row: usize, unit_id: u32) -> Option<Hit> {
        let (prefix, heal) = match events.kind[row] {
            LineKind::Composed { prefix, suffix: Suffix::Damage } => (prefix, false),
            LineKind::Composed { prefix, suffix: Suffix::Heal } => (prefix, true),
            _ => return None,
        };
        let src = events.source_unit[row];
        let dst = events.dest_unit[row];
        let done = if src == unit_id {
            true
        } else if dst == unit_id {
            false
        } else {
            return None;
        };

        let ts = events.timestamp_ms[row];
        let spell = events.spell[row];
        let amount = events.amount[row];
        let dir = (u8::from(heal) << 1) | u8::from(done);
        let key = (ts, dir, src, dst, spell, amount);
        if self.prev == Some(key) {
            return None;
        }
        self.prev = Some(key);

        Some(Hit {
            t_ms: ts,
            heal,
            done,
            periodic: prefix == Prefix::SpellPeriodic,
            spell_id: spell,
            amount,
            other_unit: if done { dst } else { src },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::event::parse_line;
    use crate::parser::intern::InternTables;

    /// Parse fully-formed lines (each with its own timestamp) into an
    /// `EventStore` from one shared buffer.
    fn store(lines: &[&str]) -> EventStore {
        let data = lines.join("\n").into_bytes();
        let mut tables = InternTables::default();
        let mut store = EventStore::default();
        let mut off = 0usize;
        for line in data.split(|&b| b == b'\n') {
            parse_line(&data, off, line, &mut tables, &mut store);
            off += line.len() + 1;
        }
        store
    }

    const T0: &str = "9/3/2026 19:23:00.000-6  ";
    const T5: &str = "9/3/2026 19:23:05.000-6  ";

    #[test]
    fn direction_and_swing_pair_dedup() {
        // Player nukes the boss (outgoing), then the same-ms SWING pair:
        // SWING_DAMAGE (attacker's row) + SWING_DAMAGE_LANDED (victim's
        // row) -- identical fields, must collapse to one taken hit.
        let s = store(&[
            &format!("{T0}SPELL_DAMAGE,Player-1-1,\"P\",0x512,0x0,Creature-0-0-0-0-1-0,\"Boss\",0x10a48,0x0,10,\"Zap\",0x1,Creature-0-0-0-0-1-0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2607,0,93,900,0,-1,1,0,0,0,nil,nil,ST"),
            &format!("{T5}SWING_DAMAGE,Creature-0-0-0-0-1-0,\"Boss\",0x10a48,0x0,Player-1-1,\"P\",0x512,0x0,Creature-0-0-0-0-1-0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2607,0,93,500,0,-1,1,0,0,0,nil,nil,nil"),
            &format!("{T5}SWING_DAMAGE_LANDED,Creature-0-0-0-0-1-0,\"Boss\",0x10a48,0x0,Player-1-1,\"P\",0x512,0x0,Player-1-1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2607,0,93,500,0,-1,1,0,0,0,nil,nil,nil"),
        ]);
        let unit = s.source_unit[0];
        let mut scan = HitScanner::default();
        let hits: Vec<_> = (0..s.len()).filter_map(|r| scan.classify(&s, r, unit)).collect();
        assert_eq!(hits.len(), 2, "the SWING pair collapses to one");
        assert!(!hits[0].heal && hits[0].done && hits[0].amount == 900);
        assert!(!hits[1].heal && !hits[1].done && hits[1].amount == 500);
        assert_eq!(hits[1].other_unit, s.source_unit[1]); // the boss
    }

    #[test]
    fn periodic_flag_and_non_participant() {
        let s = store(&[
            &format!("{T0}SPELL_PERIODIC_HEAL,Player-1-1,\"P\",0x512,0x0,Player-1-1,\"P\",0x512,0x0,20,\"HoT\",0x8,Player-1-1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2607,0,42,0,0,nil"),
            &format!("{T5}SPELL_DAMAGE,Creature-9-9,\"A\",0x10a48,0x0,Creature-8-8,\"B\",0x10a48,0x0,1,\"x\",0x1,Creature-8-8,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2607,0,93,5,0,-1,1,0,0,0,nil,nil,ST"),
        ]);
        let unit = s.source_unit[0];
        let mut scan = HitScanner::default();
        assert!(scan.classify(&s, 0, unit).is_some_and(|h| h.heal && h.done && h.periodic));
        assert!(scan.classify(&s, 1, unit).is_none()); // player isn't in it
    }
}
