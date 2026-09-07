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

use crate::hits::HitScanner;
use crate::parser::event::{EventStore, LineKind, StandaloneKind, Suffix};
use crate::parser::intern::{InternTables, UnitKind, NO_UNIT};
use crate::query;
use crate::stats::MOVE_GAP_MS;

/// One `(t, x, y)` fix for the unit -- an event that carried the unit's
/// own advanced-block position, in file order.
pub struct Sample {
    pub t_ms: i64,
    pub x: f32,
    pub y: f32,
}

/// One death interval for the unit: `UNIT_DIED` -> the `SPELL_RESURRECT`
/// that brought them back, or `None` if they were still dead at the
/// window's end.
pub struct DeathSpan {
    pub start_ms: i64,
    pub end_ms: Option<i64>,
}

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
    /// This unit's death intervals within the window, ascending.
    pub death_spans: Vec<DeathSpan>,
    /// Ordered `(t, x, y)` fixes for the top-down path plot -- every event
    /// in the window that carried this unit's own position.
    pub samples: Vec<Sample>,
    /// Playable-area bounding box `[x0, x1, y0, y1]` from the `MAP_CHANGE`
    /// in effect at the window (corners are NOT sorted -- see
    /// `docs/movement-view.md` §5). `None` if no `MAP_CHANGE` precedes the
    /// window's end. Kept for reference; the plot frames on `fit_box`.
    pub map_box: Option<[f32; 4]>,
    /// Tight bounds `[min_x, max_x, min_y, max_y]` over **every player's**
    /// position fixes in the window -- "the area the raid played in". The
    /// path plot frames on this (padded) so one player's route fills the
    /// drawing area instead of clustering in the middle of the whole
    /// playable map. `None` if no player carried a position in the window.
    /// Stopgap until a real map image + a per-map lookup replace it.
    pub fit_box: Option<[f32; 4]>,
}

/// Walk the positioned events that describe `unit_id` in
/// `[start_ms, end_ms]`, summing straight-line distance between
/// consecutive samples into `bucket_count` equal slices and collecting
/// the raw `(t, x, y)` fixes for the path plot. A step spanning a gap
/// longer than `MOVE_GAP_MS` (a log gap, a wipe reset, a phase teleport)
/// doesn't count toward distance, but the sample is still recorded so
/// the path can break across it. `mmap` resolves the `MAP_CHANGE` box.
pub fn series(
    events: &EventStore,
    tables: &InternTables,
    mmap: &[u8],
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
        death_spans: Vec::new(),
        samples: Vec::new(),
        map_box: None,
        fit_box: None,
    };
    if unit_id == NO_UNIT || end_ms <= start_ms {
        return out;
    }
    let is_player = |id: u32| id != NO_UNIT && tables.guids.get(id).kind == UnitKind::Player;

    let (lo, hi) = query::window(events, start_ms, end_ms);

    // The MAP_CHANGE in effect at the window: the most recent one at or
    // before `hi`. Scan backward and stop at the first hit -- it's
    // normally in the trash span just before the pull, a few thousand
    // rows back at most.
    for row in (0..hi).rev() {
        if !matches!(events.kind[row], LineKind::Standalone(StandaloneKind::MapChange)) {
            continue;
        }
        let raw = events.raw_fields(row);
        // raw_fields keeps the subevent name at [0]:
        // ["MAP_CHANGE", uiMapID, name, x0, x1, y0, y1]
        let f = |i: usize| raw.get(i).and_then(|s| s.resolve_str(mmap).parse::<f32>().ok());
        if let (Some(x0), Some(x1), Some(y0), Some(y1)) = (f(3), f(4), f(5), f(6)) {
            out.map_box = Some([x0, x1, y0, y1]);
        }
        break;
    }

    let mut last: Option<(i64, f32, f32)> = None;
    for row in lo..hi {
        let ts = events.timestamp_ms[row];
        if ts < start_ms || ts > end_ms {
            continue;
        }
        if let LineKind::Standalone(StandaloneKind::UnitDied) = events.kind[row] {
            if events.dest_unit[row] == unit_id {
                out.death_spans.push(DeathSpan { start_ms: ts, end_ms: None });
            }
            continue;
        }
        // A res closes the most recent still-open death span.
        if matches!(events.kind[row], LineKind::Composed { suffix: Suffix::Resurrect, .. })
            && events.dest_unit[row] == unit_id
        {
            if let Some(span) = out.death_spans.last_mut() {
                span.end_ms.get_or_insert(ts);
            }
        }
        // `pos_unit` is `NO_UNIT` exactly when the row has no position, so
        // a non-NO_UNIT value guarantees a real coord pair.
        let pos_unit = events.pos_unit[row];
        if pos_unit == NO_UNIT {
            continue;
        }
        let (x, y) = (events.pos_x[row], events.pos_y[row]);
        // Every player's fix widens the shared drawing box.
        if is_player(pos_unit) {
            let b = out.fit_box.get_or_insert([x, x, y, y]);
            b[0] = b[0].min(x);
            b[1] = b[1].max(x);
            b[2] = b[2].min(y);
            b[3] = b[3].max(y);
        }
        if pos_unit != unit_id {
            continue;
        }
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
        out.samples.push(Sample { t_ms: ts, x, y });
    }

    out
}

/// A row for the Movement view's per-moment side table: one of the
/// player's cast / damage / heal events. Kinds are strings on the wire
/// (`lib.rs`), an enum here.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum EventKind {
    Cast,
    DamageDone,
    DamageTaken,
    HealDone,
    HealTaken,
}

impl EventKind {
    pub fn as_str(self) -> &'static str {
        match self {
            EventKind::Cast => "cast",
            EventKind::DamageDone => "damageDone",
            EventKind::DamageTaken => "damageTaken",
            EventKind::HealDone => "healDone",
            EventKind::HealTaken => "healTaken",
        }
    }
}

pub struct EventRow {
    pub t_ms: i64,
    pub kind: EventKind,
    /// Intern id, or `NO_SPELL` for a melee swing.
    pub spell_id: u16,
    /// 0 for a `Cast` row.
    pub amount: i64,
    /// The other party -- target for `*Done` / `Cast`, source for `*Taken`.
    pub other_unit: u32,
}

/// Every cast / damage / heal event involving `unit_id` in
/// `[start_ms, end_ms]`, in file order. `SPELL_CAST_SUCCESS` only for
/// casts (start events carry no useful detail here). The damage/heal
/// classification + `SWING_DAMAGE` / `SWING_DAMAGE_LANDED` dedup is the
/// shared `hits::HitScanner`, so this and `timeline::series` stay in
/// lockstep.
pub fn events(events: &EventStore, unit_id: u32, start_ms: i64, end_ms: i64) -> Vec<EventRow> {
    let mut out = Vec::new();
    if unit_id == NO_UNIT || end_ms <= start_ms {
        return out;
    }
    let (lo, hi) = query::window(events, start_ms, end_ms);
    let mut scan = HitScanner::default();
    for row in lo..hi {
        let ts = events.timestamp_ms[row];
        if ts < start_ms || ts > end_ms {
            continue;
        }
        // Casts have no SWING twin -- classified directly, not via the scanner.
        if let LineKind::Composed { suffix: Suffix::CastSuccess, .. } = events.kind[row] {
            if events.source_unit[row] == unit_id {
                out.push(EventRow {
                    t_ms: ts,
                    kind: EventKind::Cast,
                    spell_id: events.spell[row],
                    amount: 0,
                    other_unit: events.dest_unit[row],
                });
            }
            continue;
        }
        if let Some(h) = scan.classify(events, row, unit_id) {
            let kind = match (h.heal, h.done) {
                (false, true) => EventKind::DamageDone,
                (false, false) => EventKind::DamageTaken,
                (true, true) => EventKind::HealDone,
                (true, false) => EventKind::HealTaken,
            };
            out.push(EventRow {
                t_ms: h.t_ms,
                kind,
                spell_id: h.spell_id,
                amount: h.amount,
                other_unit: h.other_unit,
            });
        }
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
        let s = series(&store, &tables, &[], unit, store.timestamp_ms[0], store.timestamp_ms[2], 2);
        assert!((s.total - 2.0).abs() < 1e-6, "two 1-unit steps -> total 2, got {}", s.total);
        assert!((s.buckets.iter().sum::<f64>() - 2.0).abs() < 1e-6);
        // fit_box spans every player fix: x in [0,1], y in [0,1].
        assert_eq!(s.fit_box, Some([0.0, 1.0, 0.0, 1.0]));
    }

    // Outgoing damage carries the TARGET's position -- it must not be
    // read as the caster moving.
    #[test]
    fn ignores_outgoing_damage_position() {
        let dmg = "SPELL_DAMAGE,Player-1-1,\"Mv-R-US\",0x512,0x0,Creature-0-0-0-0-1-0,\"Boss\",0x10a48,0x0,\
                   100,\"Spell\",0x1,Creature-0-0-0-0-1-0,0000000000000000,1,1,0,0,0,0,0,0,0,0,0,0,\
                   500.00,500.00,2607,0,93,10,10,-1,1,0,0,0,nil,nil,ST";
        let (tables, store) = store_from(&[dmg, dmg]);
        let caster = store.source_unit[0];
        let s = series(&store, &tables, &[], caster, store.timestamp_ms[0], store.timestamp_ms[1] + 1, 2);
        assert_eq!(s.total, 0.0, "the caster never moved; the boss's coords must not count");
    }

    #[test]
    fn opens_a_death_span_on_unit_died_for_the_unit() {
        let (tables, store) = store_from(&[
            "UNIT_DIED,0000000000000000,nil,0x80000000,0x80000000,Player-1-1,\"Mv-R-US\",0x512,0x0,0",
        ]);
        let dead = store.dest_unit[0];
        assert_ne!(dead, NO_UNIT);
        let s = series(&store, &tables, &[], dead, store.timestamp_ms[0] - 1, store.timestamp_ms[0] + 1, 1);
        assert_eq!(s.death_spans.len(), 1);
        assert_eq!(s.death_spans[0].start_ms, store.timestamp_ms[0]);
        assert_eq!(s.death_spans[0].end_ms, None); // no res -> stays open
    }

    // One shared buffer so the MAP_CHANGE row's raw-field spans stay
    // valid for `resolve_str`.
    #[test]
    fn collects_samples_and_the_map_box() {
        let cast = |t: &str, xy: &str| {
            format!(
                "9/3/2026 19:23:{t}-6  SPELL_CAST_SUCCESS,Player-1-1,\"Mv-R-US\",0x512,0x0,\
                 0000000000000000,nil,0x80000000,0x80000000,100,\"Spell\",0x1,\
                 Player-1-1,0000000000000000,1,1,0,0,0,0,0,0,0,0,0,0,{xy},2607,0,1"
            )
        };
        let lines = [
            "9/3/2026 19:23:00.000-6  MAP_CHANGE,2607,\"The Venomous Abyss\",1088.000000,410.000000,508.500000,-508.500000".to_string(),
            cast("01.000", "10.0,20.0"),
            cast("02.000", "13.0,24.0"),
        ];
        let data = lines.join("\n").into_bytes();
        let mut tables = InternTables::default();
        let mut store = EventStore::default();
        let mut off = 0usize;
        for line in data.split(|&b| b == b'\n') {
            parse_line(&data, off, line, &mut tables, &mut store);
            off += line.len() + 1;
        }

        let unit = store.source_unit[1];
        assert_ne!(unit, NO_UNIT);
        let s = series(&store, &tables, &data, unit, store.timestamp_ms[0], store.timestamp_ms[2] + 1, 2);
        assert_eq!(s.samples.len(), 2);
        assert_eq!((s.samples[0].x, s.samples[0].y), (10.0, 20.0));
        assert_eq!(s.samples[1].t_ms, store.timestamp_ms[2]);
        assert_eq!(s.map_box, Some([1088.0, 410.0, 508.5, -508.5]));
        // fit_box: tight bounds over the two player fixes.
        assert_eq!(s.fit_box, Some([10.0, 13.0, 20.0, 24.0]));
        // 3-4-5 triangle between the two fixes.
        assert!((s.total - 5.0).abs() < 1e-6, "got {}", s.total);
    }

    #[test]
    fn events_classifies_by_direction_and_dedups_the_swing_pair() {
        // Shared buffer + hand-set timestamps so the SWING pair lands on
        // the same millisecond, as it does in real logs.
        let lines = [
            "9/3/2026 19:23:00.000-6  SPELL_CAST_SUCCESS,Player-1-1,\"Mv-R-US\",0x512,0x0,Creature-0-0-0-0-1-0,\"Boss\",0x10a48,0x0,100,\"Zap\",0x1,Player-1-1,0000000000000000,1,1,0,0,0,0,0,0,0,0,0,0,0,0,2607,0,1",
            "9/3/2026 19:23:00.500-6  SPELL_DAMAGE,Player-1-1,\"Mv-R-US\",0x512,0x0,Creature-0-0-0-0-1-0,\"Boss\",0x10a48,0x0,100,\"Zap\",0x1,Creature-0-0-0-0-1-0,0000000000000000,1,1,0,0,0,0,0,0,0,0,0,0,0,0,2607,0,93,900,0,-1,1,0,0,0,nil,nil,ST",
            "9/3/2026 19:23:01.000-6  SWING_DAMAGE,Creature-0-0-0-0-1-0,\"Boss\",0x10a48,0x0,Player-1-1,\"Mv-R-US\",0x512,0x0,Creature-0-0-0-0-1-0,0000000000000000,1,1,0,0,0,0,0,0,0,0,0,0,0,0,2607,0,93,500,0,-1,1,0,0,0,nil,nil,nil",
            "9/3/2026 19:23:01.000-6  SWING_DAMAGE_LANDED,Creature-0-0-0-0-1-0,\"Boss\",0x10a48,0x0,Player-1-1,\"Mv-R-US\",0x512,0x0,Player-1-1,0000000000000000,1,1,0,0,0,0,0,0,0,0,0,0,0,0,2607,0,93,500,0,-1,1,0,0,0,nil,nil,nil",
        ];
        let data = lines.join("\n").into_bytes();
        let mut tables = InternTables::default();
        let mut store = EventStore::default();
        let mut off = 0usize;
        for line in data.split(|&b| b == b'\n') {
            parse_line(&data, off, line, &mut tables, &mut store);
            off += line.len() + 1;
        }

        let unit = store.source_unit[0];
        let ev = events(&store, unit, store.timestamp_ms[0] - 1, store.timestamp_ms[3] + 1);
        let kinds: Vec<_> = ev.iter().map(|e| e.kind.as_str()).collect();
        // the same-ms SWING pair collapses to one DamageTaken row.
        assert_eq!(kinds, vec!["cast", "damageDone", "damageTaken"]);
        assert_eq!(ev[1].amount, 900);
        assert_eq!(ev[2].amount, 500);
        assert_eq!(ev[2].other_unit, store.source_unit[2]); // the boss
    }
}
