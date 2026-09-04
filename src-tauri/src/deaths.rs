//! Per-death detail for the "Deaths" character view: for one player death,
//! a health-over-time trace for the user-chosen lookback window leading
//! up to it (the view offers 5/10/15/30s, default 10s). A live windowed
//! scan (the window is always tiny -- at most 30s of one player's rows --
//! so no precompute or caching is needed), in the spirit of `damage.rs`.
//!
//! The health trace rides on WoW's "advanced combat logging" params
//! block, which the parser already tokenizes as raw byte spans
//! (`EventStore::raw_fields`) but never promotes to typed columns --
//! see `parser::event`'s module docs ("promote when a view needs it").
//! Per `docs/combat-log-format.md` §5 (confirmed against the real
//! fixtures), the block's `currentHP`/`maxHP` fields always describe the
//! event's *dest* unit, so for a death at `unit_id`, every damage/heal
//! row with `dest_unit == unit_id` carries that player's own HP snapshot
//! at that instant -- no derived deltas needed.
//!
//! An earlier cut of this also surfaced every buff/debuff active on the
//! player as a background band, but with real data that's a wash of
//! color on every chart -- not useful. Dropped for now; re-adding it
//! later should filter to a curated, hardcoded list of auras worth
//! calling out (bloodlust, defensive cooldowns, a boss's known one-shot
//! debuff, ...) rather than showing everything.

use crate::parser::event::{EventStore, LineKind, Suffix};
use crate::parser::intern::NO_SPELL;
use crate::query;

/// One HP-affecting event (damage or heal) that touched the player.
/// `current_hp`/`max_hp` are read straight off the event's own
/// advanced-params block -- the player's real HP right after this event
/// landed, not a value derived from summing damage/heal amounts.
pub struct HpSample {
    pub timestamp_ms: i64,
    pub current_hp: i64,
    pub max_hp: i64,
    /// `true` for a heal-type event (HP increased), `false` for damage
    /// (HP decreased). Read from the event's suffix, not from comparing
    /// this sample's HP to the previous one -- avoids misclassifying an
    /// absorbed or overhealed hit.
    pub is_heal: bool,
    pub amount: i64,
    pub spell_id: Option<u16>,
    pub source_unit: u32,
    pub kind_label: String,
}

pub struct DeathDetail {
    pub start_ms: i64,
    pub end_ms: i64,
    /// Time-ordered.
    pub samples: Vec<HpSample>,
}

fn parse_i64(s: Option<&str>) -> i64 {
    s.and_then(|s| s.parse().ok()).unwrap_or(0)
}

/// Scans `[death_ms - lookback_ms, death_ms]` for HP samples touching
/// `unit_id` as the dest unit.
pub fn death_detail(events: &EventStore, mmap: &[u8], unit_id: u32, death_ms: i64, lookback_ms: i64) -> DeathDetail {
    let start_ms = death_ms - lookback_ms;
    let (lo, hi) = query::window(events, start_ms, death_ms);

    let mut samples = Vec::new();

    for row in lo..hi {
        let ts = events.timestamp_ms[row];
        if ts < start_ms || ts > death_ms || events.dest_unit[row] != unit_id {
            continue;
        }
        let LineKind::Composed { suffix: suffix @ (Suffix::Damage | Suffix::Heal), .. } = events.kind[row] else {
            continue;
        };
        if !events.has_advanced[row] {
            continue;
        }
        let raw = events.raw_fields(row);
        let current_hp = parse_i64(raw.get(2).map(|f| f.resolve_str(mmap)));
        let max_hp = parse_i64(raw.get(3).map(|f| f.resolve_str(mmap)));
        samples.push(HpSample {
            timestamp_ms: ts,
            current_hp,
            max_hp,
            is_heal: suffix == Suffix::Heal,
            amount: events.amount[row],
            spell_id: (events.spell[row] != NO_SPELL).then_some(events.spell[row]),
            source_unit: events.source_unit[row],
            kind_label: events.kind[row].label(),
        });
    }

    DeathDetail { start_ms, end_ms: death_ms, samples }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::event::parse_line;
    use crate::parser::intern::InternTables;

    fn store_from(lines: &[String]) -> (Vec<u8>, InternTables, EventStore) {
        let data = lines.join("\n").into_bytes();
        let mut tables = InternTables::default();
        let mut store = EventStore::default();
        let mut off = 0usize;
        for line in data.split(|&b| b == b'\n') {
            parse_line(&data, off, line, &mut tables, &mut store);
            off += line.len() + 1;
        }
        (data, tables, store)
    }

    // SPELL_DAMAGE/SPELL_HEAL with a synthetic advanced-params block --
    // field 3/4 (0-based 2/3 within the block) are current/max HP, per
    // docs/combat-log-format.md §5. Mirrors damage.rs's `spell_damage_full`.
    fn hp_event(
        kind: &str, ts: &str, src_guid: &str, src_name: &str, dest_guid: &str, dest_name: &str,
        spell: u32, spell_name: &str, current_hp: i64, max_hp: i64, amount: i64,
    ) -> String {
        let nil = "0000000000000000";
        let tail = if kind == "SPELL_DAMAGE" {
            format!("{amount},0,-1,64,0,0,0,nil,nil,ST")
        } else {
            format!("{amount},0,0,0,0")
        };
        format!(
            "{ts}  {kind},{src_guid},\"{src_name}\",0x511,0x0,\
             {dest_guid},\"{dest_name}\",0xa48,0x0,{spell},\"{spell_name}\",0x40,\
             {dest_guid},{nil},{current_hp},{max_hp},0,0,0,0,0,0,0,0,100,0,0,0,0,0,0,{tail}"
        )
    }

    #[test]
    fn samples_within_window_only() {
        let player = "Player-1-00000001";
        let boss = "Creature-0-0-0-0-99-0000000002";
        let healer = "Player-2-00000002";
        let lines = vec![
            // Outside the 15s lookback (24s before the death below) -- must not appear.
            hp_event("SPELL_DAMAGE", "4/14/2026 18:59:50.000-6", boss, "Boss", player, "Player-Realm-US", 1, "Claw", 900, 1000, 100),
            hp_event("SPELL_HEAL", "4/14/2026 19:00:10.000-6", healer, "Healer", player, "Player-Realm-US", 200, "Heal", 700, 1000, 300),
            hp_event("SPELL_DAMAGE", "4/14/2026 19:00:14.000-6", boss, "Boss", player, "Player-Realm-US", 1, "Claw", 0, 1000, 700),
        ];
        let (data, tables, store) = store_from(&lines);
        let unit_id = tables.guids.get_id(player).expect("player interned");
        let death_ms = store.timestamp_ms[store.timestamp_ms.len() - 1];

        let d = death_detail(&store, &data, unit_id, death_ms, 15_000);

        assert_eq!(d.start_ms, death_ms - 15_000);
        assert_eq!(d.end_ms, death_ms);

        assert_eq!(d.samples.len(), 2);
        assert!(d.samples[0].is_heal);
        assert_eq!(d.samples[0].current_hp, 700);
        assert_eq!(d.samples[0].max_hp, 1000);
        assert_eq!(d.samples[0].amount, 300);
        assert!(!d.samples[1].is_heal);
        assert_eq!(d.samples[1].current_hp, 0);
        assert_eq!(d.samples[1].source_unit, tables.guids.get_id(boss).unwrap());
    }

    #[test]
    fn lookback_ms_is_respected() {
        let player = "Player-1-00000001";
        let healer = "Player-2-00000002";
        let lines = vec![
            hp_event("SPELL_HEAL", "4/14/2026 19:00:00.000-6", healer, "Healer", player, "Player-Realm-US", 200, "Heal", 700, 1000, 300),
            hp_event("SPELL_DAMAGE", "4/14/2026 19:00:10.000-6", healer, "Healer", player, "Player-Realm-US", 1, "Claw", 0, 1000, 700),
        ];
        let (data, tables, store) = store_from(&lines);
        let unit_id = tables.guids.get_id(player).expect("player interned");
        let death_ms = store.timestamp_ms[1];

        // 5s lookback: only the death-instant event, 10s earlier heal excluded.
        let narrow = death_detail(&store, &data, unit_id, death_ms, 5_000);
        assert_eq!(narrow.samples.len(), 1);
        assert!(!narrow.samples[0].is_heal);

        // 15s lookback: both events included.
        let wide = death_detail(&store, &data, unit_id, death_ms, 15_000);
        assert_eq!(wide.samples.len(), 2);
    }
}
