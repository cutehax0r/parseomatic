use tauri::WebviewWindow;

use crate::parser::intern::NO_UNIT;
use crate::window::current_log;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UnitRow {
    guid: String,
    /// Character name only -- for players, the realm/region half is split
    /// off into `server` (see `parser::intern::UnitRecord`).
    name: String,
    /// The `"Realm-Region"` half of a player's `"Character-Realm-Region"`
    /// unit name; `None` for non-players.
    server: Option<String>,
    kind: String,
    owner: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpellRow {
    spell_id: u32,
    name: String,
    school: u32,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ZoneRow {
    map_id: u32,
    name: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EncounterRow {
    name: String,
    encounter_id: u32,
    difficulty_id: u32,
    group_size: u32,
    start_ms: i64,
    end_ms: i64,
    duration_ms: i64,
    success: Option<bool>,
    is_trash: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeathRow {
    /// `log_lists.units` index -- lets a per-character view join a death to
    /// the selected player by id rather than by a name that can collide
    /// across realms (same reasoning as `CombatantRow.unit_id`).
    unit_id: u32,
    player_name: String,
    timestamp_ms: i64,
    encounter_name: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GearItemRow {
    item_id: u32,
    item_level: u32,
    enchant_id: u32,
    gem_ids: Vec<u32>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CombatantStatsRow {
    strength: u32,
    agility: u32,
    stamina: u32,
    intellect: u32,
    dodge: u32,
    parry: u32,
    block: u32,
    crit: u32,
    haste: u32,
    mastery: u32,
    versatility: u32,
    leech: u32,
    speed: u32,
    avoidance: u32,
    armor: u32,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TalentRow {
    node_id: u32,
    entry_id: u32,
    rank: u32,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuraRow {
    /// `log_lists.units` index of the caster, or null when the log
    /// doesn't otherwise know that unit.
    caster: Option<u32>,
    caster_name: String,
    spell_id: u32,
}

/// Spec + gear + stats + talents + buffs from `COMBATANT_INFO`. The parse
/// (see `parser::reports`) is exercised by the wiki-sourced worked
/// example in `docs/combat-log-format.md` §8 and checked against a real
/// patch-12 log with 400+ `COMBATANT_INFO` lines (a local, gitignored
/// fixture). `avg_item_level` / `item_count` cover only slots that hold
/// real gear -- see `equipped_summary`. Talent / spell **names and
/// icons** need lookup data we don't ship yet -- ids only for now.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CombatantRow {
    /// Backend intern id (index into `log_lists.units`) -- lets the
    /// character view join a selected player to their snapshot by id
    /// rather than by a name that can collide across realms.
    unit_id: u32,
    player_name: String,
    encounter_name: String,
    spec_id: u32,
    avg_item_level: Option<f64>,
    item_count: usize,
    gear: Vec<GearItemRow>,
    /// `null` when the stat block wasn't the expected 22 fields.
    stats: Option<CombatantStatsRow>,
    talents: Vec<TalentRow>,
    pvp_talents: Vec<u32>,
    auras: Vec<AuraRow>,
}

/// `(equipped_item_count, average_item_level)` for a `COMBATANT_INFO` gear
/// list. Non-counting slots are excluded: an unused slot logs as
/// `(0,0,(),(),())` -> `item_level` 0, and a shirt / tabard / cosmetic
/// logs a real item id but `item_level` 1 (WoW never folds those into
/// average ilvl). Counting them tanks the average by ~50 (a full 15-16
/// piece raider reads ~265 instead of ~315). We don't have slot ids yet,
/// so the `<= 1` level is the tell.
fn equipped_summary(gear: &[crate::parser::reports::GearItem]) -> (usize, Option<f64>) {
    let levels: Vec<u32> = gear.iter().map(|g| g.item_level).filter(|&l| l > 1).collect();
    if levels.is_empty() {
        return (0, None);
    }
    let avg = levels.iter().map(|&l| l as f64).sum::<f64>() / levels.len() as f64;
    (levels.len(), Some(avg))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LogListsPayload {
    units: Vec<UnitRow>,
    spells: Vec<SpellRow>,
    zones: Vec<ZoneRow>,
    encounters: Vec<EncounterRow>,
    deaths: Vec<DeathRow>,
    combatants: Vec<CombatantRow>,
}

/// The full set of "debug list" data for the window's current log, once
/// parsing has finished (`None` while still in progress or if no log is
/// open) -- backs the tabbed table view. `units`/`spells`/`zones` are the
/// raw interned tables; `players`/`pets` are filtered from `units`
/// client-side rather than duplicated here (kind == Player; owner != null).
#[tauri::command]
pub(crate) fn log_lists(window: WebviewWindow) -> Option<LogListsPayload> {
    let log = current_log(&window)?;
    let data = log.data()?;
    let tables = &data.tables;
    let reports = &data.reports;

    let units: Vec<UnitRow> = tables
        .guids
        .iter()
        .map(|u| UnitRow {
            guid: u.guid.to_string(),
            name: tables.strings.get(u.name_id).to_string(),
            server: u.server_id.map(|s| tables.strings.get(s).to_string()),
            kind: format!("{:?}", u.kind),
            owner: u
                .owner_id
                .map(|owner_id| tables.guids.get(owner_id).guid.to_string()),
        })
        .collect();

    let spells: Vec<SpellRow> = tables
        .spells
        .iter()
        .map(|s| SpellRow {
            spell_id: s.spell_id,
            name: tables.strings.get(s.name_id).to_string(),
            school: s.school,
        })
        .collect();

    let zones: Vec<ZoneRow> = tables
        .zones
        .iter()
        .map(|z| ZoneRow {
            map_id: z.map_id,
            name: tables.strings.get(z.name_id).to_string(),
        })
        .collect();

    let encounters: Vec<EncounterRow> = reports
        .encounters
        .iter()
        .map(|e| EncounterRow {
            name: tables.strings.get(e.name_id).to_string(),
            encounter_id: e.encounter_id,
            difficulty_id: e.difficulty_id,
            group_size: e.group_size,
            start_ms: e.start_ms,
            end_ms: e.end_ms,
            duration_ms: e.end_ms - e.start_ms,
            success: e.success,
            is_trash: e.is_trash,
        })
        .collect();

    let encounter_name = |index: usize| -> String {
        reports
            .encounters
            .get(index)
            .map(|e| tables.strings.get(e.name_id).to_string())
            .unwrap_or_default()
    };

    let deaths: Vec<DeathRow> = reports
        .deaths
        .iter()
        .map(|d| DeathRow {
            unit_id: d.unit_id,
            player_name: tables.strings.get(tables.guids.get(d.unit_id).name_id).to_string(),
            timestamp_ms: d.timestamp_ms,
            encounter_name: encounter_name(d.encounter_index),
        })
        .collect();

    let combatants: Vec<CombatantRow> = reports
        .combatants
        .iter()
        .map(|c| {
            let (item_count, avg_item_level) = equipped_summary(&c.gear);
            CombatantRow {
                unit_id: c.unit_id,
                player_name: tables.strings.get(tables.guids.get(c.unit_id).name_id).to_string(),
                encounter_name: encounter_name(c.encounter_index),
                spec_id: c.spec_id,
                avg_item_level,
                item_count,
                gear: c
                    .gear
                    .iter()
                    .map(|g| GearItemRow {
                        item_id: g.item_id,
                        item_level: g.item_level,
                        enchant_id: g.enchant_id,
                        gem_ids: g.gem_ids.clone(),
                    })
                    .collect(),
                stats: c.stats.as_ref().map(|s| CombatantStatsRow {
                    strength: s.strength,
                    agility: s.agility,
                    stamina: s.stamina,
                    intellect: s.intellect,
                    dodge: s.dodge,
                    parry: s.parry,
                    block: s.block,
                    crit: s.crit,
                    haste: s.haste,
                    mastery: s.mastery,
                    versatility: s.versatility,
                    leech: s.leech,
                    speed: s.speed,
                    avoidance: s.avoidance,
                    armor: s.armor,
                }),
                talents: c
                    .talents
                    .iter()
                    .map(|t| TalentRow { node_id: t.node_id, entry_id: t.entry_id, rank: t.rank })
                    .collect(),
                pvp_talents: c.pvp_talents.clone(),
                auras: c
                    .auras
                    .iter()
                    .map(|a| {
                        let known = a.caster_unit_id != NO_UNIT;
                        AuraRow {
                            caster: known.then_some(a.caster_unit_id),
                            caster_name: if known {
                                tables.strings.get(tables.guids.get(a.caster_unit_id).name_id).to_string()
                            } else {
                                String::new()
                            },
                            spell_id: a.spell_id,
                        }
                    })
                    .collect(),
            }
        })
        .collect();

    Some(LogListsPayload {
        units,
        spells,
        zones,
        encounters,
        deaths,
        combatants,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gear(level: u32) -> crate::parser::reports::GearItem {
        crate::parser::reports::GearItem {
            item_id: if level == 0 { 0 } else { 1000 + level },
            item_level: level,
            enchant_id: 0,
            gem_ids: vec![],
        }
    }

    #[test]
    fn equipped_summary_ignores_empty_and_cosmetic_slots() {
        // 13 real pieces at 315, one empty slot (0), a shirt and a tabard
        // (real item ids, item_level 1). The average must be 315, over 13
        // -- not dragged toward ~260 by the three non-counting slots.
        let mut g: Vec<_> = std::iter::repeat_with(|| gear(315)).take(13).collect();
        g.push(gear(0));
        g.push(gear(1));
        g.push(gear(1));
        let (count, avg) = equipped_summary(&g);
        assert_eq!(count, 13);
        assert_eq!(avg, Some(315.0));
    }

    #[test]
    fn equipped_summary_none_when_no_real_gear() {
        assert_eq!(equipped_summary(&[]), (0, None));
        assert_eq!(equipped_summary(&[gear(0), gear(1)]), (0, None));
    }
}
