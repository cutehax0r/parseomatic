//! Per-encounter, per-player derived stats, computed once in a background
//! rayon pass at parse time (`docs/activity-and-movement.md`). One scan of
//! each encounter's row range routes every row to the right player's
//! accumulator, so the whole thing is O(rows in encounters), done in
//! parallel across encounters. Selecting a boss in the Overview is then an
//! O(1) lookup instead of three live `query_events` window scans.
//!
//! Holds: damage / healing (own vs pet), damage taken, death count, alive
//! time, active ("pushing buttons") time via a pluggable [`ActivityModel`],
//! and movement (distance, moving time, per-decile distance).

use rustc_hash::FxHashMap;

use rayon::prelude::*;

use crate::parser::event::{EventStore, LineKind, StandaloneKind, Suffix};
use crate::parser::intern::{InternTables, UnitKind, NO_UNIT};
use crate::parser::reports::Encounter;

const BIN_MS: i64 = 1000;
/// Ignore a position delta spanning a bigger time gap than this -- a gap
/// in the log, a teleport, or a phase transition, not real running.
const MOVE_GAP_MS: i64 = 5000;
/// World-units/sec below which a step counts as standing still, not moving.
const MOVE_SPEED_MIN: f64 = 1.0;
/// A single step contributes at most this much to "moving time" (guards
/// against one long stride across a sparse stretch of the log).
const MOVE_STEP_CAP_MS: i64 = 2000;
pub const MOVE_BINS: usize = 10;

// ---- Activity model -------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum CastEventKind {
    Start,
    Success,
    Failed,
    EmpowerStart,
    EmpowerEnd,
    Died,
}

/// One entry in a player's cast/empower/death timeline, file order.
pub struct CastEvent {
    pub ts: i64,
    pub kind: CastEventKind,
    /// Intern id of the spell. Carried for the future `GcdActivityModel`
    /// (per-spell GCD category / cast time); `ApsActivityModel` ignores it.
    #[allow(dead_code)]
    pub spell: u16,
}

pub trait ActivityModel: Sync {
    /// Active milliseconds for one player within `[start_ms, end_ms]`,
    /// given their cast timeline.
    fn active_ms(&self, casts: &[CastEvent], start_ms: i64, end_ms: i64) -> i64;
}

/// "Actions per second"-style: a 1 s bin is active if the player started a
/// cast in it, finished one in it, was mid-cast (between a `CAST_START`
/// and its `CAST_SUCCESS`), or was inside an empower span. No external
/// data needed.
///
/// Deliberate v1 limitations, to be lifted by the future `GcdActivityModel`
/// + a bundled spell-data table:
/// - **Channels under-count.** A channelled spell fires one `CAST_SUCCESS`
///   and no end event; without per-spell channel durations we can't tell
///   it from an instant cast, so it counts as a single bin.
/// - **HoT/DoT classes read low** -- ticks aren't button presses. Same
///   limitation World of Logs' metric has.
pub struct ApsActivityModel;

impl ActivityModel for ApsActivityModel {
    fn active_ms(&self, casts: &[CastEvent], start_ms: i64, end_ms: i64) -> i64 {
        if end_ms <= start_ms {
            return 0;
        }
        let n_bins = (((end_ms - start_ms) / BIN_MS) + 1).max(1) as usize;
        let mut active = vec![false; n_bins];
        let last_bin = n_bins as i64 - 1;
        let mark = |active: &mut [bool], a: i64, b: i64| {
            let a = a.max(start_ms);
            let b = b.min(end_ms);
            if b < a {
                return;
            }
            let lo = ((a - start_ms) / BIN_MS).clamp(0, last_bin) as usize;
            let hi = ((b - start_ms) / BIN_MS).clamp(0, last_bin) as usize;
            active[lo..=hi].fill(true);
        };

        let mut pending_cast: Option<i64> = None; // CAST_START awaiting success/fail
        let mut empower_open: Option<i64> = None;

        for ev in casts {
            match ev.kind {
                CastEventKind::Start => {
                    mark(&mut active, ev.ts, ev.ts);
                    pending_cast = Some(ev.ts);
                }
                CastEventKind::Success | CastEventKind::Failed => {
                    let from = pending_cast.take().unwrap_or(ev.ts);
                    mark(&mut active, from, ev.ts);
                }
                CastEventKind::EmpowerStart => empower_open = Some(ev.ts),
                CastEventKind::EmpowerEnd => {
                    let from = empower_open.take().unwrap_or(ev.ts);
                    mark(&mut active, from, ev.ts);
                }
                CastEventKind::Died => {
                    if let Some(e) = empower_open.take() {
                        mark(&mut active, e, ev.ts);
                    }
                    pending_cast = None;
                }
            }
        }
        if let Some(e) = empower_open {
            mark(&mut active, e, end_ms);
        }

        active.iter().filter(|&&x| x).count() as i64 * BIN_MS
    }
}

// ---- Per-encounter stats ------------------------------------------------

pub struct PlayerEncounterStats {
    pub unit_id: u32,
    pub damage_own: i64,
    pub damage_pet: i64,
    pub heal_own: i64,
    pub heal_pet: i64,
    pub damage_taken: i64,
    pub deaths: u32,
    pub alive_ms: i64,
    pub active_ms: i64,
    pub distance: f64,
    pub movement_ms: i64,
    /// Distance travelled in each 1/10 of the encounter, for a row sparkline.
    pub movement_bins: [f64; MOVE_BINS],
}

#[derive(Default)]
pub struct EncounterStats {
    pub players: Vec<PlayerEncounterStats>,
}

#[derive(Default)]
struct Acc {
    damage_own: i64,
    damage_pet: i64,
    heal_own: i64,
    heal_pet: i64,
    damage_taken: i64,
    deaths: u32,
    casts: Vec<CastEvent>,
    /// `(died_ts, revived_ts?)` -- open until a `SPELL_RESURRECT` targets
    /// the player (or it stays dead to the encounter's end).
    dead_spans: Vec<(i64, Option<i64>)>,
    last_pos: Option<(i64, f32, f32)>,
    distance: f64,
    movement_ms: i64,
    movement_bins: [f64; MOVE_BINS],
}

/// One `EncounterStats` per entry in `encounters`, same order. Parallel
/// across encounters.
pub fn build_all(
    events: &EventStore,
    tables: &InternTables,
    encounters: &[Encounter],
    model: &dyn ActivityModel,
) -> Vec<EncounterStats> {
    encounters
        .par_iter()
        .map(|e| build_one(events, tables, e, model))
        .collect()
}

fn build_one(
    events: &EventStore,
    tables: &InternTables,
    e: &Encounter,
    model: &dyn ActivityModel,
) -> EncounterStats {
    let (start_ms, end_ms) = (e.start_ms, e.end_ms);
    let dur = (end_ms - start_ms).max(1);

    let is_player = |id: u32| id != NO_UNIT && tables.guids.get(id).kind == UnitKind::Player;
    // A source unit resolved to its owning player (a pet folds into its
    // owner); `NO_UNIT` stays `NO_UNIT`.
    let owner_of = |id: u32| {
        if id == NO_UNIT {
            NO_UNIT
        } else {
            tables.guids.get(id).owner_id.unwrap_or(id)
        }
    };

    let mut accs: FxHashMap<u32, Acc> = FxHashMap::default();

    for row in e.start_row as usize..=e.end_row as usize {
        let ts = events.timestamp_ms[row];
        let src = events.source_unit[row];
        let dst = events.dest_unit[row];

        match events.kind[row] {
            LineKind::Composed { suffix: Suffix::Damage, .. } => {
                let owner = owner_of(src);
                if is_player(owner) {
                    let a = accs.entry(owner).or_default();
                    if src == owner {
                        a.damage_own += events.amount[row];
                    } else {
                        a.damage_pet += events.amount[row];
                    }
                }
                if is_player(dst) {
                    accs.entry(dst).or_default().damage_taken += events.amount[row];
                }
            }
            LineKind::Composed { suffix: Suffix::Heal, .. } => {
                let owner = owner_of(src);
                if is_player(owner) {
                    let a = accs.entry(owner).or_default();
                    if src == owner {
                        a.heal_own += events.amount[row];
                    } else {
                        a.heal_pet += events.amount[row];
                    }
                }
            }
            LineKind::Composed { suffix: Suffix::Resurrect, .. } => {
                if is_player(dst) {
                    if let Some(a) = accs.get_mut(&dst) {
                        if let Some(span) = a.dead_spans.last_mut() {
                            span.1.get_or_insert(ts);
                        }
                    }
                }
            }
            LineKind::Composed { suffix, .. } => {
                let kind = match suffix {
                    Suffix::CastStart => Some(CastEventKind::Start),
                    Suffix::CastSuccess => Some(CastEventKind::Success),
                    Suffix::CastFailed => Some(CastEventKind::Failed),
                    Suffix::EmpowerStart => Some(CastEventKind::EmpowerStart),
                    Suffix::EmpowerEnd | Suffix::EmpowerInterrupt => Some(CastEventKind::EmpowerEnd),
                    _ => None,
                };
                // The player's own cast only (`src` is the player itself,
                // not a pet) -- a pet auto-attacking isn't the player
                // pushing buttons.
                if let Some(kind) = kind {
                    if is_player(src) {
                        accs.entry(src).or_default().casts.push(CastEvent {
                            ts,
                            kind,
                            spell: events.spell[row],
                        });
                    }
                }
            }
            LineKind::Standalone(StandaloneKind::UnitDied) if is_player(dst) => {
                let a = accs.entry(dst).or_default();
                a.deaths += 1;
                a.dead_spans.push((ts, None));
                a.casts.push(CastEvent { ts, kind: CastEventKind::Died, spell: 0 });
            }
            _ => {}
        }

        // Movement: the player's own positioned events.
        if !events.pos_x[row].is_nan() && is_player(src) {
            let (x, y) = (events.pos_x[row], events.pos_y[row]);
            let a = accs.entry(src).or_default();
            if let Some((lt, lx, ly)) = a.last_pos {
                let dt = ts - lt;
                if dt > 0 && dt <= MOVE_GAP_MS {
                    let d = f64::from(x - lx).hypot(f64::from(y - ly));
                    a.distance += d;
                    let bin =
                        (((ts - start_ms) * MOVE_BINS as i64) / dur).clamp(0, MOVE_BINS as i64 - 1) as usize;
                    a.movement_bins[bin] += d;
                    if d / (dt as f64 / 1000.0) >= MOVE_SPEED_MIN {
                        a.movement_ms += dt.min(MOVE_STEP_CAP_MS);
                    }
                }
            }
            a.last_pos = Some((ts, x, y));
        }
    }

    let mut players: Vec<PlayerEncounterStats> = accs
        .into_iter()
        .map(|(unit_id, a)| {
            let mut dead = 0i64;
            for (d, r) in &a.dead_spans {
                let d = (*d).clamp(start_ms, end_ms);
                let r = r.unwrap_or(end_ms).clamp(start_ms, end_ms);
                dead += (r - d).max(0);
            }
            let alive_ms = (dur - dead).max(0);
            let active_ms = model.active_ms(&a.casts, start_ms, end_ms).clamp(0, alive_ms);
            PlayerEncounterStats {
                unit_id,
                damage_own: a.damage_own,
                damage_pet: a.damage_pet,
                heal_own: a.heal_own,
                heal_pet: a.heal_pet,
                damage_taken: a.damage_taken,
                deaths: a.deaths,
                alive_ms,
                active_ms,
                distance: a.distance,
                movement_ms: a.movement_ms.min(alive_ms),
                movement_bins: a.movement_bins,
            }
        })
        .collect();
    players.sort_by_key(|p| p.unit_id);
    EncounterStats { players }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(ts: i64, kind: CastEventKind) -> CastEvent {
        CastEvent { ts, kind, spell: 0 }
    }

    #[test]
    fn aps_counts_cast_bins_not_gaps() {
        // window 0..10s. START 1.0 + SUCCESS 1.4 -> bin 1. A lone SUCCESS
        // (instant, or an unresolvable channel start) at 4.0 -> bin 4.
        // START 7.0 + SUCCESS 7.5 -> bin 7. The idle gaps 2-3 and 5-6
        // don't count. Active: bins {1,4,7} = 3s.
        let casts = [
            ev(1_000, CastEventKind::Start),
            ev(1_400, CastEventKind::Success),
            ev(4_000, CastEventKind::Success),
            ev(7_000, CastEventKind::Start),
            ev(7_500, CastEventKind::Success),
        ];
        assert_eq!(ApsActivityModel.active_ms(&casts, 0, 10_000), 3_000);
    }

    #[test]
    fn aps_marks_the_span_between_start_and_success() {
        // A 2.5s cast: START 1.0 -> SUCCESS 3.5 marks bins 1,2,3 = 3s.
        let casts = [ev(1_000, CastEventKind::Start), ev(3_500, CastEventKind::Success)];
        assert_eq!(ApsActivityModel.active_ms(&casts, 0, 10_000), 3_000);
    }

    #[test]
    fn aps_empower_span_is_active() {
        let casts = [
            ev(2_000, CastEventKind::EmpowerStart),
            ev(4_500, CastEventKind::EmpowerEnd),
        ];
        // bins 2,3,4 -> 3s
        assert_eq!(ApsActivityModel.active_ms(&casts, 0, 10_000), 3_000);
    }

    #[test]
    fn aps_empty_timeline_is_zero() {
        assert_eq!(ApsActivityModel.active_ms(&[], 0, 10_000), 0);
    }
}
