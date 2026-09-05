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

/// Width of one activity slot. 1.5 s ~= one global cooldown -- a lone
/// instant cast (or an unresolvable channel start) then fills its whole
/// slot rather than reading as mostly-idle, which 1 s slots did.
const BIN_MS: i64 = 1500;
/// Ignore a position delta spanning a bigger time gap than this -- a gap
/// in the log, a teleport, or a phase transition, not real running.
const MOVE_GAP_MS: i64 = 5000;
/// World-units/sec below which a step counts as standing still, not moving.
const MOVE_SPEED_MIN: f64 = 1.0;
/// A single step contributes at most this much to "moving time" (guards
/// against one long stride across a sparse stretch of the log).
const MOVE_STEP_CAP_MS: i64 = 2000;
/// The encounter is sliced into this many equal time buckets for the
/// per-row sparklines (activity curve, movement bars).
pub const DECILES: usize = 10;

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
    /// Active/idle bitmap over `[start_ms, end_ms]`, one entry per
    /// `BIN_MS` slot (rounded up), given the player's cast timeline. Slot
    /// i covers `[start_ms + i*BIN_MS, +BIN_MS)`. The caller derives the
    /// scalar active-ms and the per-decile profile from it.
    fn active_slots(&self, casts: &[CastEvent], start_ms: i64, end_ms: i64) -> Vec<bool>;
}

/// Milliseconds of `true` in an `active_slots` bitmap.
fn active_ms(slots: &[bool]) -> i64 {
    slots.iter().filter(|&&on| on).count() as i64 * BIN_MS
}

/// "Actions per second"-style: a `BIN_MS` (1.5 s, ~one GCD) slot is active
/// if the player started a cast in it, finished one in it, was mid-cast
/// (between a `CAST_START` and its `CAST_SUCCESS`), or was inside an
/// empower span. No external data needed.
///
/// Deliberate v1 limitations, to be lifted by the future `GcdActivityModel`
/// + a bundled spell-data table:
/// - **Channels under-count.** A channelled spell fires one `CAST_SUCCESS`
///   and no end event; without per-spell channel durations we can't tell
///   it from an instant cast, so it counts as a single slot.
/// - **HoT/DoT classes read low** -- ticks aren't button presses. Same
///   limitation World of Logs' metric has.
pub struct ApsActivityModel;

impl ActivityModel for ApsActivityModel {
    fn active_slots(&self, casts: &[CastEvent], start_ms: i64, end_ms: i64) -> Vec<bool> {
        if end_ms <= start_ms {
            return Vec::new();
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

        active
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
    /// Per-decile (1/10 of the encounter) fractions, for row sparklines:
    /// `active_bins[i]` is the share of decile i the player was active
    /// for; `dead_bins[i]` the share they were dead for; `movement_bins[i]`
    /// the distance travelled in it.
    pub active_bins: [f64; DECILES],
    pub dead_bins: [f64; DECILES],
    pub movement_bins: [f64; DECILES],
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
    movement_bins: [f64; DECILES],
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

        // Movement: walk the events that record THIS player's own
        // position. The advanced-block coords belong to `infoGUID` --
        // the event's dest for damage/heal effects, its source only for
        // `SPELL_CAST_SUCCESS` -- so key off `pos_unit`, never the row's
        // source: for a DPS tunnelling a boss, `source` is the player
        // holding still while the boss's coordinates stream past every
        // `SPELL_DAMAGE` line (`docs/movement-view.md`). Player only, no
        // pet fold -- a pet's position isn't its owner's.
        let pos_unit = events.pos_unit(row);
        if pos_unit != NO_UNIT && is_player(pos_unit) {
            let (x, y) = (events.pos_x[row], events.pos_y[row]);
            let a = accs.entry(pos_unit).or_default();
            if let Some((lt, lx, ly)) = a.last_pos {
                let dt = ts - lt;
                if dt > 0 && dt <= MOVE_GAP_MS {
                    let d = f64::from(x - lx).hypot(f64::from(y - ly));
                    a.distance += d;
                    let bin =
                        (((ts - start_ms) * DECILES as i64) / dur).clamp(0, DECILES as i64 - 1) as usize;
                    a.movement_bins[bin] += d;
                    if d / (dt as f64 / 1000.0) >= MOVE_SPEED_MIN {
                        a.movement_ms += dt.min(MOVE_STEP_CAP_MS);
                    }
                }
            }
            a.last_pos = Some((ts, x, y));
        }
    }

    let decile_ms = dur as f64 / DECILES as f64;

    let mut players: Vec<PlayerEncounterStats> = accs
        .into_iter()
        .map(|(unit_id, a)| {
            // Dead time overall + spread across the deciles it overlaps.
            let mut dead = 0i64;
            let mut dead_bins = [0f64; DECILES];
            for (ds, dr) in &a.dead_spans {
                let ds = (*ds).clamp(start_ms, end_ms);
                let de = dr.unwrap_or(end_ms).clamp(start_ms, end_ms);
                dead += (de - ds).max(0);
                for (d, slot) in dead_bins.iter_mut().enumerate() {
                    let d0 = start_ms as f64 + d as f64 * decile_ms;
                    let d1 = d0 + decile_ms;
                    let overlap = (de as f64).min(d1) - (ds as f64).max(d0);
                    if overlap > 0.0 && decile_ms > 0.0 {
                        *slot = (*slot + overlap / decile_ms).min(1.0);
                    }
                }
            }
            let alive_ms = (dur - dead).max(0);

            // Active/idle slot bitmap -> total + per-decile fractions.
            let slots = model.active_slots(&a.casts, start_ms, end_ms);
            let active_ms = active_ms(&slots).clamp(0, alive_ms);
            let mut active_bins = [0f64; DECILES];
            let mut bin_secs = [0f64; DECILES];
            for (i, &on) in slots.iter().enumerate() {
                let t = start_ms + i as i64 * BIN_MS;
                let d = (((t - start_ms) * DECILES as i64) / dur).clamp(0, DECILES as i64 - 1) as usize;
                bin_secs[d] += 1.0;
                if on {
                    active_bins[d] += 1.0;
                }
            }
            for (frac, total) in active_bins.iter_mut().zip(bin_secs) {
                if total > 0.0 {
                    *frac /= total;
                }
            }

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
                active_bins,
                dead_bins,
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

    fn aps_ms(casts: &[CastEvent], start: i64, end: i64) -> i64 {
        active_ms(&ApsActivityModel.active_slots(casts, start, end))
    }

    #[test]
    fn aps_counts_cast_slots_not_gaps() {
        // 1.5s slots. window 0..12s. START 0.5 + SUCCESS 1.0 -> slot 0.
        // A lone SUCCESS (instant, or an unresolvable channel start) at
        // 6.0 -> slot 4 [6.0-7.5). The idle slots in between don't count.
        // Active: slots {0,4} = 2 * 1.5s = 3s.
        let casts = [
            ev(500, CastEventKind::Start),
            ev(1_000, CastEventKind::Success),
            ev(6_000, CastEventKind::Success),
        ];
        assert_eq!(aps_ms(&casts, 0, 12_000), 3_000);
    }

    #[test]
    fn aps_marks_the_span_between_start_and_success() {
        // A 3.5s cast: START 0.5 -> SUCCESS 4.0 spans slots 0,1,2 = 4.5s.
        let casts = [ev(500, CastEventKind::Start), ev(4_000, CastEventKind::Success)];
        assert_eq!(aps_ms(&casts, 0, 12_000), 4_500);
    }

    #[test]
    fn aps_empower_span_is_active() {
        // EMPOWER 2.0 -> 5.0 spans slots 1,2,3 = 4.5s.
        let casts = [
            ev(2_000, CastEventKind::EmpowerStart),
            ev(5_000, CastEventKind::EmpowerEnd),
        ];
        assert_eq!(aps_ms(&casts, 0, 12_000), 4_500);
    }

    #[test]
    fn aps_empty_timeline_is_zero() {
        assert_eq!(aps_ms(&[], 0, 10_000), 0);
    }
}
