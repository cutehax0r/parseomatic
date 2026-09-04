//! Per-spell damage or healing breakdown for one player over a user-chosen window --
//! backs the "Damage" and "Healing" character views. A live scan (the window is picked
//! in the UI, so unlike `stats.rs`'s parse-time precompute this can't be
//! done ahead of time), in the spirit of `query.rs` but producing things
//! the aggregate DSL can't: a per-`(spell, source)` time-bucketed series
//! plus per-hit distributions (min / max / mean / **median** / stddev)
//! split into normal hits vs crits. The `metric` picks `_DAMAGE` or `_HEAL`. Median / percentiles need the raw
//! hit values held per group, which the streaming `query_events`
//! accumulators deliberately don't do -- hence a dedicated command, the
//! same call this codebase already makes for `encounter_stats`.

use rustc_hash::FxHashMap;

use crate::parser::event::{EventStore, LineKind, Suffix, FLAG_CRIT};
use crate::parser::intern::{InternTables, NO_SPELL, NO_UNIT};
use crate::query;

/// Per-hit amount distribution for one bucket of hits (all normal, or all
/// crit). `count == 0` when there were none.
#[derive(Default)]
pub struct HitDist {
    pub count: usize,
    pub sum: i64,
    pub min: i64,
    pub max: i64,
    pub mean: f64,
    pub median: f64,
    /// Sample standard deviation (n-1); 0 for fewer than 2 hits.
    pub stddev: f64,
}

pub struct SpellStat {
    /// Intern-table spell index, or `None` for melee (`SWING_DAMAGE`).
    pub spell_id: Option<u16>,
    /// The acting unit -- the player itself, or one of its pets/guardians.
    pub source_unit: u32,
    pub is_pet: bool,
    pub total: i64,
    pub hits: usize,
    /// Summed amount per time bucket, `len == bucket_count`.
    pub buckets: Vec<i64>,
    pub normal: HitDist,
    pub crit: HitDist,
}

pub struct SpellBreakdown {
    pub start_ms: i64,
    pub end_ms: i64,
    /// Width of one bucket in ms (matches `query.rs`'s bucket maths).
    pub bucket_ms: i64,
    pub total: i64,
    /// One row per `(spell, source)` group, sorted by `total` descending.
    pub spells: Vec<SpellStat>,
}

fn hit_dist(mut v: Vec<i64>) -> HitDist {
    if v.is_empty() {
        return HitDist::default();
    }
    v.sort_unstable();
    let n = v.len();
    let sum: i64 = v.iter().sum();
    let mean = sum as f64 / n as f64;
    let median = if n % 2 == 1 {
        v[n / 2] as f64
    } else {
        (v[n / 2 - 1] + v[n / 2]) as f64 / 2.0
    };
    let stddev = if n >= 2 {
        let var = v.iter().map(|&x| (x as f64 - mean).powi(2)).sum::<f64>() / (n as f64 - 1.0);
        var.max(0.0).sqrt()
    } else {
        0.0
    };
    HitDist { count: n, sum, min: v[0], max: v[n - 1], mean, median, stddev }
}

struct Group {
    buckets: Vec<i64>,
    normal: Vec<i64>,
    crit: Vec<i64>,
    total: i64,
}

/// Which composed-event suffix the breakdown counts.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Metric {
    Damage,
    Healing,
}

impl Metric {
    fn suffix(self) -> Suffix {
        match self {
            Metric::Damage => Suffix::Damage,
            Metric::Healing => Suffix::Heal,
        }
    }
}

/// Every composed event with the `metric`'s suffix in `[start_ms, end_ms]`
/// whose source resolves (pet -> owner) to `unit_id`, grouped by
/// `(spell, source_unit)`. `bucket_count` equal time slices, matching
/// `query.rs`'s bucket maths so the frontend chart can treat these like a
/// `query_events` bucketed series.
pub fn breakdown(
    events: &EventStore,
    tables: &InternTables,
    unit_id: u32,
    start_ms: i64,
    end_ms: i64,
    bucket_count: usize,
    metric: Metric,
) -> SpellBreakdown {
    let count = bucket_count.max(1);
    let width = ((end_ms - start_ms) / count as i64).max(1);
    let empty = SpellBreakdown { start_ms, end_ms, bucket_ms: width, total: 0, spells: Vec::new() };
    if unit_id == NO_UNIT || end_ms <= start_ms {
        return empty;
    }

    // A source unit resolved to its owning player; a pet folds into its
    // owner. Same rule as `stats.rs` / `query.rs`.
    let owner_of = |id: u32| {
        if id == NO_UNIT {
            NO_UNIT
        } else {
            tables.guids.get(id).owner_id.unwrap_or(id)
        }
    };

    let (lo, hi) = query::window(events, start_ms, end_ms);
    let mut groups: FxHashMap<(u16, u32), Group> = FxHashMap::default();
    let mut total: i64 = 0;

    for row in lo..hi {
        let ts = events.timestamp_ms[row];
        if ts < start_ms || ts > end_ms {
            continue;
        }
        if !matches!(events.kind[row], LineKind::Composed { suffix, .. } if suffix == metric.suffix()) {
            continue;
        }
        let src = events.source_unit[row];
        if owner_of(src) != unit_id {
            continue;
        }
        let amt = events.amount[row];
        let g = groups
            .entry((events.spell[row], src))
            .or_insert_with(|| Group { buckets: vec![0; count], normal: Vec::new(), crit: Vec::new(), total: 0 });
        let idx = (((ts - start_ms) / width) as usize).min(count - 1);
        g.buckets[idx] += amt;
        g.total += amt;
        if events.flags[row] & FLAG_CRIT != 0 {
            g.crit.push(amt);
        } else {
            g.normal.push(amt);
        }
        total += amt;
    }

    let mut spells: Vec<SpellStat> = groups
        .into_iter()
        .map(|((spell, src), g)| {
            let normal = hit_dist(g.normal);
            let crit = hit_dist(g.crit);
            SpellStat {
                spell_id: (spell != NO_SPELL).then_some(spell),
                source_unit: src,
                is_pet: src != unit_id,
                total: g.total,
                hits: normal.count + crit.count,
                buckets: g.buckets,
                normal,
                crit,
            }
        })
        .collect();
    spells.sort_by(|a, b| b.total.cmp(&a.total).then(a.source_unit.cmp(&b.source_unit)));

    SpellBreakdown { start_ms, end_ms, bucket_ms: width, total, spells }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::event::parse_line;

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

    // SPELL_DAMAGE from `src` (guid) to a dummy add; the advanced block's
    // `ownerGUID` (field 2) is `owner_guid` -- the parser's `link_owner`
    // reads that to fold a pet into its player. Players pass their own
    // guid (or the nil guid); a pet passes its owner's.
    fn spell_damage(
        ts: &str, src_guid: &str, src_name: &str, owner_guid: &str,
        spell: u32, spell_name: &str, amount: i64, crit: bool,
    ) -> String {
        let critflag = if crit { 1 } else { 0 };
        // Damage suffix tail: ..., critical, glancing, crushing, hitType.
        format!(
            "{ts}  SPELL_DAMAGE,{src_guid},\"{src_name}\",0x511,0x0,\
             Creature-0-0-0-0-99-0,\"Add\",0xa48,0x0,{spell},\"{spell_name}\",0x40,\
             {src_guid},{owner_guid},100,100,0,0,0,0,0,0,0,0,100,0,0,0,0,0,0,\
             {amount},0,-1,64,0,0,{critflag},nil,nil,ST"
        )
    }

    #[test]
    fn breakdown_splits_crit_normal_and_folds_pets() {
        let player = "Player-1-00000001";
        let nil = "0000000000000000";
        let pet = "Pet-0-1-1-1-1-0000000001";
        let lines = vec![
            spell_damage("4/14/2026 19:00:01.000-6", player, "Warlock-Realm-US", nil, 348, "Incinerate", 10, false),
            spell_damage("4/14/2026 19:00:02.000-6", player, "Warlock-Realm-US", nil, 348, "Incinerate", 20, false),
            spell_damage("4/14/2026 19:00:03.000-6", player, "Warlock-Realm-US", nil, 348, "Incinerate", 90, false),
            spell_damage("4/14/2026 19:00:04.000-6", player, "Warlock-Realm-US", nil, 348, "Incinerate", 200, true),
            spell_damage("4/14/2026 19:00:05.000-6", pet, "Imp", player, 7814, "Firebolt", 5, false),
        ];
        let (_, tables, store) = store_from(&lines);
        let unit_id = tables.guids.get_id(player).expect("player interned");

        let start = store.timestamp_ms[0];
        let end = store.timestamp_ms[4];
        let b = breakdown(&store, &tables, unit_id, start, end, 4, Metric::Damage);

        assert_eq!(b.total, 10 + 20 + 90 + 200 + 5);
        assert_eq!(b.spells.len(), 2);

        // Sorted by total desc: Incinerate (320) then Firebolt (5).
        let inc = &b.spells[0];
        assert_eq!(inc.spell_id, Some(store.spell[0]));
        assert!(!inc.is_pet);
        assert_eq!(inc.hits, 4);
        assert_eq!(inc.normal.count, 3);
        assert_eq!(inc.normal.min, 10);
        assert_eq!(inc.normal.max, 90);
        assert_eq!(inc.normal.median, 20.0); // [10,20,90]
        assert_eq!(inc.crit.count, 1);
        assert_eq!(inc.crit.median, 200.0);
        assert_eq!(inc.buckets.iter().sum::<i64>(), 320);

        let fire = &b.spells[1];
        assert!(fire.is_pet);
        assert_eq!(fire.source_unit, tables.guids.get_id(pet).unwrap());
        assert_eq!(fire.total, 5);
    }
}
