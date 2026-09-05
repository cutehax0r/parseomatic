//! Distance-moved-over-time for one player over a UI-picked window --
//! backs the Movement character view's line graph. A live windowed scan
//! (the range is chosen in the UI, so unlike `stats.rs`'s parse-time
//! precompute it can't be done ahead of time), the same shape as
//! `damage.rs` / `deaths.rs`.
//!
//! Distance is `hypot(dx, dy)` between consecutive positioned events that
//! describe this unit -- keyed off `EventStore::pos_unit` (the advanced
//! block's `infoGUID`), never `source_unit`, so a DPS's outgoing damage
//! rows (which carry the *target's* coordinates) don't count as the
//! player moving. See `docs/movement-view.md`. Coordinates are ~1 unit =
//! 1 yard.
//!
//! Binned into `bucket_count` equal time slices, matching `query.rs`'s
//! bucket maths so the frontend chart can treat this like a
//! `query_events` bucketed series. The unit's death timestamps within the
//! window ride along for the chart's death rules.

use crate::parser::event::{EventStore, LineKind, StandaloneKind};
use crate::parser::intern::NO_UNIT;
use crate::query;
use crate::stats::MOVE_GAP_MS;

pub struct MovementSeries {
    pub start_ms: i64,
    pub end_ms: i64,
    /// Width of one bucket in ms (matches `query.rs`'s bucket maths).
    pub bucket_ms: i64,
    /// Distance (world units ~= yards) travelled in each slice,
    /// `len == bucket_count`.
    pub buckets: Vec<f64>,
    /// Total distance over the whole window.
    pub total: f64,
    /// This unit's `UNIT_DIED` timestamps within the window, ascending.
    pub deaths: Vec<i64>,
}

/// Walk the positioned events that describe `unit_id` in
/// `[start_ms, end_ms]`, summing straight-line distance between
/// consecutive samples into `bucket_count` equal slices. A step spanning
/// a gap longer than `MOVE_GAP_MS` (a log gap, a wipe reset, a phase
/// teleport) is skipped rather than counted as a very long run.
pub fn series(
    events: &EventStore,
    unit_id: u32,
    start_ms: i64,
    end_ms: i64,
    bucket_count: usize,
) -> MovementSeries {
    let count = bucket_count.max(1);
    let width = ((end_ms - start_ms) / count as i64).max(1);
    let mut out = MovementSeries {
        start_ms,
        end_ms,
        bucket_ms: width,
        buckets: vec![0.0; count],
        total: 0.0,
        deaths: Vec::new(),
    };
    if unit_id == NO_UNIT || end_ms <= start_ms {
        return out;
    }

    let (lo, hi) = query::window(events, start_ms, end_ms);
    let mut last: Option<(i64, f32, f32)> = None;
    for row in lo..hi {
        let ts = events.timestamp_ms[row];
        if ts < start_ms || ts > end_ms {
            continue;
        }
        if let LineKind::Standalone(StandaloneKind::UnitDied) = events.kind[row] {
            if events.dest_unit[row] == unit_id {
                out.deaths.push(ts);
            }
            continue;
        }
        // `pos_unit` already screens out rows with no position (NaN ->
        // NO_UNIT), so a match here guarantees a real coordinate pair.
        if events.pos_unit(row) != unit_id {
            continue;
        }
        let (x, y) = (events.pos_x[row], events.pos_y[row]);
        if let Some((lt, lx, ly)) = last {
            let dt = ts - lt;
            if dt > 0 && dt <= MOVE_GAP_MS {
                let d = f64::from(x - lx).hypot(f64::from(y - ly));
                let idx = (((ts - start_ms) / width) as usize).min(count - 1);
                out.buckets[idx] += d;
                out.total += d;
            }
        }
        last = Some((ts, x, y));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::event::parse_line;
    use crate::parser::intern::InternTables;

    fn store_from(lines: &[&str]) -> (InternTables, EventStore) {
        let mut tables = InternTables::default();
        let mut store = EventStore::default();
        for (i, rest) in lines.iter().enumerate() {
            // Distinct, increasing seconds so timestamps are ordered.
            let line = format!("9/3/2026 19:23:{:02}.000-6  {rest}", i);
            let data = line.into_bytes();
            parse_line(&data, 0, &data, &mut tables, &mut store);
        }
        (tables, store)
    }

    // A cast-success trail: infoGUID is the source, so these are the
    // player's own coordinates. Two 1-unit steps one second apart.
    #[test]
    fn sums_distance_between_cast_success_samples() {
        let base = "SPELL_CAST_SUCCESS,Player-1-1,\"Mv-R-US\",0x512,0x0,0000000000000000,nil,0x80000000,0x80000000,\
                    100,\"Spell\",0x1,Player-1-1,0000000000000000,1,1,0,0,0,0,0,0,0,0,0,0,";
        let (tables, store) = store_from(&[
            &format!("{base}0.00,0.00,2607,0,1"),
            &format!("{base}1.00,0.00,2607,0,1"),
            &format!("{base}1.00,1.00,2607,0,1"),
        ]);
        let unit = store.source_unit[0];
        assert_ne!(unit, NO_UNIT);
        let _ = &tables;
        let s = series(&store, unit, store.timestamp_ms[0], store.timestamp_ms[2], 2);
        assert!((s.total - 2.0).abs() < 1e-6, "two 1-unit steps -> total 2, got {}", s.total);
        assert!((s.buckets.iter().sum::<f64>() - 2.0).abs() < 1e-6);
    }

    // Outgoing damage carries the TARGET's position -- it must not be
    // read as the caster moving.
    #[test]
    fn ignores_outgoing_damage_position() {
        let dmg = "SPELL_DAMAGE,Player-1-1,\"Mv-R-US\",0x512,0x0,Creature-0-0-0-0-1-0,\"Boss\",0x10a48,0x0,\
                   100,\"Spell\",0x1,Creature-0-0-0-0-1-0,0000000000000000,1,1,0,0,0,0,0,0,0,0,0,0,\
                   500.00,500.00,2607,0,93,10,10,-1,1,0,0,0,nil,nil,ST";
        let (_tables, store) = store_from(&[dmg, dmg]);
        let caster = store.source_unit[0];
        let s = series(&store, caster, store.timestamp_ms[0], store.timestamp_ms[1] + 1, 2);
        assert_eq!(s.total, 0.0, "the caster never moved; the boss's coords must not count");
    }

    #[test]
    fn collects_unit_died_timestamps_for_the_unit() {
        let (_tables, store) = store_from(&[
            "UNIT_DIED,0000000000000000,nil,0x80000000,0x80000000,Player-1-1,\"Mv-R-US\",0x512,0x0,0",
        ]);
        let dead = store.dest_unit[0];
        assert_ne!(dead, NO_UNIT);
        let s = series(&store, dead, store.timestamp_ms[0] - 1, store.timestamp_ms[0] + 1, 1);
        assert_eq!(s.deaths, vec![store.timestamp_ms[0]]);
    }
}
