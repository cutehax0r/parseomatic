//! Per-player activity timeline for one UI-picked window -- backs the
//! Timeline view (`src/views/timeline.ts`). One live windowed scan (the
//! range comes from the UI, so like `movement.rs` / `damage.rs` it can't
//! be precomputed), one pass over `[start_ms, end_ms]` producing three
//! streams the frontend lays out as stacked lanes:
//!
//! - **instants** -- the player's damage/heal events (no real duration;
//!   the view draws each at ~1.5s or a min sliver). Direction + the
//!   same-ms `SWING_DAMAGE` / `SWING_DAMAGE_LANDED` dedup are the shared
//!   `hits::HitScanner`, the same one `movement::events` uses.
//! - **auras** -- `SPELL_AURA_APPLIED` .. `SPELL_AURA_REMOVED` spans on
//!   the player, split buff vs debuff off the `auraType` field. These are
//!   the lanes with genuine width.
//! - **deaths** -- `UNIT_DIED` .. `SPELL_RESURRECT`, same as
//!   `movement::series`, drawn as rules across every lane.
//! - **samples** -- the player's own `(t, x, y)` fixes, so the view's
//!   Movement lane needs no separate `movement_series` round trip.

use std::collections::HashMap;

use crate::hits::HitScanner;
use crate::movement::{DeathSpan, Sample};
use crate::parser::event::{EventStore, LineKind, StandaloneKind, Suffix};
use crate::parser::intern::NO_UNIT;

/// One instantaneous damage/heal event involving the player.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum InstKind {
    /// Damage the player dealt.
    DmgOut,
    /// Damage the player took.
    DmgIn,
    /// Healing the player did.
    HealOut,
    /// Healing the player received.
    HealIn,
}

impl InstKind {
    pub fn as_str(self) -> &'static str {
        match self {
            InstKind::DmgOut => "dmgOut",
            InstKind::DmgIn => "dmgIn",
            InstKind::HealOut => "healOut",
            InstKind::HealIn => "healIn",
        }
    }
}

pub struct Instant {
    pub t_ms: i64,
    pub kind: InstKind,
    /// Intern id, or `NO_SPELL` for a melee swing.
    pub spell_id: u16,
    pub amount: i64,
    /// Target for `*Out`, source (attacker/healer) for `*In`; `NO_UNIT` if
    /// unset.
    pub other_unit: u32,
    /// `SPELL_PERIODIC_*` -- a DoT / HoT tick rather than a direct hit.
    pub periodic: bool,
    /// The player's own position at that row (`pos_unit == unit_id`), or
    /// `NaN` when the row carried someone else's coords / none.
    pub x: f32,
    pub y: f32,
}

/// One aura on the player: `AURA_APPLIED`/`AURA_REFRESH` .. `AURA_REMOVED`.
pub struct AuraSpan {
    pub spell_id: u16,
    pub start_ms: i64,
    /// `None` = still active at the window's end.
    pub end_ms: Option<i64>,
    /// `auraType == "DEBUFF"`.
    pub is_debuff: bool,
    /// Who applied it, or `NO_UNIT`.
    pub source_unit: u32,
    /// Highest stack count seen over the span (`_DOSE` events); 1 for a
    /// non-stacking aura.
    pub max_stacks: u32,
}

pub struct TimelineSeries {
    pub start_ms: i64,
    pub end_ms: i64,
    pub instants: Vec<Instant>,
    pub auras: Vec<AuraSpan>,
    pub deaths: Vec<DeathSpan>,
    /// The player's own `(t, x, y)` fixes in the window, chronological --
    /// feeds the view's Movement lane (no `movement_series` fetch needed).
    pub samples: Vec<Sample>,
}

/// Walk `[start_ms, end_ms]` once, classifying every row that involves
/// `unit_id` into an instant, an aura-span edge, or a death-span edge.
/// `mmap` resolves the raw `auraType` field. `None`-empty result for
/// `NO_UNIT` / an inverted window.
pub fn series(
    events: &EventStore,
    mmap: &[u8],
    unit_id: u32,
    start_ms: i64,
    end_ms: i64,
) -> TimelineSeries {
    if unit_id == NO_UNIT || end_ms <= start_ms {
        return TimelineSeries {
            start_ms,
            end_ms,
            instants: Vec::new(),
            auras: Vec::new(),
            deaths: Vec::new(),
            samples: Vec::new(),
        };
    }

    let (lo, hi) = crate::query::window(events, start_ms, end_ms);
    let mut out = TimelineSeries {
        start_ms,
        end_ms,
        // Rough headroom -- a heavy pull is thousands of instants.
        instants: Vec::with_capacity(hi.saturating_sub(lo) / 16),
        auras: Vec::with_capacity(64),
        deaths: Vec::new(),
        samples: Vec::with_capacity(hi.saturating_sub(lo) / 16),
    };

    // Damage/heal direction + the SWING_DAMAGE / SWING_DAMAGE_LANDED
    // dedup -- shared with `movement::events` so they never drift.
    let mut scan = HitScanner::default();
    // spell_id -> index of its currently-open span in `out.auras`, so
    // applied/removed/dose lookups stay O(1) instead of rescanning every
    // span accumulated over the window. Matches the old spell_id-only
    // match (a second caster's application still folds onto the one span).
    let mut open: HashMap<u16, usize> = HashMap::new();

    for row in lo..hi {
        let ts = events.timestamp_ms[row];
        if ts < start_ms || ts > end_ms {
            continue;
        }
        let src = events.source_unit[row];
        let dst = events.dest_unit[row];

        // The player's own position fixes (same rule as `movement::series`
        // -- `pos_unit` is `NO_UNIT` exactly when the row has no coords).
        if events.pos_unit[row] == unit_id {
            out.samples.push(Sample { t_ms: ts, x: events.pos_x[row], y: events.pos_y[row] });
        }

        // --- deaths -------------------------------------------------------
        if let LineKind::Standalone(StandaloneKind::UnitDied) = events.kind[row] {
            if dst == unit_id {
                out.deaths.push(DeathSpan { start_ms: ts, end_ms: None });
            }
            continue;
        }

        match events.kind[row] {
            // --- aura span edges ----------------------------------------
            LineKind::Composed {
                suffix: Suffix::AuraApplied | Suffix::AuraRefresh,
                ..
            } if dst == unit_id => {
                let spell = events.spell[row];
                if !open.contains_key(&spell) {
                    // `raw_fields` for a composed aura row is just the
                    // leftover suffix params -- `[auraType]`, plus an
                    // amount for absorb auras. The subevent name is NOT
                    // kept here (unlike standalone rows). See
                    // `event.rs`'s `stackless_aura_applied_has_no_amount_field`.
                    let raw = events.raw_fields(row);
                    let is_debuff = raw.iter().any(|f| f.resolve_str(mmap) == "DEBUFF");
                    // An initial stack count if present -- but `_APPLIED`'s
                    // optional trailing number is the *absorb* amount for
                    // shields, so only believe small values.
                    let init_stacks = raw
                        .iter()
                        .find_map(|f| f.resolve_str(mmap).parse::<u32>().ok())
                        .filter(|&n| (1..=999).contains(&n))
                        .unwrap_or(1);
                    open.insert(spell, out.auras.len());
                    out.auras.push(AuraSpan {
                        spell_id: spell,
                        start_ms: ts,
                        end_ms: None,
                        is_debuff,
                        source_unit: src,
                        max_stacks: init_stacks,
                    });
                }
            }
            // A stack change on an already-open aura: the dose count is
            // the first `raw_fields` entry that parses as an integer
            // (`auraType` never does). Track the peak.
            LineKind::Composed {
                suffix: Suffix::AuraAppliedDose | Suffix::AuraRemovedDose,
                ..
            } if dst == unit_id => {
                if let Some(&idx) = open.get(&events.spell[row]) {
                    if let Some(n) = events
                        .raw_fields(row)
                        .iter()
                        .find_map(|f| f.resolve_str(mmap).parse::<u32>().ok())
                    {
                        out.auras[idx].max_stacks = out.auras[idx].max_stacks.max(n);
                    }
                }
            }
            LineKind::Composed { suffix: Suffix::AuraRemoved, .. } if dst == unit_id => {
                if let Some(idx) = open.remove(&events.spell[row]) {
                    out.auras[idx].end_ms = Some(ts);
                }
            }

            // --- resurrect closes the newest open death span ------------
            LineKind::Composed { suffix: Suffix::Resurrect, .. } if dst == unit_id => {
                if let Some(span) = out.deaths.last_mut() {
                    span.end_ms.get_or_insert(ts);
                }
            }
            _ => {}
        }

        // --- instants (damage / heal) --------------------------------
        if let Some(h) = scan.classify(events, row, unit_id) {
            let kind = match (h.heal, h.done) {
                (false, true) => InstKind::DmgOut,
                (false, false) => InstKind::DmgIn,
                (true, true) => InstKind::HealOut,
                (true, false) => InstKind::HealIn,
            };
            // Only trust the row's coords when they describe the player.
            let (x, y) = if events.pos_unit[row] == unit_id {
                (events.pos_x[row], events.pos_y[row])
            } else {
                (f32::NAN, f32::NAN)
            };
            out.instants.push(Instant {
                t_ms: h.t_ms,
                kind,
                spell_id: h.spell_id,
                amount: h.amount,
                other_unit: h.other_unit,
                periodic: h.periodic,
                x,
                y,
            });
        }
    }

    out
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TimelineInstantRow {
    t_ms: i64,
    /// `dmgOut` | `dmgIn` | `healOut` | `healIn`.
    kind: &'static str,
    /// `None` for a melee swing.
    spell_id: Option<u16>,
    amount: i64,
    /// Target for `*Out`, source for `*In`; `None` if unset.
    other_unit: Option<u32>,
    /// `SPELL_PERIODIC_*` -- a DoT / HoT tick rather than a direct hit.
    periodic: bool,
    /// The player's own position at that moment; `None` when the row
    /// carried someone else's coords / none.
    x: Option<f32>,
    y: Option<f32>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuraSpanRow {
    spell_id: Option<u16>,
    start_ms: i64,
    /// `null` = still active at the window's end.
    end_ms: Option<i64>,
    is_debuff: bool,
    source_unit: Option<u32>,
    /// Peak stack count over the span; 1 for a non-stacking aura.
    max_stacks: u32,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TimelineSeriesRow {
    start_ms: i64,
    end_ms: i64,
    instants: Vec<TimelineInstantRow>,
    auras: Vec<AuraSpanRow>,
    /// The player's death intervals within the window (rules across every
    /// lane).
    deaths: Vec<crate::movement::MovementDeathSpanRow>,
    /// The player's own position fixes -- feeds the view's Movement lane
    /// so it needs no separate `movement_series` call.
    samples: Vec<crate::movement::MovementSampleRow>,
}

/// Per-player activity streams for `unit_id` over `[start_ms, end_ms]` --
/// backs the Timeline view (`src/views/timeline.ts`). One windowed scan;
/// `None` before parsing has finished. See `src/timeline.rs`.
#[tauri::command]
pub(crate) fn timeline_series(
    window: tauri::WebviewWindow,
    unit_id: u32,
    start_ms: i64,
    end_ms: i64,
) -> Option<TimelineSeriesRow> {
    use crate::movement::{MovementDeathSpanRow, MovementSampleRow};
    use crate::parser::intern::NO_SPELL;

    let log = crate::window::current_log(&window)?;
    let data = log.data()?;
    let s = series(&data.events, log.mmap_bytes(), unit_id, start_ms, end_ms);
    let finite = |v: f32| v.is_finite().then_some(v);
    Some(TimelineSeriesRow {
        start_ms: s.start_ms,
        end_ms: s.end_ms,
        instants: s
            .instants
            .into_iter()
            .map(|i| TimelineInstantRow {
                t_ms: i.t_ms,
                kind: i.kind.as_str(),
                spell_id: (i.spell_id != NO_SPELL).then_some(i.spell_id),
                amount: i.amount,
                other_unit: (i.other_unit != NO_UNIT).then_some(i.other_unit),
                periodic: i.periodic,
                x: finite(i.x),
                y: finite(i.y),
            })
            .collect(),
        auras: s
            .auras
            .into_iter()
            .map(|a| AuraSpanRow {
                spell_id: (a.spell_id != NO_SPELL).then_some(a.spell_id),
                start_ms: a.start_ms,
                end_ms: a.end_ms,
                is_debuff: a.is_debuff,
                source_unit: (a.source_unit != NO_UNIT).then_some(a.source_unit),
                max_stacks: a.max_stacks,
            })
            .collect(),
        deaths: s
            .deaths
            .into_iter()
            .map(|d| MovementDeathSpanRow { start_ms: d.start_ms, end_ms: d.end_ms })
            .collect(),
        samples: s
            .samples
            .into_iter()
            .map(|p| MovementSampleRow { t_ms: p.t_ms, x: p.x, y: p.y })
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::event::parse_line;
    use crate::parser::intern::InternTables;

    fn store_from(lines: &[&str]) -> (InternTables, EventStore, Vec<u8>) {
        // One shared buffer so raw-field spans stay resolvable.
        let mut text = String::new();
        for (i, rest) in lines.iter().enumerate() {
            text.push_str(&format!("9/3/2026 19:23:{:02}.000-6  {rest}\n", i));
        }
        let data = text.into_bytes();
        let mut tables = InternTables::default();
        let mut store = EventStore::default();
        let mut off = 0usize;
        for line in data.split(|&b| b == b'\n') {
            if !line.is_empty() {
                parse_line(&data, off, line, &mut tables, &mut store);
            }
            off += line.len() + 1;
        }
        (tables, store, data)
    }

    const AURA_BASE: &str =
        "Player-1-1,\"Mv-R-US\",0x512,0x0,Player-1-1,\"Mv-R-US\",0x512,0x0,";

    #[test]
    fn pairs_an_applied_removed_into_one_closed_span() {
        let (_t, store, data) = store_from(&[
            &format!("SPELL_AURA_APPLIED,{AURA_BASE}100,\"Shield\",0x1,BUFF"),
            &format!("SPELL_AURA_REMOVED,{AURA_BASE}100,\"Shield\",0x1,BUFF"),
        ]);
        let unit = store.dest_unit[0];
        let s = series(&store, &data, unit, store.timestamp_ms[0] - 1, store.timestamp_ms[1] + 1);
        assert_eq!(s.auras.len(), 1);
        assert_eq!(s.auras[0].start_ms, store.timestamp_ms[0]);
        assert_eq!(s.auras[0].end_ms, Some(store.timestamp_ms[1]));
        assert!(!s.auras[0].is_debuff);
    }

    #[test]
    fn an_unclosed_apply_stays_open() {
        let (_t, store, data) = store_from(&[
            &format!("SPELL_AURA_APPLIED,{AURA_BASE}200,\"Poison\",0x8,DEBUFF"),
        ]);
        let unit = store.dest_unit[0];
        let s = series(&store, &data, unit, store.timestamp_ms[0] - 1, store.timestamp_ms[0] + 1);
        assert_eq!(s.auras.len(), 1);
        assert_eq!(s.auras[0].end_ms, None);
        assert!(s.auras[0].is_debuff);
        assert_eq!(s.auras[0].max_stacks, 1);
    }

    #[test]
    fn tracks_peak_stacks_from_dose_events() {
        let (_t, store, data) = store_from(&[
            &format!("SPELL_AURA_APPLIED,{AURA_BASE}300,\"Stackable\",0x1,DEBUFF"),
            &format!("SPELL_AURA_APPLIED_DOSE,{AURA_BASE}300,\"Stackable\",0x1,DEBUFF,3"),
            &format!("SPELL_AURA_APPLIED_DOSE,{AURA_BASE}300,\"Stackable\",0x1,DEBUFF,5"),
            &format!("SPELL_AURA_REMOVED_DOSE,{AURA_BASE}300,\"Stackable\",0x1,DEBUFF,4"),
            &format!("SPELL_AURA_REMOVED,{AURA_BASE}300,\"Stackable\",0x1,DEBUFF"),
        ]);
        let unit = store.dest_unit[0];
        let s = series(&store, &data, unit, store.timestamp_ms[0] - 1, store.timestamp_ms[4] + 1);
        assert_eq!(s.auras.len(), 1);
        assert_eq!(s.auras[0].max_stacks, 5);
        assert_eq!(s.auras[0].end_ms, Some(store.timestamp_ms[4]));
    }

    #[test]
    fn classifies_instants_by_direction_and_dedups_the_swing_pair() {
        let lines = [
            "9/3/2026 19:23:00.000-6  SPELL_DAMAGE,Player-1-1,\"Mv-R-US\",0x512,0x0,Creature-0-0-0-0-1-0,\"Boss\",0x10a48,0x0,100,\"Zap\",0x1,Creature-0-0-0-0-1-0,0000000000000000,1,1,0,0,0,0,0,0,0,0,0,0,0,0,2607,0,93,900,0,-1,1,0,0,0,nil,nil,ST",
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
        let s = series(&store, &data, unit, store.timestamp_ms[0] - 1, store.timestamp_ms[2] + 1);
        let kinds: Vec<_> = s.instants.iter().map(|i| i.kind.as_str()).collect();
        assert_eq!(kinds, vec!["dmgOut", "dmgIn"]);
        assert_eq!(s.instants[0].amount, 900);
        assert_eq!(s.instants[1].amount, 500);
    }

    #[test]
    fn collects_the_players_own_position_fixes() {
        // A cast-success row: `infoGUID` is the source, so the coords are
        // the caster's own -- one sample. An outgoing SPELL_DAMAGE carries
        // the target's coords -- no sample.
        let cast = "SPELL_CAST_SUCCESS,Player-1-1,\"Mv-R-US\",0x512,0x0,0000000000000000,nil,0x80000000,0x80000000,\
                    100,\"Spell\",0x1,Player-1-1,0000000000000000,1,1,0,0,0,0,0,0,0,0,0,0,12.5,-7.0,2607,0,1";
        let dmg = "SPELL_DAMAGE,Player-1-1,\"Mv-R-US\",0x512,0x0,Creature-0-0-0-0-1-0,\"Boss\",0x10a48,0x0,\
                   100,\"Zap\",0x1,Creature-0-0-0-0-1-0,0000000000000000,1,1,0,0,0,0,0,0,0,0,0,0,500,500,2607,0,93,9,0,-1,1,0,0,0,nil,nil,ST";
        let (_t, store, data) = store_from(&[cast, dmg]);
        let unit = store.source_unit[0];
        let s = series(&store, &data, unit, store.timestamp_ms[0] - 1, store.timestamp_ms[1] + 1);
        assert_eq!(s.samples.len(), 1);
        assert_eq!((s.samples[0].x, s.samples[0].y), (12.5, -7.0));
    }

    #[test]
    fn opens_and_closes_a_death_span() {
        let (_t, store, data) = store_from(&[
            "UNIT_DIED,0000000000000000,nil,0x80000000,0x80000000,Player-1-1,\"Mv-R-US\",0x512,0x0,0",
            &format!("SPELL_RESURRECT,{AURA_BASE}100,\"Rebirth\",0x8"),
        ]);
        let dead = store.dest_unit[0];
        let s = series(&store, &data, dead, store.timestamp_ms[0] - 1, store.timestamp_ms[1] + 1);
        assert_eq!(s.deaths.len(), 1);
        assert_eq!(s.deaths[0].start_ms, store.timestamp_ms[0]);
        assert_eq!(s.deaths[0].end_ms, Some(store.timestamp_ms[1]));
    }
}
