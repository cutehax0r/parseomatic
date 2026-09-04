//! Derived "debug list" reports built from the fully-parsed event stream:
//! encounters (real + synthesized trash spans), player deaths, and
//! spec/gear snapshots from `COMBATANT_INFO`. Computed once in a single
//! sequential pass over the already-merged `EventStore` -- chunk-merge
//! order is file order (see `parser::parse_all`), so a plain forward scan
//! is enough; no re-sorting needed.

use super::event::{EventStore, LineKind, StandaloneKind};
use super::intern::{self, InternTables};
use super::tokenizer::FieldSpan;

pub struct Encounter {
    pub name_id: u16,
    /// Real `DungeonEncounterID`, or 0 for a synthesized trash span.
    pub encounter_id: u32,
    pub difficulty_id: u32,
    pub group_size: u32,
    pub instance_id: u32,
    pub start_ms: i64,
    pub end_ms: i64,
    pub start_row: u32,
    pub end_row: u32,
    /// `None` for trash and for an implicitly-synthesized end (malformed
    /// log / EOF-while-open) -- there was no real `ENCOUNTER_END` line to
    /// read a kill/wipe flag from.
    pub success: Option<bool>,
    pub is_trash: bool,
}

pub struct Death {
    pub unit_id: u32,
    pub timestamp_ms: i64,
    pub encounter_index: usize,
}

pub struct GearItem {
    pub item_id: u32,
    pub item_level: u32,
    /// 0 when the slot has no permanent enchant.
    pub enchant_id: u32,
    pub gem_ids: Vec<u32>,
}

/// The 22-value character-stat block from `COMBATANT_INFO` (patch 12.x
/// layout -- see `docs/combat-log-format.md` §8). Ratings, not
/// percentages. `crit`/`haste`/`versatility` collapse the three equal
/// melee/ranged/spell sub-values the log carries into one.
pub struct CombatantStats {
    pub strength: u32,
    pub agility: u32,
    pub stamina: u32,
    pub intellect: u32,
    pub dodge: u32,
    pub parry: u32,
    pub block: u32,
    pub crit: u32,
    pub haste: u32,
    pub mastery: u32,
    pub versatility: u32,
    pub leech: u32,
    pub speed: u32,
    pub avoidance: u32,
    pub armor: u32,
}

/// One selected talent from `COMBATANT_INFO`'s flat talent list --
/// `(traitNodeID, traitNodeEntryID, rank)`. In patch 12.x this one list
/// combines class + spec + hero + Omnium Folio picks; splitting them
/// needs trait-tree lookup data we don't have yet.
pub struct TalentPick {
    pub node_id: u32,
    pub entry_id: u32,
    pub rank: u32,
}

/// One "interesting aura" from `COMBATANT_INFO` (flask / food / rune /
/// set bonus / world buff). `caster_unit_id` is the `GuidTable` id of the
/// caster when it's a unit already known to the log, else
/// `intern::NO_UNIT`.
pub struct AuraPick {
    pub caster_unit_id: u32,
    pub spell_id: u32,
}

pub struct CombatantSnapshot {
    pub unit_id: u32,
    pub encounter_index: usize,
    pub timestamp_ms: i64,
    pub spec_id: u32,
    pub gear: Vec<GearItem>,
    /// `None` when the stat block wasn't the expected 22 fields.
    pub stats: Option<CombatantStats>,
    pub talents: Vec<TalentPick>,
    /// The non-zero spell ids from the `(0, id, id, id)` PvP-talent tuple.
    pub pvp_talents: Vec<u32>,
    pub auras: Vec<AuraPick>,
}

#[derive(Default)]
pub struct Reports {
    pub encounters: Vec<Encounter>,
    pub deaths: Vec<Death>,
    pub combatants: Vec<CombatantSnapshot>,
}

struct PendingEncounter {
    name_id: u16,
    encounter_id: u32,
    difficulty_id: u32,
    group_size: u32,
    instance_id: u32,
    start_ms: i64,
    start_row: u32,
}

impl PendingEncounter {
    fn close(self, end_ms: i64, end_row: u32, success: Option<bool>) -> Encounter {
        Encounter {
            name_id: self.name_id,
            encounter_id: self.encounter_id,
            difficulty_id: self.difficulty_id,
            group_size: self.group_size,
            instance_id: self.instance_id,
            start_ms: self.start_ms,
            end_ms,
            start_row: self.start_row,
            end_row,
            success,
            is_trash: false,
        }
    }
}

fn push_trash(encounters: &mut Vec<Encounter>, events: &EventStore, trash_name: u16, start_row: u32, end_row: u32) {
    if end_row < start_row {
        return;
    }
    encounters.push(Encounter {
        name_id: trash_name,
        encounter_id: 0,
        difficulty_id: 0,
        group_size: 0,
        instance_id: 0,
        start_ms: events.timestamp_ms[start_row as usize],
        end_ms: events.timestamp_ms[end_row as usize],
        start_row,
        end_row,
        success: None,
        is_trash: true,
    });
}

/// `ENCOUNTER_START,encounterID,"encounterName",difficultyID,groupSize,instanceID`
/// (`docs/combat-log-format.md` §8). `raw` here is the *full* field list
/// including the subevent name at `raw[0]` -- `ENCOUNTER_START`/`_END` fall
/// through `event::parse_standalone`'s generic `push_raw_only` path, which
/// doesn't strip it (unlike `COMBATANT_INFO`'s dedicated handling below).
fn parse_encounter_start(
    data: &[u8],
    raw: &[FieldSpan],
    tables: &mut InternTables,
) -> Option<(u16, u32, u32, u32, u32)> {
    if raw.len() < 6 {
        return None;
    }
    let encounter_id = raw[1].resolve_str(data).parse().unwrap_or(0);
    let name_id = tables.strings.intern(raw[2].resolve_str(data));
    let difficulty_id = raw[3].resolve_str(data).parse().unwrap_or(0);
    let group_size = raw[4].resolve_str(data).parse().unwrap_or(0);
    let instance_id = raw[5].resolve_str(data).parse().unwrap_or(0);
    Some((name_id, encounter_id, difficulty_id, group_size, instance_id))
}

/// `ENCOUNTER_END,encounterID,"encounterName",difficultyID,groupSize,success,fightTime`.
fn parse_encounter_end_success(data: &[u8], raw: &[FieldSpan]) -> Option<bool> {
    raw.get(5).map(|f| f.resolve_str(data) == "1")
}

fn strip_outer(s: &str, open: char, close: char) -> &str {
    let s = s.trim();
    if s.starts_with(open) && s.ends_with(close) && s.len() >= open.len_utf8() + close.len_utf8() {
        &s[open.len_utf8()..s.len() - close.len_utf8()]
    } else {
        s
    }
}

/// Splits `s` on top-level commas, tracking `(`/`)` nesting depth. Operates
/// on already-`resolve_str`'d `&str` slices rather than reusing the
/// byte-span tokenizer -- `COMBATANT_INFO`'s gear array is parsed once per
/// player per encounter (cold path, at most a few hundred calls per log),
/// so plain string slicing is simplest and the per-line-hot-path
/// performance rules this codebase otherwise leans on don't apply here.
fn split_top_level_parens(s: &str) -> Vec<&str> {
    if s.is_empty() {
        return Vec::new();
    }
    let mut parts = Vec::new();
    let mut depth = 0i32;
    let mut start = 0usize;
    for (i, b) in s.bytes().enumerate() {
        match b {
            b'(' => depth += 1,
            b')' => depth -= 1,
            b',' if depth == 0 => {
                parts.push(s[start..i].trim());
                start = i + 1;
            }
            _ => {}
        }
    }
    parts.push(s[start..].trim());
    parts
}

/// Parses `COMBATANT_INFO`'s equipped-items field --
/// `[(itemID,iLvl,(permEnchant,tempEnchant,onUseEnchant),(bonusID,...),(gemID,gemLvl,...)),...]`
/// (`docs/combat-log-format.md` §8). Reaching this field doesn't require
/// understanding the still-ambiguous talent/covenant field that precedes
/// it (§8's flagged hero/Apex-talent gap) -- the tokenizer's generic
/// bracket-depth tracking already isolated it as one span regardless of
/// what's inside that earlier field.
///
/// **Unverified against a real captured log**: the fixture
/// (`src-tauri/tests/fixtures/`) has zero `COMBATANT_INFO` lines. This is
/// built and tested against the worked example in
/// `docs/combat-log-format.md` §8 (itself wiki-sourced), not our own
/// captured data -- treat with correspondingly less confidence than the
/// rest of the parser until a real sample is available.
fn parse_equipped_items(text: &str) -> Vec<GearItem> {
    let inner = strip_outer(text, '[', ']');
    split_top_level_parens(inner)
        .into_iter()
        .filter(|s| !s.is_empty())
        .filter_map(|item_text| {
            let item_inner = strip_outer(item_text, '(', ')');
            let parts = split_top_level_parens(item_inner);
            if parts.len() < 5 {
                return None;
            }
            let item_id: u32 = parts[0].parse().ok()?;
            let item_level: u32 = parts[1].parse().ok()?;
            let enchant_id = split_top_level_parens(strip_outer(parts[2], '(', ')'))
                .first()
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            let gem_ids: Vec<u32> = split_top_level_parens(strip_outer(parts[4], '(', ')'))
                .iter()
                .step_by(2)
                .filter_map(|s| s.parse().ok())
                .collect();
            Some(GearItem {
                item_id,
                item_level,
                enchant_id,
                gem_ids,
            })
        })
        .collect()
}

/// The 22-value stat block (`raw[1 .. bracket-1]`, i.e. everything between
/// `faction` and `CurrentSpecID`). Layout pinned against a real patch-12
/// log across 19 specs -- see `docs/combat-log-format.md` §8. `None` when
/// it isn't exactly 22 clean numbers (a future format shift shouldn't
/// silently mislabel values).
fn parse_stat_block(data: &[u8], fields: &[FieldSpan]) -> Option<CombatantStats> {
    if fields.len() != 22 {
        return None;
    }
    let mut s = [0u32; 22];
    for (slot, f) in s.iter_mut().zip(fields) {
        *slot = f.resolve_str(data).parse().ok()?;
    }
    Some(CombatantStats {
        strength: s[0],
        agility: s[1],
        stamina: s[2],
        intellect: s[3],
        dodge: s[4],
        parry: s[5],
        block: s[6],
        // s[7] is always 0 (reserved). crit/haste/versatility each carry
        // three equal melee/ranged/spell sub-values; keep the first.
        crit: s[8],
        speed: s[11],
        leech: s[12],
        haste: s[13],
        avoidance: s[16],
        mastery: s[17],
        versatility: s[18],
        armor: s[21],
    })
}

/// `[(traitNodeID, traitNodeEntryID, rank), ...]` -- one flat list; in
/// 12.x it combines class + spec + hero + Omnium Folio picks.
fn parse_talents(text: &str) -> Vec<TalentPick> {
    split_top_level_parens(strip_outer(text, '[', ']'))
        .into_iter()
        .filter(|s| !s.is_empty())
        .filter_map(|tuple| {
            let parts = split_top_level_parens(strip_outer(tuple, '(', ')'));
            if parts.len() < 3 {
                return None;
            }
            Some(TalentPick {
                node_id: parts[0].parse().ok()?,
                entry_id: parts[1].parse().ok()?,
                rank: parts[2].parse().unwrap_or(1),
            })
        })
        .collect()
}

/// `(0, spellId, spellId, spellId)` / `(0,0,0,0)` -> the non-zero ids.
fn parse_pvp_talents(text: &str) -> Vec<u32> {
    split_top_level_parens(strip_outer(text, '(', ')'))
        .into_iter()
        .filter_map(|s| s.parse::<u32>().ok())
        .filter(|&id| id != 0)
        .collect()
}

/// The "interesting auras" list (flasks, food, runes, set bonuses, world
/// buffs). Pre-12.x logs it as `[casterGUID, spellId, ...]` pairs; 2026
/// logs add a trailing stack count per entry, making it
/// `[casterGUID, spellId, count, ...]` triples. Detected by whether every
/// third element is a small number. The caster resolves to a `GuidTable`
/// id when the log already knows the unit, else `NO_UNIT`.
fn parse_auras(text: &str, tables: &InternTables) -> Vec<AuraPick> {
    let parts = split_top_level_parens(strip_outer(text, '[', ']'));
    let parts: Vec<&str> = parts.into_iter().filter(|s| !s.is_empty()).collect();
    if parts.len() < 2 {
        return Vec::new();
    }
    let stride = if parts.len() % 3 == 0
        && parts.iter().skip(2).step_by(3).all(|s| s.parse::<u32>().map(|n| n < 1000).unwrap_or(false))
    {
        3
    } else {
        2
    };
    parts
        .chunks(stride)
        .filter_map(|c| {
            let spell_id: u32 = c.get(1)?.parse().ok()?;
            let caster_unit_id = tables.guids.get_id(c[0]).unwrap_or(intern::NO_UNIT);
            Some(AuraPick { caster_unit_id, spell_id })
        })
        .collect()
}

/// `raw` here excludes both the subevent name and `playerGUID`
/// (`event::parse_standalone`'s `CombatantInfo` arm slices from `fields[2..]`,
/// since `playerGUID` is already consumed into `unit_id` there). Layout
/// (patch 12.x, `docs/combat-log-format.md` §8): `raw[0]` = faction,
/// `raw[1..bracket-1]` = the 22-value stat block, `raw[bracket-1]` =
/// `CurrentSpecID`, then talents / PvP talents / gear / interesting auras
/// / 4 PvP-stat numbers. `bracket` = the first `[`/`(` group.
fn parse_combatant_info(
    data: &[u8],
    raw: &[FieldSpan],
    unit_id: u32,
    timestamp_ms: i64,
    encounter_index: usize,
    tables: &InternTables,
) -> Option<CombatantSnapshot> {
    if unit_id == intern::NO_UNIT || raw.len() < 27 {
        return None;
    }
    let bracket = raw.iter().position(|f| {
        matches!(f.resolve_str(data).as_bytes().first(), Some(b'[') | Some(b'('))
    })?;
    let spec_id: u32 = raw.get(bracket.checked_sub(1)?)?.resolve_str(data).parse().ok()?;

    let stats = raw
        .get(1..bracket - 1)
        .and_then(|block| parse_stat_block(data, block));

    let talents = raw
        .get(bracket)
        .map(|f| parse_talents(f.resolve_str(data)))
        .unwrap_or_default();

    // Gear is the first bracketed list after the talent field whose first
    // element is an item tuple `(itemID, iLvl, ...)`. Detecting it by
    // shape rather than a fixed offset spans both the 2026 layout
    // (talents, PvP talents, gear, auras) and pre-Dragonflight logs, which
    // slot an extra `[0,0,[],[],[]]` artifact block before gear.
    let is_item_list = |s: &str| s.starts_with('[') && strip_outer(s, '[', ']').starts_with('(');
    let gear_idx =
        (bracket + 1..raw.len()).find(|&i| is_item_list(raw[i].resolve_str(data)));
    let gear = gear_idx
        .map(|i| parse_equipped_items(raw[i].resolve_str(data)))
        .unwrap_or_default();

    // PvP talents: the `(...)` tuple sitting between the talent field and
    // gear. Auras: the next bracketed list after gear.
    let pvp_talents = (bracket + 1..gear_idx.unwrap_or(raw.len()))
        .find(|&i| raw[i].resolve_str(data).starts_with('('))
        .map(|i| parse_pvp_talents(raw[i].resolve_str(data)))
        .unwrap_or_default();
    let auras = gear_idx
        .and_then(|gi| {
            (gi + 1..raw.len()).find(|&i| raw[i].resolve_str(data).starts_with('['))
        })
        .map(|i| parse_auras(raw[i].resolve_str(data), tables))
        .unwrap_or_default();

    Some(CombatantSnapshot {
        unit_id,
        encounter_index,
        timestamp_ms,
        spec_id,
        gear,
        stats,
        talents,
        pvp_talents,
        auras,
    })
}

/// Builds encounters, player deaths, and gear/spec snapshots in one
/// forward pass over `events`. `data` is the mmap `events`' raw field
/// spans resolve against.
pub fn build_reports(data: &[u8], events: &EventStore, tables: &mut InternTables) -> Reports {
    let mut reports = Reports::default();
    let n = events.len();
    if n == 0 {
        return reports;
    }

    let trash_name = tables.strings.intern("Trash");

    let mut open: Option<PendingEncounter> = None;
    let mut span_start_row: u32 = 0;
    let mut span_index: usize = 0;

    for row in 0..n {
        match events.kind[row] {
            LineKind::Standalone(StandaloneKind::EncounterStart) => {
                if let Some(pending) = open.take() {
                    // Malformed: a start while one's already open
                    // implicitly ends the previous encounter immediately
                    // before this row (docs/planning.md's encounter
                    // malformed-log rule).
                    let end_row = row.saturating_sub(1) as u32;
                    reports
                        .encounters
                        .push(pending.close(events.timestamp_ms[end_row as usize], end_row, None));
                    span_index += 1;
                    span_start_row = row as u32;
                } else if row as u32 > span_start_row {
                    push_trash(&mut reports.encounters, events, trash_name, span_start_row, row as u32 - 1);
                    span_index += 1;
                }

                match parse_encounter_start(data, events.raw_fields(row), tables) {
                    Some((name_id, encounter_id, difficulty_id, group_size, instance_id)) => {
                        open = Some(PendingEncounter {
                            name_id,
                            encounter_id,
                            difficulty_id,
                            group_size,
                            instance_id,
                            start_ms: events.timestamp_ms[row],
                            start_row: row as u32,
                        });
                    }
                    // Malformed ENCOUNTER_START line -- don't lose the
                    // row, just treat it as the start of a new trash span
                    // instead of a real encounter.
                    None => {
                        open = None;
                        span_start_row = row as u32;
                    }
                }
            }
            LineKind::Standalone(StandaloneKind::EncounterEnd) => {
                if let Some(pending) = open.take() {
                    let success = parse_encounter_end_success(data, events.raw_fields(row));
                    reports
                        .encounters
                        .push(pending.close(events.timestamp_ms[row], row as u32, success));
                    span_index += 1;
                    span_start_row = row as u32 + 1;
                }
                // A stray END with no open START is ignored -- nothing
                // sensible to pair it with.
            }
            LineKind::Standalone(StandaloneKind::UnitDied) => {
                let dest = events.dest_unit[row];
                if dest != intern::NO_UNIT && tables.guids.get(dest).kind == intern::UnitKind::Player {
                    reports.deaths.push(Death {
                        unit_id: dest,
                        timestamp_ms: events.timestamp_ms[row],
                        encounter_index: span_index,
                    });
                }
            }
            LineKind::Standalone(StandaloneKind::CombatantInfo) => {
                if let Some(snapshot) = parse_combatant_info(
                    data,
                    events.raw_fields(row),
                    events.source_unit[row],
                    events.timestamp_ms[row],
                    span_index,
                    tables,
                ) {
                    reports.combatants.push(snapshot);
                }
            }
            _ => {}
        }
    }

    if let Some(pending) = open.take() {
        let end_row = n as u32 - 1;
        reports
            .encounters
            .push(pending.close(events.timestamp_ms[end_row as usize], end_row, None));
    } else if n as u32 - 1 >= span_start_row {
        push_trash(&mut reports.encounters, events, trash_name, span_start_row, n as u32 - 1);
    }

    reports
}

#[cfg(test)]
mod tests {
    use super::super::event;
    use super::super::tokenizer;
    use super::*;

    /// Parses a multi-line combat log fragment (unlike event.rs's
    /// single-line `parse()` test helper, encounter/death tracking needs a
    /// real sequence of lines) into one shared table+store, matching the
    /// same `iter_lines` + `parse_line` path `parser::parse_all` uses per
    /// chunk.
    fn parse_lines(text: &str) -> (Vec<u8>, InternTables, EventStore) {
        let data = text.trim_start().as_bytes().to_vec();
        let mut tables = InternTables::default();
        let mut store = EventStore::default();
        for (line_start, line) in tokenizer::iter_lines(&data, 0, data.len()) {
            event::parse_line(&data, line_start, line, &mut tables, &mut store);
        }
        (data, tables, store)
    }

    #[test]
    fn trash_synthesized_before_and_after_a_real_encounter() {
        let (data, mut tables, store) = parse_lines(
            r#"
7/25/2026 20:00:00.000-6  ZONE_CHANGE,1,"X",1
7/25/2026 20:01:00.000-6  ENCOUNTER_START,100,"Boss One",1,5,10
7/25/2026 20:01:10.000-6  UNIT_DIED,0000000000000000,nil,0x80000000,0x80000000,Creature-0-1-1-1-1-0000000001,"Trash Mob",0x2114,0x0,0
7/25/2026 20:01:20.000-6  UNIT_DIED,0000000000000000,nil,0x80000000,0x80000000,Player-1-1,"Alice-Realm",0x511,0x0,0
7/25/2026 20:02:00.000-6  ENCOUNTER_END,100,"Boss One",1,5,1,60000
7/25/2026 20:03:00.000-6  ZONE_CHANGE,1,"X",1
"#,
        );
        let reports = build_reports(&data, &store, &mut tables);

        assert_eq!(reports.encounters.len(), 3);
        assert!(reports.encounters[0].is_trash);
        assert!(!reports.encounters[1].is_trash);
        assert_eq!(tables.strings.get(reports.encounters[1].name_id), "Boss One");
        assert_eq!(reports.encounters[1].success, Some(true));
        assert!(reports.encounters[2].is_trash);

        // Only the player death counts -- the creature death right before
        // it must be excluded.
        assert_eq!(reports.deaths.len(), 1);
        assert_eq!(reports.deaths[0].encounter_index, 1);
        // Player unit name is split on first '-': "Alice-Realm" -> name
        // "Alice", server "Realm".
        let alice = tables.guids.get(reports.deaths[0].unit_id);
        assert_eq!(tables.strings.get(alice.name_id), "Alice");
        assert_eq!(alice.server_id.map(|s| tables.strings.get(s)), Some("Realm"));
    }

    #[test]
    fn start_while_already_open_implicitly_closes_the_previous_encounter() {
        let (data, mut tables, store) = parse_lines(
            r#"
7/25/2026 20:00:00.000-6  ENCOUNTER_START,1,"A",1,5,10
7/25/2026 20:00:05.000-6  ZONE_CHANGE,1,"X",1
7/25/2026 20:00:10.000-6  ENCOUNTER_START,2,"B",1,5,10
7/25/2026 20:00:20.000-6  ENCOUNTER_END,2,"B",1,5,1,10000
"#,
        );
        let reports = build_reports(&data, &store, &mut tables);

        assert_eq!(reports.encounters.len(), 2);
        assert_eq!(tables.strings.get(reports.encounters[0].name_id), "A");
        assert_eq!(reports.encounters[0].success, None, "implicit end has no real success flag");
        assert_eq!(tables.strings.get(reports.encounters[1].name_id), "B");
        assert_eq!(reports.encounters[1].success, Some(true));
    }

    #[test]
    fn eof_while_open_implicitly_closes_at_the_last_row() {
        let (data, mut tables, store) = parse_lines(
            r#"
7/25/2026 20:00:00.000-6  ENCOUNTER_START,1,"A",1,5,10
7/25/2026 20:00:05.000-6  ZONE_CHANGE,1,"X",1
"#,
        );
        let reports = build_reports(&data, &store, &mut tables);

        assert_eq!(reports.encounters.len(), 1);
        assert!(!reports.encounters[0].is_trash);
        assert_eq!(reports.encounters[0].success, None);
        assert_eq!(reports.encounters[0].end_row, 1);
    }

    #[test]
    fn whole_file_with_no_markers_is_one_trash_span() {
        let (data, mut tables, store) = parse_lines(
            r#"
7/25/2026 20:00:00.000-6  ZONE_CHANGE,1,"X",1
7/25/2026 20:00:05.000-6  ZONE_CHANGE,2,"Y",1
"#,
        );
        let reports = build_reports(&data, &store, &mut tables);

        assert_eq!(reports.encounters.len(), 1);
        assert!(reports.encounters[0].is_trash);
        assert_eq!(reports.encounters[0].start_row, 0);
        assert_eq!(reports.encounters[0].end_row, 1);
    }

    #[test]
    fn back_to_back_encounters_produce_no_spurious_trash() {
        let (data, mut tables, store) = parse_lines(
            r#"
7/25/2026 20:00:00.000-6  ENCOUNTER_START,1,"A",1,5,10
7/25/2026 20:00:10.000-6  ENCOUNTER_END,1,"A",1,5,1,10000
7/25/2026 20:00:10.000-6  ENCOUNTER_START,2,"B",1,5,10
7/25/2026 20:00:20.000-6  ENCOUNTER_END,2,"B",1,5,1,10000
"#,
        );
        let reports = build_reports(&data, &store, &mut tables);

        assert_eq!(reports.encounters.len(), 2);
        assert!(!reports.encounters[0].is_trash);
        assert!(!reports.encounters[1].is_trash);
    }

    #[test]
    fn combatant_info_parses_spec_and_gear_against_wiki_worked_example() {
        // From docs/combat-log-format.md §8's worked example (wiki-sourced;
        // the fixture log has zero COMBATANT_INFO lines to verify against
        // directly -- see this function's module-level caveat).
        // The two bracketed items are verbatim from the wiki's worked
        // example (both have an empty enchant tuple and an empty gem
        // tuple -- their populated `(1479,4786,6502)`-shaped tuple is
        // *bonusListIDs* per the documented 5-element item shape:
        // (itemID, iLvl, enchantTuple, bonusTuple, gemTuple) -- so it
        // doesn't exercise gem extraction). A third, synthetic item is
        // appended (not from the wiki) specifically to verify gem-pair
        // extraction (gemID,gemLvl,gemID,gemLvl -> take every other value)
        // and enchant-id extraction against real populated tuples.
        let (data, mut tables, store) = parse_lines(concat!(
            "7/25/2026 20:00:00.000-6  COMBATANT_INFO,Player-3299-004E8630,1,132,184,906,653,0,0,0,257,257,257,",
            "11,0,188,188,188,0,118,90,90,90,120,257,",
            "(193155,64129,238136,200199,321377,193157,265202),(0,235587,215982,328530),[0,0,[],[],[]],",
            "[(173845,90,(),(1479,4786,6502),()),(158075,140,(),(4932,4933,6316),()),(12345,300,(6807,0,0),(101,102),(50,1,51,2))],",
            "[Player-3299-004E8630,295365,Player-3299-004E8630,298268,Player-3299-004E8630,296320],1,0,0,0\n"
        ));
        let reports = build_reports(&data, &store, &mut tables);

        assert_eq!(reports.combatants.len(), 1);
        let snapshot = &reports.combatants[0];
        assert_eq!(snapshot.spec_id, 257);
        assert_eq!(
            tables.strings.get(tables.guids.get(snapshot.unit_id).name_id),
            ""
        ); // COMBATANT_INFO never carries a display name, only playerGUID
        assert_eq!(snapshot.gear.len(), 3);
        assert_eq!(snapshot.gear[0].item_id, 173845);
        assert_eq!(snapshot.gear[0].item_level, 90);
        assert_eq!(snapshot.gear[0].enchant_id, 0);
        assert!(snapshot.gear[0].gem_ids.is_empty());
        assert_eq!(snapshot.gear[1].item_id, 158075);

        let synthetic = &snapshot.gear[2];
        assert_eq!(synthetic.item_id, 12345);
        assert_eq!(synthetic.item_level, 300);
        assert_eq!(synthetic.enchant_id, 6807);
        assert_eq!(synthetic.gem_ids, vec![50, 51]);
    }

    #[test]
    fn combatant_info_parses_the_patch12_stat_talent_and_aura_blocks() {
        // Shaped like a real 2026 COMBATANT_INFO line (see
        // docs/combat-log-format.md §8): 22 stat fields, then spec, a
        // `[(node,entry,rank),...]` talent list, a `(0,id,id,id)` PvP
        // tuple, a `[(item)...]` gear list, a `[guid,spell,count,...]`
        // aura list, and 4 trailing PvP-stat numbers. Stat values are the
        // fixture's Destruction Warlock, so the §8 layout is self-testing.
        let (data, mut tables, store) = parse_lines(concat!(
            "9/3/2026 19:40:56.888-6  COMBATANT_INFO,Player-3299-004E8630,0,",
            "239,475,41839,3362,0,0,0,0,957,957,957,11,278,992,992,992,0,856,183,183,183,1193,267,",
            "[(71917,91424,1),(71918,91425,2),(71922,91430,1)],",
            "(0,200586,248855,0),",
            "[(271546,321,(7961,0,0),(6652,13696),()),(0,0,(),(),())],",
            "[Player-3299-004E8630,6262,1,Ghost-9-9,371172,1],",
            "19,0,0,0\n"
        ));
        let reports = build_reports(&data, &store, &mut tables);
        assert_eq!(reports.combatants.len(), 1);
        let c = &reports.combatants[0];

        assert_eq!(c.spec_id, 267);

        let s = c.stats.as_ref().expect("22-field stat block");
        assert_eq!(s.strength, 239);
        assert_eq!(s.agility, 475);
        assert_eq!(s.stamina, 41839);
        assert_eq!(s.intellect, 3362);
        assert_eq!(s.crit, 957);
        assert_eq!(s.speed, 11);
        assert_eq!(s.leech, 278);
        assert_eq!(s.haste, 992);
        assert_eq!(s.avoidance, 0);
        assert_eq!(s.mastery, 856);
        assert_eq!(s.versatility, 183);
        assert_eq!(s.armor, 1193);

        assert_eq!(c.talents.len(), 3);
        assert_eq!((c.talents[0].node_id, c.talents[0].entry_id, c.talents[0].rank), (71917, 91424, 1));
        assert_eq!(c.talents[1].rank, 2);

        assert_eq!(c.pvp_talents, vec![200586, 248855]); // the trailing 0 dropped

        assert_eq!(c.gear.len(), 2); // the (0,0,...) empty slot is kept as item_level 0
        assert_eq!(c.gear[0].item_id, 271546);
        assert_eq!(c.gear[0].item_level, 321);

        assert_eq!(c.auras.len(), 2);
        assert_eq!(c.auras[0].spell_id, 6262);
        assert_eq!(c.auras[0].caster_unit_id, c.unit_id); // self-cast, GUID known
        assert_eq!(c.auras[1].spell_id, 371172);
        assert_eq!(c.auras[1].caster_unit_id, intern::NO_UNIT); // Ghost-9-9 unknown
    }

    #[test]
    fn combatant_info_stat_block_is_none_when_not_22_fields() {
        // Pre-Dragonflight worked example has 21 pre-spec stat fields and
        // an extra `[0,0,[],[],[]]` artifact block before gear -- gear must
        // still be found by shape, stats left None rather than mislabelled.
        let (data, mut tables, store) = parse_lines(concat!(
            "7/25/2026 20:00:00.000-6  COMBATANT_INFO,Player-1-1,1,132,184,906,653,0,0,0,257,257,257,",
            "11,0,188,188,188,0,118,90,90,90,120,257,",
            "(193155,64129),(0,235587,215982,328530),[0,0,[],[],[]],",
            "[(173845,90,(),(),()),(158075,140,(),(),())],",
            "[Player-1-1,295365],1,0,0,0\n"
        ));
        let reports = build_reports(&data, &store, &mut tables);
        let c = &reports.combatants[0];
        assert!(c.stats.is_none());
        assert_eq!(c.spec_id, 257);
        assert_eq!(c.gear.len(), 2);
        assert_eq!(c.gear[0].item_id, 173845);
    }
}
