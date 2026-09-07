//! Per-player activity timeline for one UI-picked window -- backs the
//! Timeline view (`src/views/timeline.ts`). One live windowed scan (the
//! range comes from the UI, so like `movement.rs` / `damage.rs` it can't
//! be precomputed), one pass over `[start_ms, end_ms]` producing three
//! streams the frontend lays out as stacked lanes:
//!
//! - **instants** -- the player's damage/heal events (no real duration;
//!   the view draws each at ~1.5s or a min sliver). Direction + the
//!   same-ms `SWING_DAMAGE` / `SWING_DAMAGE_LANDED` dedup are lifted from
//!   `movement::events`.
//! - **auras** -- `SPELL_AURA_APPLIED` .. `SPELL_AURA_REMOVED` spans on
//!   the player, split buff vs debuff off the `auraType` field. These are
//!   the lanes with genuine width.
//! - **deaths** -- `UNIT_DIED` .. `SPELL_RESURRECT`, same as
//!   `movement::series`, drawn as rules across every lane.

use crate::movement::DeathSpan;
use crate::parser::event::{EventStore, LineKind, Prefix, StandaloneKind, Suffix};
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
    let mut out = TimelineSeries {
        start_ms,
        end_ms,
        instants: Vec::new(),
        auras: Vec::new(),
        deaths: Vec::new(),
    };
    if unit_id == NO_UNIT || end_ms <= start_ms {
        return out;
    }

    let (lo, hi) = crate::query::window(events, start_ms, end_ms);

    // Last kept (ts, kind, source, dest, spell, amount) -- collapses the
    // same-ms SWING_DAMAGE / SWING_DAMAGE_LANDED pair the parser can't
    // tell apart (identical fields, one row the attacker's, one the
    // victim's), exactly as `movement::events` does.
    let mut prev: Option<(i64, InstKind, u32, u32, u16, i64)> = None;

    for row in lo..hi {
        let ts = events.timestamp_ms[row];
        if ts < start_ms || ts > end_ms {
            continue;
        }
        let src = events.source_unit[row];
        let dst = events.dest_unit[row];

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
                let already_open = out
                    .auras
                    .iter()
                    .any(|a| a.end_ms.is_none() && a.spell_id == spell);
                if !already_open {
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
                let spell = events.spell[row];
                if let Some(open) = out
                    .auras
                    .iter_mut()
                    .rev()
                    .find(|a| a.end_ms.is_none() && a.spell_id == spell)
                {
                    if let Some(n) = events
                        .raw_fields(row)
                        .iter()
                        .find_map(|f| f.resolve_str(mmap).parse::<u32>().ok())
                    {
                        open.max_stacks = open.max_stacks.max(n);
                    }
                }
            }
            LineKind::Composed { suffix: Suffix::AuraRemoved, .. } if dst == unit_id => {
                let spell = events.spell[row];
                if let Some(open) = out
                    .auras
                    .iter_mut()
                    .rev()
                    .find(|a| a.end_ms.is_none() && a.spell_id == spell)
                {
                    open.end_ms = Some(ts);
                }
            }

            // --- resurrect closes the newest open death span ------------
            LineKind::Composed { suffix: Suffix::Resurrect, .. } if dst == unit_id => {
                if let Some(span) = out.deaths.last_mut() {
                    span.end_ms.get_or_insert(ts);
                }
            }

            // --- instants (damage / heal) -----------------------------
            LineKind::Composed { prefix, suffix: Suffix::Damage } => {
                let kind = if src == unit_id {
                    InstKind::DmgOut
                } else if dst == unit_id {
                    InstKind::DmgIn
                } else {
                    continue;
                };
                let periodic = prefix == Prefix::SpellPeriodic;
                push_instant(events, row, &mut out, &mut prev, unit_id, kind, src, dst, periodic);
            }
            LineKind::Composed { prefix, suffix: Suffix::Heal } => {
                let kind = if src == unit_id {
                    InstKind::HealOut
                } else if dst == unit_id {
                    InstKind::HealIn
                } else {
                    continue;
                };
                let periodic = prefix == Prefix::SpellPeriodic;
                push_instant(events, row, &mut out, &mut prev, unit_id, kind, src, dst, periodic);
            }
            _ => {}
        }
    }

    out
}

#[allow(clippy::too_many_arguments)]
fn push_instant(
    events: &EventStore,
    row: usize,
    out: &mut TimelineSeries,
    prev: &mut Option<(i64, InstKind, u32, u32, u16, i64)>,
    unit_id: u32,
    kind: InstKind,
    src: u32,
    dst: u32,
    periodic: bool,
) {
    let ts = events.timestamp_ms[row];
    let spell = events.spell[row];
    let amount = events.amount[row];
    let key = (ts, kind, src, dst, spell, amount);
    if *prev == Some(key) {
        return;
    }
    *prev = Some(key);

    let other = match kind {
        InstKind::DmgOut | InstKind::HealOut => dst,
        InstKind::DmgIn | InstKind::HealIn => src,
    };
    // Only trust the row's coords when they describe the player.
    let (x, y) = if events.pos_unit[row] == unit_id {
        (events.pos_x[row], events.pos_y[row])
    } else {
        (f32::NAN, f32::NAN)
    };
    out.instants.push(Instant {
        t_ms: ts,
        kind,
        spell_id: spell,
        amount,
        other_unit: other,
        periodic,
        x,
        y,
    });
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
