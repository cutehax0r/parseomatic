//! Event classification and per-line parsing. `Prefix`/`Suffix` mirror
//! `docs/combat-log-format.md` §6/§7 directly; `StandaloneKind` covers the
//! lines that don't fit the prefix+suffix shape at all (§8).
//!
//! Per the parser plan's scope call: base9 fields, prefix fields, and the
//! identifying fields needed for interning (units, spells, zones) are
//! fully typed. The 19-field advanced-params block and all suffix fields
//! are captured as raw byte spans rather than named columns -- nothing is
//! discarded (single pass, everything reachable via `raw_fields`), but
//! promoting a specific field to a typed/interned column is deferred until
//! a view actually needs it.

use super::intern::{self, InternRemap, InternTables};
use super::tokenizer::{self, FieldSpan};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Prefix {
    Swing,
    Range,
    Spell,
    SpellPeriodic,
    SpellBuilding,
    Environmental,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Suffix {
    Damage,
    Missed,
    Heal,
    HealAbsorbed,
    Energize,
    Drain,
    Leech,
    Interrupt,
    Dispel,
    DispelFailed,
    Stolen,
    ExtraAttacks,
    AuraApplied,
    AuraAppliedDose,
    AuraRemoved,
    AuraRemovedDose,
    AuraRefresh,
    AuraBroken,
    AuraBrokenSpell,
    CastStart,
    CastSuccess,
    CastFailed,
    Instakill,
    DurabilityDamage,
    DurabilityDamageAll,
    Create,
    Summon,
    Resurrect,
    EmpowerStart,
    EmpowerEnd,
    EmpowerInterrupt,
    /// A prefix we recognized but a suffix we didn't -- format grows over
    /// patches, don't treat this as an error.
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StandaloneKind {
    EncounterStart,
    EncounterEnd,
    CombatantInfo,
    ZoneChange,
    MapChange,
    WorldMarkerPlaced,
    WorldMarkerRemoved,
    PartyKill,
    UnitDied,
    UnitDestroyed,
    UnitDissipates,
    SpellAbsorbed,
    Emote,
    EnchantApplied,
    EnchantRemoved,
    ArenaMatchStart,
    ArenaMatchEnd,
    ChallengeModeStart,
    ChallengeModeEnd,
    CombatLogVersion,
    /// A subevent name we don't recognize at all, or a line too malformed
    /// to classify -- still gets a row (see `EventStore::push_unrecognized`)
    /// so line indices stay 1:1 with input lines.
    Unrecognized,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineKind {
    Composed { prefix: Prefix, suffix: Suffix },
    Standalone(StandaloneKind),
}

/// The parsed event stream, struct-of-arrays per `docs/planning.md`. Every
/// `Vec` here grows in lockstep, one entry per line -- `raw_fields` covers
/// whatever the advanced-params block and suffix fields hold that hasn't
/// been promoted to a typed column yet (see module docs).
#[derive(Default)]
pub struct EventStore {
    pub timestamp_ms: Vec<i64>,
    pub byte_offset: Vec<u32>,
    pub kind: Vec<LineKind>,
    pub source_unit: Vec<u32>,
    pub dest_unit: Vec<u32>,
    pub spell: Vec<u16>,
    pub has_advanced: Vec<bool>,
    pub raw_fields: Vec<Box<[FieldSpan]>>,
}

impl EventStore {
    pub fn len(&self) -> usize {
        self.timestamp_ms.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    #[allow(clippy::too_many_arguments)]
    fn push(
        &mut self,
        timestamp_ms: i64,
        byte_offset: u32,
        kind: LineKind,
        source_unit: u32,
        dest_unit: u32,
        spell: u16,
        has_advanced: bool,
        raw_fields: Box<[FieldSpan]>,
    ) {
        self.timestamp_ms.push(timestamp_ms);
        self.byte_offset.push(byte_offset);
        self.kind.push(kind);
        self.source_unit.push(source_unit);
        self.dest_unit.push(dest_unit);
        self.spell.push(spell);
        self.has_advanced.push(has_advanced);
        self.raw_fields.push(raw_fields);
    }

    fn push_unrecognized(&mut self, line_start: usize) {
        self.push(
            0,
            line_start as u32,
            LineKind::Standalone(StandaloneKind::Unrecognized),
            intern::NO_UNIT,
            intern::NO_UNIT,
            intern::NO_SPELL,
            false,
            Box::new([]),
        );
    }

    /// Appends `other` (a completed chunk's events) onto `self`, rewriting
    /// `other`'s intern ids from chunk-local to global via `remap` first.
    /// Used by the chunk-merge reduce step in `parser::mod`.
    pub fn append_remapped(&mut self, mut other: EventStore, remap: &InternRemap) {
        for id in other.source_unit.iter_mut() {
            if *id != intern::NO_UNIT {
                *id = remap.guids[*id as usize];
            }
        }
        for id in other.dest_unit.iter_mut() {
            if *id != intern::NO_UNIT {
                *id = remap.guids[*id as usize];
            }
        }
        for id in other.spell.iter_mut() {
            if *id != intern::NO_SPELL {
                *id = remap.spells[*id as usize];
            }
        }
        self.timestamp_ms.extend(other.timestamp_ms);
        self.byte_offset.extend(other.byte_offset);
        self.kind.extend(other.kind);
        self.source_unit.extend(other.source_unit);
        self.dest_unit.extend(other.dest_unit);
        self.spell.extend(other.spell);
        self.has_advanced.extend(other.has_advanced);
        self.raw_fields.extend(other.raw_fields);
    }
}

const PREFIXES: &[(&str, Prefix)] = &[
    // Longest/most-specific first: SPELL_PERIODIC_ and SPELL_BUILDING_
    // both start with "SPELL_", so a plain "SPELL_" check must lose.
    ("SPELL_PERIODIC_", Prefix::SpellPeriodic),
    ("SPELL_BUILDING_", Prefix::SpellBuilding),
    ("SWING_", Prefix::Swing),
    ("RANGE_", Prefix::Range),
    ("ENVIRONMENTAL_", Prefix::Environmental),
    ("SPELL_", Prefix::Spell),
];

fn match_prefix(name: &str) -> Option<(Prefix, &str)> {
    PREFIXES
        .iter()
        .find_map(|(p, kind)| name.strip_prefix(p).map(|rest| (*kind, rest)))
}

fn match_suffix(name: &str) -> Suffix {
    match name {
        // SWING_DAMAGE_LANDED shares SWING_DAMAGE's confirmed field shape
        // (docs/combat-log-format.md §5) -- collapsed to the same suffix
        // rather than a separate variant since nothing here types its
        // fields differently yet.
        "DAMAGE" | "DAMAGE_LANDED" => Suffix::Damage,
        "MISSED" => Suffix::Missed,
        "HEAL" => Suffix::Heal,
        "HEAL_ABSORBED" => Suffix::HealAbsorbed,
        "ENERGIZE" => Suffix::Energize,
        "DRAIN" => Suffix::Drain,
        "LEECH" => Suffix::Leech,
        "INTERRUPT" => Suffix::Interrupt,
        "DISPEL" => Suffix::Dispel,
        "DISPEL_FAILED" => Suffix::DispelFailed,
        "STOLEN" => Suffix::Stolen,
        "EXTRA_ATTACKS" => Suffix::ExtraAttacks,
        "AURA_APPLIED" => Suffix::AuraApplied,
        "AURA_APPLIED_DOSE" => Suffix::AuraAppliedDose,
        "AURA_REMOVED" => Suffix::AuraRemoved,
        "AURA_REMOVED_DOSE" => Suffix::AuraRemovedDose,
        "AURA_REFRESH" => Suffix::AuraRefresh,
        "AURA_BROKEN" => Suffix::AuraBroken,
        "AURA_BROKEN_SPELL" => Suffix::AuraBrokenSpell,
        "CAST_START" => Suffix::CastStart,
        "CAST_SUCCESS" => Suffix::CastSuccess,
        "CAST_FAILED" => Suffix::CastFailed,
        "INSTAKILL" => Suffix::Instakill,
        "DURABILITY_DAMAGE" => Suffix::DurabilityDamage,
        "DURABILITY_DAMAGE_ALL" => Suffix::DurabilityDamageAll,
        "CREATE" => Suffix::Create,
        "SUMMON" => Suffix::Summon,
        "RESURRECT" => Suffix::Resurrect,
        "EMPOWER_START" => Suffix::EmpowerStart,
        "EMPOWER_END" => Suffix::EmpowerEnd,
        "EMPOWER_INTERRUPT" => Suffix::EmpowerInterrupt,
        _ => Suffix::Unknown,
    }
}

/// Classifies a subevent name into its prefix+suffix shape or standalone
/// kind (`docs/combat-log-format.md` §6-§8).
fn classify(subevent: &str) -> LineKind {
    match subevent {
        "ENCOUNTER_START" => return LineKind::Standalone(StandaloneKind::EncounterStart),
        "ENCOUNTER_END" => return LineKind::Standalone(StandaloneKind::EncounterEnd),
        "COMBATANT_INFO" => return LineKind::Standalone(StandaloneKind::CombatantInfo),
        "ZONE_CHANGE" => return LineKind::Standalone(StandaloneKind::ZoneChange),
        "MAP_CHANGE" => return LineKind::Standalone(StandaloneKind::MapChange),
        "WORLD_MARKER_PLACED" => return LineKind::Standalone(StandaloneKind::WorldMarkerPlaced),
        "WORLD_MARKER_REMOVED" => {
            return LineKind::Standalone(StandaloneKind::WorldMarkerRemoved)
        }
        "PARTY_KILL" => return LineKind::Standalone(StandaloneKind::PartyKill),
        "UNIT_DIED" => return LineKind::Standalone(StandaloneKind::UnitDied),
        "UNIT_DESTROYED" => return LineKind::Standalone(StandaloneKind::UnitDestroyed),
        "UNIT_DISSIPATES" => return LineKind::Standalone(StandaloneKind::UnitDissipates),
        "SPELL_ABSORBED" => return LineKind::Standalone(StandaloneKind::SpellAbsorbed),
        "EMOTE" => return LineKind::Standalone(StandaloneKind::Emote),
        "ENCHANT_APPLIED" => return LineKind::Standalone(StandaloneKind::EnchantApplied),
        "ENCHANT_REMOVED" => return LineKind::Standalone(StandaloneKind::EnchantRemoved),
        "ARENA_MATCH_START" => return LineKind::Standalone(StandaloneKind::ArenaMatchStart),
        "ARENA_MATCH_END" => return LineKind::Standalone(StandaloneKind::ArenaMatchEnd),
        "CHALLENGE_MODE_START" => {
            return LineKind::Standalone(StandaloneKind::ChallengeModeStart)
        }
        "CHALLENGE_MODE_END" => return LineKind::Standalone(StandaloneKind::ChallengeModeEnd),
        "COMBAT_LOG_VERSION" => return LineKind::Standalone(StandaloneKind::CombatLogVersion),
        // Standalone subevent names that reuse SPELL's prefix+suffix shape
        // rather than composing it literally (docs/combat-log-format.md §7
        // gotcha note).
        "DAMAGE_SHIELD" | "DAMAGE_SPLIT" => {
            return LineKind::Composed {
                prefix: Prefix::Spell,
                suffix: Suffix::Damage,
            }
        }
        "DAMAGE_SHIELD_MISSED" => {
            return LineKind::Composed {
                prefix: Prefix::Spell,
                suffix: Suffix::Missed,
            }
        }
        _ => {}
    }
    match match_prefix(subevent) {
        Some((prefix, rest)) => LineKind::Composed {
            prefix,
            suffix: match_suffix(rest),
        },
        None => LineKind::Standalone(StandaloneKind::Unrecognized),
    }
}

/// Parses one line (already newline-trimmed) into `store`, interning
/// units/spells/zones into `tables` as it goes. `data` is the full mmap
/// slice `line` was sliced from -- needed to resolve field spans, which
/// store absolute offsets so they remain valid once separately captured
/// into `raw_fields`.
pub fn parse_line(
    data: &[u8],
    line_start: usize,
    line: &[u8],
    tables: &mut InternTables,
    store: &mut EventStore,
) {
    let Some((ts_bytes, rest)) = tokenizer::split_timestamp(line) else {
        store.push_unrecognized(line_start);
        return;
    };
    let timestamp_ms = tokenizer::parse_timestamp(ts_bytes).unwrap_or(0);
    let rest_offset = line_start + (rest.as_ptr() as usize - line.as_ptr() as usize);

    // EMOTE's free text may contain bracket-shaped UI markup that would
    // desync the general splitter's nesting depth -- special-cased before
    // any general splitting happens, per docs/combat-log-format.md §8.
    if rest.starts_with(b"EMOTE,") {
        parse_emote(data, line_start, rest, rest_offset, timestamp_ms, tables, store);
        return;
    }

    let fields = tokenizer::split_fields(rest, rest_offset);
    if fields.is_empty() {
        store.push_unrecognized(line_start);
        return;
    }
    let subevent = fields[0].resolve_str(data);
    match classify(subevent) {
        LineKind::Composed { prefix, suffix } => {
            parse_composed(data, line_start, &fields, prefix, suffix, timestamp_ms, tables, store)
        }
        LineKind::Standalone(kind) => {
            parse_standalone(data, line_start, &fields, kind, timestamp_ms, tables, store)
        }
    }
}

fn is_spell_family(prefix: Prefix) -> bool {
    matches!(
        prefix,
        Prefix::Range | Prefix::Spell | Prefix::SpellPeriodic | Prefix::SpellBuilding
    )
}

fn is_guid_shaped(s: &str) -> bool {
    intern::UnitKind::from_guid(s) != intern::UnitKind::Other
}

fn intern_unit(guid: &str, name: &str, tables: &mut InternTables) -> u32 {
    if guid == "nil" || intern::UnitKind::from_guid(guid) == intern::UnitKind::None {
        return intern::NO_UNIT;
    }
    let name_id = tables.strings.intern(if name == "nil" { "" } else { name });
    tables.guids.intern(guid, name_id, None)
}

/// Interns the base-9 source/dest unit fields (`fields[1..9]`), present at
/// the same positions on every composed event and on the base9-shaped
/// standalones (`PARTY_KILL`, `UNIT_DIED`/`_DESTROYED`/`_DISSIPATES`,
/// `SPELL_ABSORBED`).
fn intern_base9(data: &[u8], fields: &[FieldSpan], tables: &mut InternTables) -> (u32, u32) {
    let source_id = intern_unit(fields[1].resolve_str(data), fields[2].resolve_str(data), tables);
    let dest_id = intern_unit(fields[5].resolve_str(data), fields[6].resolve_str(data), tables);
    (source_id, dest_id)
}

fn parse_hex_u32(s: &str) -> Option<u32> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    u32::from_str_radix(s, 16).ok()
}

fn intern_spell(data: &[u8], fields: &[FieldSpan], tables: &mut InternTables) -> u16 {
    let Ok(spell_id) = fields[9].resolve_str(data).parse::<u32>() else {
        return intern::NO_SPELL;
    };
    let name_id = tables.strings.intern(fields[10].resolve_str(data));
    let school = parse_hex_u32(fields[11].resolve_str(data)).unwrap_or(0);
    tables.spells.intern(spell_id, name_id, school)
}

/// Links `infoGUID` (advanced-params field 1) to `ownerGUID` (field 2)
/// without modeling the rest of the 19-field block yet -- this is the one
/// piece of the advanced block worth typing now, since it's exactly what
/// the Units tab's "owner" column needs. `infoGUID` almost always already
/// has a name from the line's own source/dest fields (see
/// `docs/combat-log-format.md` §5); interning it here with an empty
/// placeholder name is safe because `GuidTable::intern` never overwrites
/// an existing record's name, only its `owner_id`.
fn link_owner(data: &[u8], advanced_fields: &[FieldSpan], tables: &mut InternTables) {
    let info_guid = advanced_fields[0].resolve_str(data);
    if intern::UnitKind::from_guid(info_guid) == intern::UnitKind::None {
        return;
    }
    let owner_guid = advanced_fields[1].resolve_str(data);
    let empty_name = tables.strings.intern("");
    let owner_id = if owner_guid == "nil" || intern::UnitKind::from_guid(owner_guid) == intern::UnitKind::None {
        None
    } else {
        Some(tables.guids.intern(owner_guid, empty_name, None))
    };
    tables.guids.intern(info_guid, empty_name, owner_id);
}

#[allow(clippy::too_many_arguments)]
fn parse_composed(
    data: &[u8],
    line_start: usize,
    fields: &[FieldSpan],
    prefix: Prefix,
    suffix: Suffix,
    timestamp_ms: i64,
    tables: &mut InternTables,
    store: &mut EventStore,
) {
    if fields.len() < 9 {
        store.push_unrecognized(line_start);
        return;
    }
    let (source_id, dest_id) = intern_base9(data, fields, tables);

    let prefix_len = match prefix {
        Prefix::Swing => 0,
        Prefix::Environmental => 1,
        _ if is_spell_family(prefix) => 3,
        _ => 0,
    };
    let after_prefix = 9 + prefix_len;

    let spell_id = if is_spell_family(prefix) && fields.len() >= after_prefix {
        intern_spell(data, fields, tables)
    } else {
        intern::NO_SPELL
    };

    // Advanced-params presence can't be trusted from the file header
    // (docs/combat-log-format.md §1/§5) -- detect per line by checking
    // whether the field right after the prefix looks GUID-shaped, which
    // none of the documented suffix-leading fields ever are.
    let has_advanced =
        fields.len() >= after_prefix + 19 && is_guid_shaped(fields[after_prefix].resolve_str(data));
    let advanced_end = if has_advanced { after_prefix + 19 } else { after_prefix };

    if has_advanced {
        link_owner(data, &fields[after_prefix..advanced_end], tables);
    }

    // Raw capture starts before the typed spell triple only for
    // Environmental (its one prefix field, environmentalType, has no typed
    // column) -- Spell-family prefix fields are already captured via
    // `spell_id` and skipped here to avoid storing them twice.
    let raw_start = if prefix == Prefix::Environmental { 9 } else { after_prefix };
    let raw: Box<[FieldSpan]> = fields[raw_start..].to_vec().into_boxed_slice();

    store.push(
        timestamp_ms,
        line_start as u32,
        LineKind::Composed { prefix, suffix },
        source_id,
        dest_id,
        spell_id,
        has_advanced,
        raw,
    );
}

fn push_raw_only(
    store: &mut EventStore,
    timestamp_ms: i64,
    line_start: usize,
    kind: StandaloneKind,
    fields: &[FieldSpan],
) {
    store.push(
        timestamp_ms,
        line_start as u32,
        LineKind::Standalone(kind),
        intern::NO_UNIT,
        intern::NO_UNIT,
        intern::NO_SPELL,
        false,
        fields.to_vec().into_boxed_slice(),
    );
}

fn parse_standalone(
    data: &[u8],
    line_start: usize,
    fields: &[FieldSpan],
    kind: StandaloneKind,
    timestamp_ms: i64,
    tables: &mut InternTables,
    store: &mut EventStore,
) {
    match kind {
        StandaloneKind::PartyKill
        | StandaloneKind::UnitDied
        | StandaloneKind::UnitDestroyed
        | StandaloneKind::UnitDissipates
        | StandaloneKind::SpellAbsorbed => {
            if fields.len() < 9 {
                store.push_unrecognized(line_start);
                return;
            }
            let (source_id, dest_id) = intern_base9(data, fields, tables);
            let raw: Box<[FieldSpan]> = fields[9..].to_vec().into_boxed_slice();
            store.push(
                timestamp_ms,
                line_start as u32,
                LineKind::Standalone(kind),
                source_id,
                dest_id,
                intern::NO_SPELL,
                false,
                raw,
            );
        }
        // MAP_CHANGE's uiMapID is the id space advanced-params' own
        // uiMapID field references, so it's the one worth interning into
        // ZoneTable now. ZONE_CHANGE's instanceID is a different id space
        // (dungeon/raid instance, not map/subzone) -- deliberately left as
        // raw capture only rather than conflating the two.
        // fields[0] is always the subevent name itself (split_fields
        // operates on the whole line, "MAP_CHANGE,2427,..."), so the
        // documented field #1 (docs/combat-log-format.md §8) lives at
        // fields[1], not fields[0].
        StandaloneKind::MapChange => {
            if fields.len() >= 3 {
                if let Ok(map_id) = fields[1].resolve_str(data).parse::<u32>() {
                    let name_id = tables.strings.intern(fields[2].resolve_str(data));
                    tables.zones.intern(map_id, name_id);
                }
            }
            push_raw_only(store, timestamp_ms, line_start, kind, fields);
        }
        StandaloneKind::CombatantInfo => {
            let source_id = if fields.len() > 1 {
                intern_unit(fields[1].resolve_str(data), "", tables)
            } else {
                intern::NO_UNIT
            };
            let raw: Box<[FieldSpan]> = fields.get(2..).unwrap_or(&[]).to_vec().into_boxed_slice();
            store.push(
                timestamp_ms,
                line_start as u32,
                LineKind::Standalone(kind),
                source_id,
                intern::NO_UNIT,
                intern::NO_SPELL,
                false,
                raw,
            );
        }
        StandaloneKind::Emote => {
            unreachable!("EMOTE is special-cased in parse_line before split_fields runs")
        }
        _ => push_raw_only(store, timestamp_ms, line_start, kind, fields),
    }
}

fn parse_emote(
    data: &[u8],
    line_start: usize,
    rest: &[u8],
    rest_offset: usize,
    timestamp_ms: i64,
    tables: &mut InternTables,
    store: &mut EventStore,
) {
    // EMOTE,sourceGUID,"sourceName",sourceFlags,sourceRaidFlags,text --
    // 5 fields (including the "EMOTE" subevent name itself) before text
    // begins (docs/combat-log-format.md §8).
    let (fields, text_offset) = tokenizer::split_first_n_fields(rest, rest_offset, 5);
    if fields.len() < 5 {
        store.push_unrecognized(line_start);
        return;
    }
    let source_id = intern_unit(fields[1].resolve_str(data), fields[2].resolve_str(data), tables);
    let text_end = rest_offset + rest.len();
    let raw: Box<[FieldSpan]> = if text_offset < text_end {
        vec![FieldSpan {
            start: text_offset as u32,
            len: (text_end - text_offset) as u32,
        }]
        .into_boxed_slice()
    } else {
        Box::new([])
    };
    store.push(
        timestamp_ms,
        line_start as u32,
        LineKind::Standalone(StandaloneKind::Emote),
        source_id,
        intern::NO_UNIT,
        intern::NO_SPELL,
        false,
        raw,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Parses one `rest`-of-line (everything after the timestamp) with a
    /// fixed, known timestamp prefix, treating the whole constructed line
    /// as its own `data` buffer -- valid since `parse_line` only needs
    /// `data` to resolve spans it itself produced from that same buffer.
    fn parse(rest: &str) -> (Vec<u8>, InternTables, EventStore) {
        let line = format!("7/25/2026 20:52:35.870-6  {rest}");
        let data = line.into_bytes();
        let mut tables = InternTables::default();
        let mut store = EventStore::default();
        parse_line(&data, 0, &data, &mut tables, &mut store);
        (data, tables, store)
    }

    #[test]
    fn classify_recognizes_prefix_suffix_and_standalone_names() {
        assert!(matches!(
            classify("SPELL_PERIODIC_DAMAGE"),
            LineKind::Composed {
                prefix: Prefix::SpellPeriodic,
                suffix: Suffix::Damage
            }
        ));
        assert!(matches!(
            classify("SWING_DAMAGE_LANDED"),
            LineKind::Composed {
                prefix: Prefix::Swing,
                suffix: Suffix::Damage
            }
        ));
        assert!(matches!(
            classify("DAMAGE_SHIELD_MISSED"),
            LineKind::Composed {
                prefix: Prefix::Spell,
                suffix: Suffix::Missed
            }
        ));
        assert!(matches!(
            classify("ENCOUNTER_START"),
            LineKind::Standalone(StandaloneKind::EncounterStart)
        ));
        assert!(matches!(
            classify("SOME_FUTURE_EVENT_TYPE"),
            LineKind::Standalone(StandaloneKind::Unrecognized)
        ));
    }

    // Real line pulled from src-tauri/tests/fixtures/WoWCombatLog-072526_205235.txt.
    #[test]
    fn swing_damage_interns_units_and_captures_advanced_plus_suffix_as_raw() {
        let (_, tables, store) = parse(concat!(
            "SWING_DAMAGE,Player-3678-0DCDE18E,\"Frightrogue-Thrall-US\",0x514,0x80000000,",
            "Creature-0-4227-1592-26103-238693-0000657958,\"Rotmire\",0x10a48,0x80000000,",
            "Player-3678-0DCDE18E,0000000000000000,446020,446020,2625,436,852,453,0,0,3,51,100,0,",
            "3909.77,-8650.86,2427,4.3902,285,2099,2290,-1,1,0,0,0,nil,nil,nil"
        ));
        assert_eq!(store.len(), 1);
        assert_eq!(store.timestamp_ms[0], 1_785_034_355_870);
        assert!(matches!(
            store.kind[0],
            LineKind::Composed {
                prefix: Prefix::Swing,
                suffix: Suffix::Damage
            }
        ));
        assert_ne!(store.source_unit[0], intern::NO_UNIT);
        assert_ne!(store.dest_unit[0], intern::NO_UNIT);
        assert_eq!(store.spell[0], intern::NO_SPELL);
        assert!(store.has_advanced[0]);
        // 19 advanced fields + 10 _DAMAGE suffix fields, confirmed against
        // the real fixture (docs/combat-log-format.md §5/§7).
        assert_eq!(store.raw_fields[0].len(), 29);

        let source_name = tables.strings.get(tables.guids.get(store.source_unit[0]).name_id);
        let dest_name = tables.strings.get(tables.guids.get(store.dest_unit[0]).name_id);
        assert_eq!(source_name, "Frightrogue-Thrall-US");
        assert_eq!(dest_name, "Rotmire");
        assert_eq!(tables.guids.get(store.dest_unit[0]).kind, intern::UnitKind::Creature);
    }

    #[test]
    fn spell_damage_interns_spell_and_carries_new_trailing_hit_type_field() {
        let (data, tables, store) = parse(concat!(
            "SPELL_DAMAGE,Player-3678-0DD22BEC,\"Tinsley-Thrall-US\",0x514,0x80000000,",
            "Creature-0-4227-1592-26103-238693-0000657958,\"Rotmire\",0x10a48,0x80000000,",
            "589,\"Shadow Word: Pain\",0x20,",
            "Creature-0-4227-1592-26103-238693-0000657958,0000000000000000,608368408,608376450,",
            "0,0,1470,0,0,0,3,0,100,0,3903.18,-8675.71,2427,1.1315,93,",
            "8042,3903,-1,32,0,0,0,1,nil,nil,ST"
        ));
        assert_eq!(store.len(), 1);
        assert_ne!(store.spell[0], intern::NO_SPELL);
        let spell = tables.spells.get(store.spell[0]);
        assert_eq!(spell.spell_id, 589);
        assert_eq!(tables.strings.get(spell.name_id), "Shadow Word: Pain");
        assert_eq!(spell.school, 0x20);
        assert!(store.has_advanced[0]);
        // 19 advanced + 10 _DAMAGE suffix + the new undocumented hitType field.
        assert_eq!(store.raw_fields[0].len(), 30);
        let hit_type = store.raw_fields[0].last().unwrap();
        assert_eq!(hit_type.resolve_str(&data), "ST");
    }

    #[test]
    fn stackless_aura_applied_has_no_amount_field() {
        let (_, _, store) = parse(concat!(
            "SPELL_AURA_APPLIED,Creature-0-4227-1592-26103-47649-0000657675,\"Efflorescence\",0x2114,0x80000000,",
            "Creature-0-4227-1592-26103-47649-0000657675,\"Efflorescence\",0x2114,0x80000000,",
            "81262,\"Efflorescence\",0x8,BUFF"
        ));
        assert_eq!(store.len(), 1);
        assert!(matches!(
            store.kind[0],
            LineKind::Composed {
                prefix: Prefix::Spell,
                suffix: Suffix::AuraApplied
            }
        ));
        assert!(!store.has_advanced[0]);
        // Just auraType, per the confirmed conditional-amount gotcha
        // (docs/combat-log-format.md §7).
        assert_eq!(store.raw_fields[0].len(), 1);
    }

    #[test]
    fn unit_died_interns_dest_only_and_leaves_source_unset() {
        let (_, tables, store) = parse(concat!(
            "UNIT_DIED,0000000000000000,nil,0x80000000,0x80000000,",
            "Creature-0-1469-2450-16377-99773-0000785473,\"Bloodworm\",0x2114,0x0,0"
        ));
        assert_eq!(store.len(), 1);
        assert!(matches!(
            store.kind[0],
            LineKind::Standalone(StandaloneKind::UnitDied)
        ));
        assert_eq!(store.source_unit[0], intern::NO_UNIT);
        assert_ne!(store.dest_unit[0], intern::NO_UNIT);
        assert_eq!(
            tables.strings.get(tables.guids.get(store.dest_unit[0]).name_id),
            "Bloodworm"
        );
        assert_eq!(store.raw_fields[0].len(), 1);
    }

    #[test]
    fn emote_free_text_with_bracket_markup_survives_intact() {
        let (data, _, store) = parse(concat!(
            "EMOTE,Vehicle-0-1465-2450-15939-175732-000016A7D7,\"Sylvanas Windrunner\",0000000000000000,nil,",
            "gains |cFFFF0000|Hspell:347504|h[Windrunner]|h|r!"
        ));
        assert_eq!(store.len(), 1);
        assert!(matches!(
            store.kind[0],
            LineKind::Standalone(StandaloneKind::Emote)
        ));
        assert_ne!(store.source_unit[0], intern::NO_UNIT);
        assert_eq!(store.raw_fields[0].len(), 1);
        assert_eq!(
            store.raw_fields[0][0].resolve_str(&data),
            "gains |cFFFF0000|Hspell:347504|h[Windrunner]|h|r!"
        );
    }

    #[test]
    fn map_change_interns_zone_by_ui_map_id() {
        let (_, tables, store) = parse("MAP_CHANGE,2427,\"Sporefall\",4143.750000,3816.666992,-8320.833984,-8810.416016");
        assert_eq!(store.len(), 1);
        assert_eq!(tables.zones.len(), 1);
        let zone = tables.zones.get(0);
        assert_eq!(zone.map_id, 2427);
        assert_eq!(tables.strings.get(zone.name_id), "Sporefall");
    }

    #[test]
    fn party_kill_interns_both_units() {
        let (_, tables, store) = parse(concat!(
            "PARTY_KILL,Player-154-07B381AB,\"Culligan-Shadowmoon-US\",0x511,0x80000000,",
            "Creature-0-4227-1592-26103-238696-0000000000,\"Shroomling\",0xa48,0x80000000,0"
        ));
        assert_eq!(store.len(), 1);
        assert_ne!(store.source_unit[0], intern::NO_UNIT);
        assert_ne!(store.dest_unit[0], intern::NO_UNIT);
        assert_eq!(
            tables.strings.get(tables.guids.get(store.source_unit[0]).name_id),
            "Culligan-Shadowmoon-US"
        );
    }

    #[test]
    fn unrecognized_line_still_gets_a_row() {
        let (_, _, store) = parse("SOME_FUTURE_EVENT,a,b,c");
        assert_eq!(store.len(), 1);
        assert!(matches!(
            store.kind[0],
            LineKind::Standalone(StandaloneKind::Unrecognized)
        ));
    }
}
