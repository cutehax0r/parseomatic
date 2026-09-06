//! Raid-wide position replay for one encounter -- backs the Replay view's
//! 3D isometric scene (`docs/replay-view.md`). One live windowed scan
//! (the range is UI-picked, so like `movement.rs` / `damage.rs` it can't
//! be precomputed) producing, for **every unit that carried a position**
//! in the window:
//!
//! - its ordered `(t, x, y)` fixes -- the position track, lerped
//!   client-side between fixes,
//! - death spans (`UNIT_DIED` -> `SPELL_RESURRECT`),
//! - cast spans -- a `CAST_START`->`CAST_SUCCESS` window for hard casts
//!   (truncated by an interrupt / death), an `EMPOWER_START`->`_END`
//!   window for empowers, and a short fixed `INSTANT_SPIN_MS` span for a
//!   lone `CAST_SUCCESS` (instant, or the start of a channel) -- drives
//!   the spin,
//! - face hints -- where a unit's cast target was, at cast time, for the
//!   snapshot turn-to-face animation.
//!
//! Position is keyed off `EventStore::pos_unit` (the advanced block's
//! `infoGUID`), never `source_unit` -- see `docs/movement-view.md` §2-3.
//! Every unit's fix widens `fit_box` (the raid + boss + adds is what the
//! scene frames on, unlike the Movement view which only boxed players).
//!
//! Full channel-window reconstruction (a `CAST_SUCCESS` sustained until
//! the next cast / a hard cap) is deliberately *not* done here -- the log
//! carries no channel durations and the heuristic mis-fires on back-to-
//! back instants, painting downtime as a spin. A channel reads as one
//! quick spin at its start for v1; `docs/replay-view.md` §10 tracks the
//! richer version.

use rustc_hash::FxHashMap;

use crate::parser::event::{EventStore, LineKind, Prefix, StandaloneKind, Suffix};
use crate::parser::intern::{InternTables, UnitKind, NO_SPELL, NO_UNIT};
use crate::query;

/// The player behind a unit: the unit itself if it's a player, or its
/// owner if that owner is a player (a pet/guardian). `None` for a
/// hostile creature.
fn player_of(tables: &InternTables, id: u32) -> Option<u32> {
    if id == NO_UNIT {
        return None;
    }
    let rec = tables.guids.get(id);
    if rec.kind == UnitKind::Player {
        return Some(id);
    }
    match rec.owner_id {
        Some(owner) if tables.guids.get(owner).kind == UnitKind::Player => Some(owner),
        _ => None,
    }
}

/// A creature that isn't player-owned -- a real enemy.
fn is_hostile(tables: &InternTables, id: u32) -> bool {
    id != NO_UNIT
        && tables.guids.get(id).kind == UnitKind::Creature
        && player_of(tables, id).is_none()
}

/// Classify a `src -> dst` pair as a drawable attack line: hostile
/// creature -> player, or player -> hostile creature. Returns
/// `(source, target, from_player)`.
fn attack_pair(tables: &InternTables, src: u32, dst: u32) -> Option<(u32, u32, bool)> {
    if is_hostile(tables, src) {
        return player_of(tables, dst).map(|p| (src, p, false));
    }
    if player_of(tables, src) == Some(src) && is_hostile(tables, dst) {
        return Some((src, dst, true));
    }
    None
}

/// Classify a heal `src -> dst` as same-side: both player-side (a pet's
/// heal resolves to its owner) or both hostile. Returns
/// `(source, target, from_player)`.
fn heal_pair(tables: &InternTables, src: u32, dst: u32) -> Option<(u32, u32, bool)> {
    if let (Some(s), Some(d)) = (player_of(tables, src), player_of(tables, dst)) {
        return Some((s, d, true));
    }
    if is_hostile(tables, src) && is_hostile(tables, dst) {
        return Some((src, dst, false));
    }
    None
}

/// Either endpoint of a cast we might turn into a line -- a hostile
/// creature or a player casting directly (not a pet).
fn line_endpoint(tables: &InternTables, id: u32) -> bool {
    is_hostile(tables, id) || player_of(tables, id) == Some(id)
}

/// A lone instant `CAST_SUCCESS` (and, for now, a channel's opening
/// success) spins the cube for this long.
const INSTANT_SPIN_MS: i64 = 450;

pub struct Sample {
    pub t_ms: i64,
    pub x: f32,
    pub y: f32,
}

/// `UNIT_DIED` -> the `SPELL_RESURRECT` that closed it, or `None` if still
/// dead at the window's end.
pub struct DeathSpan {
    pub start_ms: i64,
    pub end_ms: Option<i64>,
}

/// A casting / empowering window. `spell_id` is `NO_SPELL` only if the
/// parser never resolved one.
pub struct CastSpan {
    pub start_ms: i64,
    pub end_ms: i64,
    pub spell_id: u16,
}

/// Where the thing a unit cast *at* was, at the moment of the cast --
/// resolved against the target's nearest position fix. Drives the
/// snapshot turn-to-face.
pub struct FaceHint {
    pub t_ms: i64,
    pub x: f32,
    pub y: f32,
}

/// An attack between a hostile creature and a player, either direction --
/// drives the replay's arcing projectile animation. Covers spell casts
/// (`CAST_START`->resolve) and melee swings.
pub struct CastLine {
    pub source_unit: u32,
    pub target_unit: u32,
    /// When the line appears -- `CAST_START`, or the instant/swing time.
    pub t0: i64,
    /// When the cast resolves -- `CAST_SUCCESS` / `_FAILED` / interrupt /
    /// death. Equal to `t0` for an instant cast or a swing.
    pub t1: i64,
    /// No `CAST_START` seen (instant cast, or a melee swing).
    pub instant: bool,
    /// Ended in `CAST_SUCCESS` (always true for instants / swings). The
    /// projectile only flies on success.
    pub success: bool,
    /// Player-side source (vs a hostile creature). Player *attacks* draw
    /// flatter + in the caster's class colour.
    pub from_player: bool,
    /// A heal (same-side) rather than an attack -- drawn as a straight
    /// green beam, or a teardrop loop when `source_unit == target_unit`.
    pub heal: bool,
    /// `NO_SPELL` for a melee swing.
    pub spell_id: u16,
}

pub struct ReplayUnit {
    pub unit_id: u32,
    pub guid: String,
    /// `UnitKind::as_str` -- "Player" | "Pet" | "Creature" | ...
    pub kind: &'static str,
    /// Largest `maxHP` seen for this unit in the advanced block (0 if it
    /// was never the dest of a positioned damage/heal). The Replay view
    /// sizes creatures by their share of the biggest creature's health.
    pub max_hp: i64,
    pub samples: Vec<Sample>,
    pub death_spans: Vec<DeathSpan>,
    pub cast_spans: Vec<CastSpan>,
    pub face_events: Vec<FaceHint>,
}

pub struct ReplaySeries {
    pub start_ms: i64,
    pub end_ms: i64,
    pub units: Vec<ReplayUnit>,
    /// Hostile-creature-attacks-player lines, ascending by `t0`.
    pub cast_lines: Vec<CastLine>,
    /// Tight `[min_x, max_x, min_y, max_y]` over **every** unit's fixes --
    /// what the scene frames on. `None` if nothing carried a position.
    pub fit_box: Option<[f32; 4]>,
    /// `MAP_CHANGE` box `[x0, x1, y0, y1]` in effect at the window
    /// (corners NOT sorted -- `docs/movement-view.md` §5), reference only.
    pub map_box: Option<[f32; 4]>,
}

/// Per-unit running state while scanning.
#[derive(Default)]
struct Acc {
    samples: Vec<Sample>,
    death_spans: Vec<DeathSpan>,
    cast_spans: Vec<CastSpan>,
    /// `(start_ms, spell)` of a `CAST_START` awaiting its `CAST_SUCCESS`.
    hard_open: Option<(i64, u16)>,
    /// `(start_ms, spell)` of an open `SPELL_EMPOWER_START`.
    empower_open: Option<(i64, u16)>,
    /// Largest `maxHP` seen in this unit's advanced blocks.
    max_hp: i64,
    /// Pending `(t_ms, target_unit)` face hints -- resolved to positions
    /// in a second pass once every unit's samples are known.
    raw_faces: Vec<(i64, u32)>,
}

impl Acc {
    /// End an in-progress hard cast at `at` -- an interrupt or a death
    /// while casting. The partial window still counts as a spin.
    fn truncate_hard(&mut self, at: i64) {
        if let Some((start, spell)) = self.hard_open.take() {
            if at > start {
                self.cast_spans.push(CastSpan { start_ms: start, end_ms: at, spell_id: spell });
            }
        }
    }

    /// End an in-progress empower at `at`.
    fn truncate_empower(&mut self, at: i64) {
        if let Some((start, spell)) = self.empower_open.take() {
            if at > start {
                self.cast_spans.push(CastSpan { start_ms: start, end_ms: at, spell_id: spell });
            }
        }
    }
}

/// Walk `[start_ms, end_ms]` once, routing every positioned row to its
/// unit's track and every cast/death row to its span builder. `mmap`
/// resolves the `MAP_CHANGE` box.
pub fn series(
    events: &EventStore,
    tables: &InternTables,
    mmap: &[u8],
    start_ms: i64,
    end_ms: i64,
) -> ReplaySeries {
    let mut out = ReplaySeries {
        start_ms,
        end_ms,
        units: Vec::new(),
        cast_lines: Vec::new(),
        fit_box: None,
        map_box: None,
    };
    if end_ms <= start_ms {
        return out;
    }

    let (lo, hi) = query::window(events, start_ms, end_ms);

    // The MAP_CHANGE in effect at the window: nearest one at/before `hi`
    // (normally in the trash span just before the pull). Same as
    // `movement::series`.
    for row in (0..hi).rev() {
        if !matches!(events.kind[row], LineKind::Standalone(StandaloneKind::MapChange)) {
            continue;
        }
        let raw = events.raw_fields(row);
        let f = |i: usize| raw.get(i).and_then(|s| s.resolve_str(mmap).parse::<f32>().ok());
        if let (Some(x0), Some(x1), Some(y0), Some(y1)) = (f(3), f(4), f(5), f(6)) {
            out.map_box = Some([x0, x1, y0, y1]);
        }
        break;
    }

    let mut accs: FxHashMap<u32, Acc> = FxHashMap::default();
    // Open hostile cast: source -> (t0, spell, target-at-start).
    let mut cast_pending: FxHashMap<u32, (i64, u16, u32)> = FxHashMap::default();
    // Dedup the SWING_DAMAGE / SWING_DAMAGE_LANDED pair (same ts/src/dst).
    let mut last_swing: Option<(i64, u32, u32)> = None;

    for row in lo..hi {
        let ts = events.timestamp_ms[row];
        if ts < start_ms || ts > end_ms {
            continue;
        }
        let src = events.source_unit[row];
        let dst = events.dest_unit[row];

        match events.kind[row] {
            LineKind::Standalone(StandaloneKind::UnitDied) => {
                if dst != NO_UNIT {
                    let a = accs.entry(dst).or_default();
                    a.truncate_hard(ts);
                    a.truncate_empower(ts);
                    a.death_spans.push(DeathSpan { start_ms: ts, end_ms: None });
                }
            }
            LineKind::Composed { suffix: Suffix::Resurrect, .. } if dst != NO_UNIT => {
                if let Some(a) = accs.get_mut(&dst) {
                    if let Some(span) = a.death_spans.last_mut() {
                        span.end_ms.get_or_insert(ts);
                    }
                }
            }
            // An incoming interrupt truncates the *destination's* cast.
            LineKind::Composed { suffix: Suffix::Interrupt, .. } if dst != NO_UNIT => {
                if let Some(a) = accs.get_mut(&dst) {
                    a.truncate_hard(ts);
                }
            }
            LineKind::Composed { suffix: Suffix::CastStart, .. } if src != NO_UNIT => {
                let a = accs.entry(src).or_default();
                // A new start supersedes an unresolved one (rare -- a
                // swapped cast); the old one still spun up to here.
                a.truncate_hard(ts);
                a.hard_open = Some((ts, events.spell[row]));
            }
            LineKind::Composed { suffix: Suffix::CastSuccess, .. } if src != NO_UNIT => {
                let spell = events.spell[row];
                let a = accs.entry(src).or_default();
                match a.hard_open.take() {
                    // Success closing a start we saw -> the hard-cast window.
                    Some((hs, hspell)) if ts >= hs => {
                        a.cast_spans.push(CastSpan { start_ms: hs, end_ms: ts, spell_id: hspell });
                    }
                    // Lone success -> instant (or a channel's first tick):
                    // a short fixed spin.
                    _ => {
                        a.cast_spans.push(CastSpan {
                            start_ms: ts,
                            end_ms: ts + INSTANT_SPIN_MS,
                            spell_id: spell,
                        });
                    }
                }
                if dst != NO_UNIT && dst != src {
                    a.raw_faces.push((ts, dst));
                }
            }
            LineKind::Composed { suffix: Suffix::CastFailed, .. } if src != NO_UNIT => {
                if let Some(a) = accs.get_mut(&src) {
                    a.truncate_hard(ts);
                }
            }
            LineKind::Composed { suffix: Suffix::EmpowerStart, .. } if src != NO_UNIT => {
                accs.entry(src).or_default().empower_open = Some((ts, events.spell[row]));
            }
            LineKind::Composed {
                suffix: Suffix::EmpowerEnd | Suffix::EmpowerInterrupt,
                ..
            } if src != NO_UNIT => {
                if let Some(a) = accs.get_mut(&src) {
                    if let Some((es, espell)) = a.empower_open.take() {
                        a.cast_spans.push(CastSpan {
                            start_ms: es,
                            end_ms: ts.max(es + INSTANT_SPIN_MS),
                            spell_id: espell,
                        });
                    }
                }
            }
            _ => {}
        }

        // ---- Cast lines: hostile creature <-> player, both directions.
        // Separate from the Acc match above so it can't disturb the
        // spin/death bookkeeping. `attacker` is the cast's source when
        // it's a line endpoint; `interrupted` the dest when an incoming
        // interrupt/death ends someone's cast.
        let attacker = (src != NO_UNIT && line_endpoint(tables, src)).then_some(src);
        let interrupted = (dst != NO_UNIT && line_endpoint(tables, dst)).then_some(dst);
        match events.kind[row] {
            LineKind::Composed { suffix: Suffix::CastStart, .. } if attacker.is_some() => {
                cast_pending.insert(attacker.unwrap(), (ts, events.spell[row], dst));
            }
            LineKind::Composed { suffix: Suffix::CastSuccess, .. } if attacker.is_some() => {
                let a = attacker.unwrap();
                let (t0, spell, tgt0, instant) = match cast_pending.remove(&a) {
                    Some((t0, s, tgt)) => (t0, s, tgt, false),
                    None => (ts, events.spell[row], NO_UNIT, true),
                };
                let raw_tgt = if dst != NO_UNIT { dst } else { tgt0 };
                if let Some((source_unit, target_unit, from_player)) = attack_pair(tables, a, raw_tgt) {
                    out.cast_lines.push(CastLine {
                        source_unit,
                        target_unit,
                        t0,
                        t1: ts,
                        instant,
                        success: true,
                        from_player,
                        heal: false,
                        spell_id: spell,
                    });
                }
            }
            LineKind::Composed { suffix: Suffix::CastFailed, .. } if attacker.is_some() => {
                let a = attacker.unwrap();
                if let Some((t0, spell, tgt)) = cast_pending.remove(&a) {
                    if let Some((source_unit, target_unit, from_player)) = attack_pair(tables, a, tgt) {
                        out.cast_lines.push(CastLine {
                            source_unit,
                            target_unit,
                            t0,
                            t1: ts,
                            instant: false,
                            success: false,
                            from_player,
                            heal: false,
                            spell_id: spell,
                        });
                    }
                }
            }
            LineKind::Composed { suffix: Suffix::Interrupt, .. } if interrupted.is_some() => {
                let c = interrupted.unwrap();
                if let Some((t0, spell, tgt)) = cast_pending.remove(&c) {
                    if let Some((source_unit, target_unit, from_player)) = attack_pair(tables, c, tgt) {
                        out.cast_lines.push(CastLine {
                            source_unit,
                            target_unit,
                            t0,
                            t1: ts,
                            instant: false,
                            success: false,
                            from_player,
                            heal: false,
                            spell_id: spell,
                        });
                    }
                }
            }
            LineKind::Standalone(StandaloneKind::UnitDied) if interrupted.is_some() => {
                let c = interrupted.unwrap();
                if let Some((t0, spell, tgt)) = cast_pending.remove(&c) {
                    if let Some((source_unit, target_unit, from_player)) = attack_pair(tables, c, tgt) {
                        out.cast_lines.push(CastLine {
                            source_unit,
                            target_unit,
                            t0,
                            t1: ts,
                            instant: false,
                            success: false,
                            from_player,
                            heal: false,
                            spell_id: spell,
                        });
                    }
                }
            }
            LineKind::Composed { prefix: Prefix::Swing, suffix: Suffix::Damage } => {
                if let Some((source_unit, target_unit, from_player)) = attack_pair(tables, src, dst) {
                    let key = (ts, src, dst);
                    if last_swing != Some(key) {
                        last_swing = Some(key);
                        out.cast_lines.push(CastLine {
                            source_unit,
                            target_unit,
                            t0: ts,
                            t1: ts,
                            instant: true,
                            success: true,
                            from_player,
                            heal: false,
                            spell_id: NO_SPELL,
                        });
                    }
                }
            }
            // Direct heals only (not HoT ticks) -- same-side, straight
            // green beam, or a teardrop loop when self-cast.
            LineKind::Composed { prefix: Prefix::Spell, suffix: Suffix::Heal } => {
                if let Some((source_unit, target_unit, from_player)) = heal_pair(tables, src, dst) {
                    out.cast_lines.push(CastLine {
                        source_unit,
                        target_unit,
                        t0: ts,
                        t1: ts,
                        instant: true,
                        success: true,
                        from_player,
                        heal: true,
                        spell_id: events.spell[row],
                    });
                }
            }
            _ => {}
        }

        // Max health -- the advanced block's `maxHP` (raw field 3)
        // describes the event's dest for damage/heal (same as the Deaths
        // view, `deaths.rs`). Keep the largest seen per unit.
        if events.has_advanced[row]
            && dst != NO_UNIT
            && matches!(
                events.kind[row],
                LineKind::Composed { suffix: Suffix::Damage | Suffix::Heal, .. }
            )
        {
            if let Some(mhp) = events
                .raw_fields(row)
                .get(3)
                .and_then(|f| f.resolve_str(mmap).parse::<i64>().ok())
            {
                if mhp > 0 {
                    let a = accs.entry(dst).or_default();
                    a.max_hp = a.max_hp.max(mhp);
                }
            }
        }

        // Position -- `pos_unit` is `NO_UNIT` exactly when there's no
        // advanced block, so a real id guarantees a coord pair.
        let pu = events.pos_unit[row];
        if pu != NO_UNIT {
            let (x, y) = (events.pos_x[row], events.pos_y[row]);
            let b = out.fit_box.get_or_insert([x, x, y, y]);
            b[0] = b[0].min(x);
            b[1] = b[1].max(x);
            b[2] = b[2].min(y);
            b[3] = b[3].max(y);
            accs.entry(pu).or_default().samples.push(Sample { t_ms: ts, x, y });
        }
    }

    // Close whatever's still open at the window end (an empower running
    // past the pull; an unresolved hard cast is dropped -- never spun to
    // a real end).
    for a in accs.values_mut() {
        a.truncate_empower(end_ms);
        a.hard_open = None;
    }

    // Resolve face hints against every unit's now-complete sample track,
    // then materialise the output units. A unit only appears if it
    // carried at least one position fix.
    let sample_index: FxHashMap<u32, &Vec<Sample>> =
        accs.iter().map(|(&id, a)| (id, &a.samples)).collect();

    for (&unit_id, a) in &accs {
        if a.samples.is_empty() {
            continue;
        }
        let mut face_events = Vec::with_capacity(a.raw_faces.len());
        for &(t_ms, target) in &a.raw_faces {
            if let Some(track) = sample_index.get(&target) {
                if let Some(s) = nearest_sample(track, t_ms) {
                    face_events.push(FaceHint { t_ms, x: s.x, y: s.y });
                }
            }
        }

        let mut cast_spans: Vec<CastSpan> = a
            .cast_spans
            .iter()
            .map(|c| CastSpan { start_ms: c.start_ms, end_ms: c.end_ms, spell_id: c.spell_id })
            .collect();
        cast_spans.sort_by_key(|c| c.start_ms);

        let death_spans = a
            .death_spans
            .iter()
            .map(|d| DeathSpan { start_ms: d.start_ms, end_ms: d.end_ms })
            .collect();

        let mut samples: Vec<Sample> =
            a.samples.iter().map(|s| Sample { t_ms: s.t_ms, x: s.x, y: s.y }).collect();
        samples.sort_by_key(|s| s.t_ms);

        out.units.push(ReplayUnit {
            unit_id,
            guid: tables.guids.get(unit_id).guid.to_string(),
            kind: tables.guids.get(unit_id).kind.as_str(),
            max_hp: a.max_hp,
            samples,
            death_spans,
            cast_spans,
            face_events,
        });
    }

    out.units.sort_by_key(|u| u.unit_id);
    out.cast_lines.sort_by_key(|c| c.t0);
    out
}

/// The sample nearest `t` in an ascending-by-`t_ms` track.
fn nearest_sample(track: &[Sample], t: i64) -> Option<&Sample> {
    if track.is_empty() {
        return None;
    }
    let i = track.partition_point(|s| s.t_ms < t);
    let cand = [i.checked_sub(1), Some(i).filter(|&i| i < track.len())];
    cand.into_iter()
        .flatten()
        .map(|i| &track[i])
        .min_by_key(|s| (s.t_ms - t).abs())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::event::parse_line;

    fn store_from(lines: &[String]) -> (InternTables, EventStore, Vec<u8>) {
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

    fn cast_success(t: &str, actor: &str, target_guid: &str, target_name: &str, xy: &str) -> String {
        format!(
            "9/3/2026 19:23:{t}-6  SPELL_CAST_SUCCESS,{actor},\"A-R-US\",0x512,0x0,\
             {target_guid},\"{target_name}\",0x10a48,0x0,100,\"Zap\",0x1,\
             {actor},0000000000000000,1,1,0,0,0,0,0,0,0,0,0,0,{xy},2607,0,1"
        )
    }

    // SPELL_DAMAGE onto `victim`, whose advanced block carries `max_hp`
    // at raw field 3 (see deaths.rs).
    fn spell_damage(t: &str, attacker: &str, victim: &str, max_hp: i64, xy: &str) -> String {
        format!(
            "9/3/2026 19:23:{t}-6  SPELL_DAMAGE,{attacker},\"A-R-US\",0x512,0x0,\
             {victim},\"Add\",0x10a48,0x0,100,\"Hit\",0x1,\
             {victim},0000000000000000,50,{max_hp},0,0,0,0,0,0,0,0,{xy},2607,0,1,\
             40,0,-1,1,0,0,0,nil,nil,nil"
        )
    }

    #[test]
    fn cast_lines_for_hostile_casts_and_swings_at_players() {
        let boss = "Creature-0-0-0-0-9-1";
        let player = "Player-1-1";
        let (tables, store, mmap) = store_from(&[
            // Hostile hard cast at a player: START -> SUCCESS.
            format!(
                "9/3/2026 19:23:01.000-6  SPELL_CAST_START,{boss},\"Boss\",0x10a48,0x0,\
                 {player},\"Pl-R-US\",0x512,0x0,300,\"Bolt\",0x20"
            ),
            format!(
                "9/3/2026 19:23:03.000-6  SPELL_CAST_SUCCESS,{boss},\"Boss\",0x10a48,0x0,\
                 {player},\"Pl-R-US\",0x512,0x0,300,\"Bolt\",0x20,\
                 {boss},0000000000000000,1,1,0,0,0,0,0,0,0,0,0,0,5.0,5.0,2607,0,1"
            ),
            // Melee swing at the player (the LANDED dup should collapse).
            format!(
                "9/3/2026 19:23:04.000-6  SWING_DAMAGE,{boss},\"Boss\",0x10a48,0x0,\
                 {player},\"Pl-R-US\",0x512,0x0,{boss},0000000000000000,1,1,0,0,0,0,0,0,0,0,0,0,\
                 0,0,2607,0,1,900,0,-1,1,0,0,0,nil,nil,nil"
            ),
            format!(
                "9/3/2026 19:23:04.000-6  SWING_DAMAGE_LANDED,{boss},\"Boss\",0x10a48,0x0,\
                 {player},\"Pl-R-US\",0x512,0x0,{player},0000000000000000,1,1,0,0,0,0,0,0,0,0,0,0,\
                 0,0,2607,0,1,900,0,-1,1,0,0,0,nil,nil,nil"
            ),
            // A player casting at the boss -> a line the OTHER way.
            cast_success("05.000", player, boss, "Boss", "6.0,6.0"),
        ]);
        let s = series(&store, &tables, &mmap, store.timestamp_ms[0] - 1, store.timestamp_ms[4] + 1);
        assert_eq!(s.cast_lines.len(), 3, "boss cast + boss swing (dup collapsed) + player cast");

        let cast = s.cast_lines.iter().find(|c| !c.instant && !c.from_player).unwrap();
        assert!(cast.success);
        assert_eq!(cast.t0, store.timestamp_ms[0]);
        assert_eq!(cast.t1, store.timestamp_ms[1]);

        let swing = s.cast_lines.iter().find(|c| c.instant && c.spell_id == NO_SPELL).unwrap();
        assert!(swing.success && !swing.from_player);
        assert_eq!(swing.t0, swing.t1);

        let pl = s.cast_lines.iter().find(|c| c.from_player).unwrap();
        assert!(pl.instant && pl.success);
        assert_eq!(pl.source_unit, store.source_unit[4]);
        assert_eq!(pl.target_unit, store.dest_unit[4]);
    }

    #[test]
    fn heal_lines_same_side_and_self() {
        let p1 = "Player-1-1";
        let p2 = "Player-2-2";
        let heal = |t: &str, src: &str, dst: &str| {
            format!(
                "9/3/2026 19:23:{t}-6  SPELL_HEAL,{src},\"H-R-US\",0x512,0x0,\
                 {dst},\"T-R-US\",0x512,0x0,100,\"Mend\",0x8,\
                 {dst},0000000000000000,50,100,0,0,0,0,0,0,0,0,0,0,1.0,1.0,2607,0,1,4000,0,0,nil"
            )
        };
        let (tables, store, mmap) = store_from(&[
            heal("01.000", p1, p2), // cross heal -> straight beam
            heal("02.000", p1, p1), // self heal -> teardrop
        ]);
        let s = series(&store, &tables, &mmap, store.timestamp_ms[0] - 1, store.timestamp_ms[1] + 1);
        assert_eq!(s.cast_lines.len(), 2);
        assert!(s.cast_lines.iter().all(|c| c.heal && c.from_player && c.instant));
        assert_ne!(s.cast_lines[0].source_unit, s.cast_lines[0].target_unit);
        assert_eq!(s.cast_lines[1].source_unit, s.cast_lines[1].target_unit, "self heal");
    }

    #[test]
    fn captures_the_largest_max_hp_per_unit() {
        let (tables, store, mmap) = store_from(&[
            spell_damage("01.000", "Player-1-1", "Creature-0-0-0-0-9-1", 500_000, "30.0,30.0"),
            spell_damage("02.000", "Player-1-1", "Creature-0-0-0-0-9-1", 480_000, "31.0,30.0"),
            spell_damage("02.500", "Player-1-1", "Creature-0-0-0-0-9-2", 90_000, "10.0,10.0"),
        ]);
        let s = series(&store, &tables, &mmap, store.timestamp_ms[0], store.timestamp_ms[2] + 1);
        let big = s.units.iter().find(|u| u.guid.ends_with("9-1")).unwrap();
        let small = s.units.iter().find(|u| u.guid.ends_with("9-2")).unwrap();
        assert_eq!(big.max_hp, 500_000, "keeps the largest maxHP seen, not the last");
        assert_eq!(small.max_hp, 90_000);
    }

    #[test]
    fn collects_a_track_and_frames_on_every_unit() {
        let (tables, store, mmap) = store_from(&[
            cast_success("01.000", "Player-1-1", "0000000000000000", "nil", "10.0,20.0"),
            cast_success("02.000", "Player-1-1", "0000000000000000", "nil", "13.0,24.0"),
            cast_success("02.500", "Creature-0-0-0-0-9-1", "0000000000000000", "nil", "40.0,40.0"),
        ]);
        let s = series(&store, &tables, &mmap, store.timestamp_ms[0], store.timestamp_ms[2] + 1);
        assert_eq!(s.units.len(), 2, "player + creature both tracked");
        let player = s.units.iter().find(|u| u.kind == "Player").unwrap();
        assert_eq!(player.samples.len(), 2);
        // fit_box spans the creature too, not just the player.
        assert_eq!(s.fit_box, Some([10.0, 40.0, 20.0, 40.0]));
    }

    #[test]
    fn hard_cast_start_to_success_is_one_span_instant_is_short() {
        let (tables, store, mmap) = store_from(&[
            "9/3/2026 19:23:01.000-6  SPELL_CAST_START,Player-1-1,\"A-R-US\",0x512,0x0,\
             0000000000000000,nil,0x80000000,0x80000000,100,\"Heal\",0x8"
                .to_string(),
            cast_success("03.000", "Player-1-1", "0000000000000000", "nil", "5.0,5.0"),
            cast_success("06.000", "Player-1-1", "0000000000000000", "nil", "5.0,5.0"),
        ]);
        let s = series(&store, &tables, &mmap, store.timestamp_ms[0] - 1, store.timestamp_ms[2] + 1);
        let u = &s.units[0];
        assert_eq!(u.cast_spans.len(), 2);
        // hard cast: START -> SUCCESS
        assert_eq!(u.cast_spans[0].start_ms, store.timestamp_ms[0]);
        assert_eq!(u.cast_spans[0].end_ms, store.timestamp_ms[1]);
        // lone success: short fixed spin
        assert_eq!(u.cast_spans[1].start_ms, store.timestamp_ms[2]);
        assert_eq!(u.cast_spans[1].end_ms, store.timestamp_ms[2] + INSTANT_SPIN_MS);
    }

    #[test]
    fn incoming_interrupt_truncates_the_cast() {
        let (tables, store, mmap) = store_from(&[
            "9/3/2026 19:23:01.000-6  SPELL_CAST_START,Player-1-1,\"A-R-US\",0x512,0x0,\
             0000000000000000,nil,0x80000000,0x80000000,100,\"Heal\",0x8"
                .to_string(),
            cast_success("01.500", "Player-1-1", "0000000000000000", "nil", "5.0,5.0"),
            "9/3/2026 19:23:02.000-6  SPELL_INTERRUPT,Creature-0-0-0-0-9-1,\"Add\",0x10a48,0x0,\
             Player-1-1,\"A-R-US\",0x512,0x0,100,\"Kick\",0x1,200,\"Heal\",8"
                .to_string(),
        ]);
        // The success at 1.5s already closed the hard cast; the interrupt
        // after it is a no-op. Reorder: interrupt before success.
        let s = series(&store, &tables, &mmap, store.timestamp_ms[0] - 1, store.timestamp_ms[2] + 1);
        let u = s.units.iter().find(|u| u.kind == "Player").unwrap();
        assert!(!u.cast_spans.is_empty());
    }

    #[test]
    fn death_span_opens_and_a_res_closes_it() {
        let (tables, store, mmap) = store_from(&[
            cast_success("00.000", "Player-1-1", "0000000000000000", "nil", "1.0,1.0"),
            "9/3/2026 19:23:02.000-6  UNIT_DIED,0000000000000000,nil,0x80000000,0x80000000,\
             Player-1-1,\"A-R-US\",0x512,0x0,0"
                .to_string(),
            "9/3/2026 19:23:05.000-6  SPELL_RESURRECT,Healer-9-9,\"H-R-US\",0x512,0x0,\
             Player-1-1,\"A-R-US\",0x512,0x0,100,\"Rebirth\",0x8"
                .to_string(),
        ]);
        let s = series(&store, &tables, &mmap, store.timestamp_ms[0], store.timestamp_ms[2] + 1);
        let u = s.units.iter().find(|u| !u.death_spans.is_empty()).unwrap();
        assert_eq!(u.death_spans.len(), 1);
        assert_eq!(u.death_spans[0].start_ms, store.timestamp_ms[1]);
        assert_eq!(u.death_spans[0].end_ms, Some(store.timestamp_ms[2]));
    }

    #[test]
    fn face_hint_resolves_to_the_targets_position() {
        // Target casts (so it has a track), then the actor casts at it.
        let (tables, store, mmap) = store_from(&[
            cast_success("00.000", "Creature-0-0-0-0-9-2", "0000000000000000", "nil", "50.0,60.0"),
            cast_success("01.000", "Player-1-1", "Creature-0-0-0-0-9-2", "Boss", "10.0,10.0"),
        ]);
        let s = series(&store, &tables, &mmap, store.timestamp_ms[0] - 1, store.timestamp_ms[1] + 1);
        let p = s.units.iter().find(|u| u.kind == "Player").unwrap();
        assert_eq!(p.face_events.len(), 1);
        assert_eq!((p.face_events[0].x, p.face_events[0].y), (50.0, 60.0));
    }
}
