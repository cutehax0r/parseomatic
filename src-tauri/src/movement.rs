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

use crate::parser::event::{EventStore, LineKind, StandaloneKind, Suffix};
use crate::parser::intern::{InternTables, UnitKind, NO_UNIT};
use crate::query;
use crate::stats::{BIN_MS, MOVE_GAP_MS, MOVE_SPEED_MIN};

/// One `(t, x, y)` fix for the unit -- an event that carried the unit's
/// own advanced-block position, in file order.
pub struct Sample {
    pub t_ms: i64,
    pub x: f32,
    pub y: f32,
}

/// Time (ms) split four ways over the window's `BIN_MS` slots: was the
/// player *moving* in the slot (majority of it spent above
/// `MOVE_SPEED_MIN`), and did they *act* in it (a `SPELL_CAST_START` /
/// `_SUCCESS` of their own landed in the slot)? Backs the Movement
/// view's pie chart.
#[derive(Default)]
pub struct ActivitySplit {
    pub standing_ms: i64,
    pub standing_active_ms: i64,
    pub moving_ms: i64,
    pub moving_active_ms: i64,
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
    /// This unit's `UNIT_DIED` timestamps within the window, ascending.
    pub deaths: Vec<i64>,
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
    /// Standing / moving x idle / acting time split (see `ActivitySplit`).
    pub activity: ActivitySplit,
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
        deaths: Vec::new(),
        samples: Vec::new(),
        map_box: None,
        fit_box: None,
        activity: ActivitySplit::default(),
    };
    if unit_id == NO_UNIT || end_ms <= start_ms {
        return out;
    }
    let is_player = |id: u32| id != NO_UNIT && tables.guids.get(id).kind == UnitKind::Player;

    // BIN_MS slots for the standing/moving x idle/acting split.
    let n_slots = (((end_ms - start_ms) + BIN_MS - 1) / BIN_MS).max(1) as usize;
    let slot_bounds = |i: usize| {
        let s = start_ms + i as i64 * BIN_MS;
        (s, (s + BIN_MS).min(end_ms))
    };
    let mut slot_moving_ms = vec![0i64; n_slots]; // ms of the slot spent above MOVE_SPEED_MIN
    let mut slot_acted = vec![false; n_slots]; // a cast of the player's landed in the slot

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
                out.deaths.push(ts);
            }
            continue;
        }
        // "Acting" in a slot: the player started or completed a cast in
        // it. Checked before the position gate because CAST_START carries
        // no advanced block (no position).
        if matches!(
            events.kind[row],
            LineKind::Composed { suffix: Suffix::CastStart | Suffix::CastSuccess, .. }
        ) && events.source_unit[row] == unit_id
        {
            let si = (((ts - start_ms) / BIN_MS).max(0) as usize).min(n_slots - 1);
            slot_acted[si] = true;
        }
        // `pos_unit` already screens out rows with no position (NaN ->
        // NO_UNIT), so a non-NO_UNIT result guarantees a real coord pair.
        let pos_unit = events.pos_unit(row);
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

                // Spread this interval's ms across the slots it covers if
                // the player was moving over it (average speed above the
                // stand/walk threshold).
                if d / (dt as f64 / 1000.0) >= MOVE_SPEED_MIN {
                    let a = lt.max(start_ms);
                    let b = ts.min(end_ms);
                    let mut si = ((a - start_ms) / BIN_MS).max(0) as usize;
                    while si < n_slots {
                        let (ss, se) = slot_bounds(si);
                        if ss >= b {
                            break;
                        }
                        let overlap = se.min(b) - ss.max(a);
                        if overlap > 0 {
                            slot_moving_ms[si] += overlap;
                        }
                        si += 1;
                    }
                }
            }
        }
        last = Some((ts, x, y));
        out.samples.push(Sample { t_ms: ts, x, y });
    }

    // Fold the slots into the four-way split: a slot counts as "moving"
    // when the majority of it was spent above the threshold.
    for i in 0..n_slots {
        let (ss, se) = slot_bounds(i);
        let slot_ms = se - ss;
        if slot_ms <= 0 {
            continue;
        }
        let moving = slot_moving_ms[i] * 2 >= slot_ms;
        match (moving, slot_acted[i]) {
            (false, false) => out.activity.standing_ms += slot_ms,
            (false, true) => out.activity.standing_active_ms += slot_ms,
            (true, false) => out.activity.moving_ms += slot_ms,
            (true, true) => out.activity.moving_active_ms += slot_ms,
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
        // Moving at exactly the 1 yd/s threshold the whole 2 s, casting
        // in every slot -> all time is "moving + acting".
        let a = &s.activity;
        assert_eq!(
            (a.standing_ms, a.standing_active_ms, a.moving_ms, a.moving_active_ms),
            (0, 0, 0, 2000)
        );
    }

    #[test]
    fn still_while_casting_is_standing_and_acting() {
        // Same position at 0 s and 2 s, a cast at each -> no movement,
        // every slot has an action.
        let base = "SPELL_CAST_SUCCESS,Player-1-1,\"Mv-R-US\",0x512,0x0,0000000000000000,nil,0x80000000,0x80000000,\
                    100,\"Spell\",0x1,Player-1-1,0000000000000000,1,1,0,0,0,0,0,0,0,0,0,0,";
        let (tables, store) = store_from(&[
            &format!("{base}5.00,5.00,2607,0,1"),
            &format!("{base}5.00,5.00,2607,0,1"),
            &format!("{base}5.00,5.00,2607,0,1"),
        ]);
        let unit = store.source_unit[0];
        let s = series(&store, &tables, &[], unit, store.timestamp_ms[0], store.timestamp_ms[2], 2);
        let a = &s.activity;
        assert_eq!(a.moving_ms + a.moving_active_ms, 0, "never moved");
        assert_eq!(a.standing_active_ms, 2000, "cast in both slots, standing");
        assert_eq!(a.standing_ms, 0);
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
    fn collects_unit_died_timestamps_for_the_unit() {
        let (tables, store) = store_from(&[
            "UNIT_DIED,0000000000000000,nil,0x80000000,0x80000000,Player-1-1,\"Mv-R-US\",0x512,0x0,0",
        ]);
        let dead = store.dest_unit[0];
        assert_ne!(dead, NO_UNIT);
        let s = series(&store, &tables, &[], dead, store.timestamp_ms[0] - 1, store.timestamp_ms[0] + 1, 1);
        assert_eq!(s.deaths, vec![store.timestamp_ms[0]]);
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
}
