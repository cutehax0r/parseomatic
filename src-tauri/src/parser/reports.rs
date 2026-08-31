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

pub struct CombatantSnapshot {
    pub unit_id: u32,
    pub encounter_index: usize,
    pub timestamp_ms: i64,
    pub spec_id: u32,
    pub gear: Vec<GearItem>,
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

/// `raw` here excludes both the subevent name and `playerGUID`
/// (`event::parse_standalone`'s `CombatantInfo` arm slices from `fields[2..]`,
/// since `playerGUID` is already consumed into `unit_id` there) -- so doc
/// field N (1-indexed, `playerGUID` = field 1) lives at `raw[N - 2]`.
fn parse_combatant_info(
    data: &[u8],
    raw: &[FieldSpan],
    unit_id: u32,
    timestamp_ms: i64,
    encounter_index: usize,
) -> Option<CombatantSnapshot> {
    if unit_id == intern::NO_UNIT || raw.len() < 27 {
        return None;
    }
    let spec_id: u32 = raw[22].resolve_str(data).parse().ok()?; // doc field 24
    let gear = parse_equipped_items(raw[26].resolve_str(data)); // doc field 28
    Some(CombatantSnapshot {
        unit_id,
        encounter_index,
        timestamp_ms,
        spec_id,
        gear,
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
        assert_eq!(
            tables.strings.get(tables.guids.get(reports.deaths[0].unit_id).name_id),
            "Alice-Realm"
        );
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
}
