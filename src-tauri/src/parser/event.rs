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

impl Prefix {
    /// Inverse of `match_prefix` -- the original subevent-name prefix text,
    /// for display (the raw view; `LineKind::label`).
    pub fn as_str(&self) -> &'static str {
        match self {
            Prefix::Swing => "SWING",
            Prefix::Range => "RANGE",
            Prefix::Spell => "SPELL",
            Prefix::SpellPeriodic => "SPELL_PERIODIC",
            Prefix::SpellBuilding => "SPELL_BUILDING",
            Prefix::Environmental => "ENVIRONMENTAL",
        }
    }
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

impl Suffix {
    /// Inverse of `match_suffix`, for display. Note this collapses back to
    /// the *canonical* suffix name, not necessarily the exact original text
    /// -- e.g. `SWING_DAMAGE_LANDED` and `DAMAGE_SHIELD` both map to
    /// `Suffix::Damage` already (see `match_suffix`/`classify`), so both
    /// display as `DAMAGE` here too. Acceptable per that same
    /// already-documented simplification.
    pub fn as_str(&self) -> &'static str {
        match self {
            Suffix::Damage => "DAMAGE",
            Suffix::Missed => "MISSED",
            Suffix::Heal => "HEAL",
            Suffix::HealAbsorbed => "HEAL_ABSORBED",
            Suffix::Energize => "ENERGIZE",
            Suffix::Drain => "DRAIN",
            Suffix::Leech => "LEECH",
            Suffix::Interrupt => "INTERRUPT",
            Suffix::Dispel => "DISPEL",
            Suffix::DispelFailed => "DISPEL_FAILED",
            Suffix::Stolen => "STOLEN",
            Suffix::ExtraAttacks => "EXTRA_ATTACKS",
            Suffix::AuraApplied => "AURA_APPLIED",
            Suffix::AuraAppliedDose => "AURA_APPLIED_DOSE",
            Suffix::AuraRemoved => "AURA_REMOVED",
            Suffix::AuraRemovedDose => "AURA_REMOVED_DOSE",
            Suffix::AuraRefresh => "AURA_REFRESH",
            Suffix::AuraBroken => "AURA_BROKEN",
            Suffix::AuraBrokenSpell => "AURA_BROKEN_SPELL",
            Suffix::CastStart => "CAST_START",
            Suffix::CastSuccess => "CAST_SUCCESS",
            Suffix::CastFailed => "CAST_FAILED",
            Suffix::Instakill => "INSTAKILL",
            Suffix::DurabilityDamage => "DURABILITY_DAMAGE",
            Suffix::DurabilityDamageAll => "DURABILITY_DAMAGE_ALL",
            Suffix::Create => "CREATE",
            Suffix::Summon => "SUMMON",
            Suffix::Resurrect => "RESURRECT",
            Suffix::EmpowerStart => "EMPOWER_START",
            Suffix::EmpowerEnd => "EMPOWER_END",
            Suffix::EmpowerInterrupt => "EMPOWER_INTERRUPT",
            Suffix::Unknown => "UNKNOWN",
        }
    }
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

impl StandaloneKind {
    /// Inverse of `classify`'s standalone-name matches, for display.
    pub fn as_str(&self) -> &'static str {
        match self {
            StandaloneKind::EncounterStart => "ENCOUNTER_START",
            StandaloneKind::EncounterEnd => "ENCOUNTER_END",
            StandaloneKind::CombatantInfo => "COMBATANT_INFO",
            StandaloneKind::ZoneChange => "ZONE_CHANGE",
            StandaloneKind::MapChange => "MAP_CHANGE",
            StandaloneKind::WorldMarkerPlaced => "WORLD_MARKER_PLACED",
            StandaloneKind::WorldMarkerRemoved => "WORLD_MARKER_REMOVED",
            StandaloneKind::PartyKill => "PARTY_KILL",
            StandaloneKind::UnitDied => "UNIT_DIED",
            StandaloneKind::UnitDestroyed => "UNIT_DESTROYED",
            StandaloneKind::UnitDissipates => "UNIT_DISSIPATES",
            StandaloneKind::SpellAbsorbed => "SPELL_ABSORBED",
            StandaloneKind::Emote => "EMOTE",
            StandaloneKind::EnchantApplied => "ENCHANT_APPLIED",
            StandaloneKind::EnchantRemoved => "ENCHANT_REMOVED",
            StandaloneKind::ArenaMatchStart => "ARENA_MATCH_START",
            StandaloneKind::ArenaMatchEnd => "ARENA_MATCH_END",
            StandaloneKind::ChallengeModeStart => "CHALLENGE_MODE_START",
            StandaloneKind::ChallengeModeEnd => "CHALLENGE_MODE_END",
            StandaloneKind::CombatLogVersion => "COMBAT_LOG_VERSION",
            StandaloneKind::Unrecognized => "UNRECOGNIZED",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineKind {
    Composed { prefix: Prefix, suffix: Suffix },
    Standalone(StandaloneKind),
}

// Bit flags packed into `EventStore::flags`. Set only for damage/heal
// composed events; 0 everywhere else.
pub const FLAG_CRIT: u8 = 1 << 0;
pub const FLAG_AOE: u8 = 1 << 1; // spell-prefixed _DAMAGE with hitType == "AOE"
pub const FLAG_OFFHAND: u8 = 1 << 2;

impl LineKind {
    /// Human-readable subevent-shaped label for display (the raw view) --
    /// e.g. `"SPELL_DAMAGE"`, `"ENCOUNTER_START"`. Reconstructed from the
    /// classification, not the original line text (which isn't kept
    /// around), so see `Suffix::as_str`'s doc comment for the one place
    /// this loses a distinction the original text had.
    pub fn label(&self) -> String {
        match self {
            LineKind::Composed { prefix, suffix } => {
                format!("{}_{}", prefix.as_str(), suffix.as_str())
            }
            LineKind::Standalone(kind) => kind.as_str().to_string(),
        }
    }
}

/// The parsed event stream, struct-of-arrays per `docs/planning.md`. Every
/// `Vec` here grows in lockstep, one entry per line -- `raw_fields` (see
/// the accessor of the same name) covers whatever the advanced-params
/// block and suffix fields hold that hasn't been promoted to a typed
/// column yet (see module docs).
///
/// Raw fields live in one shared `raw_field_arena` rather than a
/// `Box<[FieldSpan]>` per event: a per-event `Box` means one heap
/// allocation per line (1.8M of them for the real fixture) -- allocator
/// overhead during parsing, per-allocation bookkeeping/fragmentation, and
/// scattered-pointer cache misses when resolving rows later. One arena +
/// a `(start, len)` range per event is the standard fix, and it comes
/// with a nice side effect: every `push` call site that used to build a
/// `Vec`/`Box` just to hand it over now passes a plain borrowed slice.
#[derive(Default)]
pub struct EventStore {
    pub timestamp_ms: Vec<i64>,
    pub byte_offset: Vec<u32>,
    pub kind: Vec<LineKind>,
    pub source_unit: Vec<u32>,
    pub dest_unit: Vec<u32>,
    pub spell: Vec<u16>,
    pub has_advanced: Vec<bool>,
    /// Damage/heal amount for damage/heal composed events, 0 otherwise.
    /// Promoted from `raw_fields` because the query DSL (`query.rs`) needs
    /// it on every matching row -- see the module docs' "promote when a
    /// view needs it" note.
    pub amount: Vec<i64>,
    /// `FLAG_CRIT | FLAG_AOE | FLAG_OFFHAND`, 0 for non-damage/heal rows.
    pub flags: Vec<u8>,
    raw_field_ranges: Vec<(u32, u32)>,
    raw_field_arena: Vec<FieldSpan>,
}

impl EventStore {
    pub fn len(&self) -> usize {
        self.timestamp_ms.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The raw (not-yet-typed) fields captured for `row`.
    pub fn raw_fields(&self, row: usize) -> &[FieldSpan] {
        let (start, len) = self.raw_field_ranges[row];
        &self.raw_field_arena[start as usize..(start + len) as usize]
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
        amount: i64,
        flags: u8,
        raw_fields: &[FieldSpan],
    ) {
        self.timestamp_ms.push(timestamp_ms);
        self.byte_offset.push(byte_offset);
        self.kind.push(kind);
        self.source_unit.push(source_unit);
        self.dest_unit.push(dest_unit);
        self.spell.push(spell);
        self.has_advanced.push(has_advanced);
        self.amount.push(amount);
        self.flags.push(flags);
        let start = self.raw_field_arena.len() as u32;
        self.raw_field_arena.extend_from_slice(raw_fields);
        self.raw_field_ranges.push((start, raw_fields.len() as u32));
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
            0,
            0,
            &[],
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

        // other's ranges point into other's arena -- once that arena is
        // appended after self's existing arena, every one of other's
        // offsets needs shifting by how much of self's arena already
        // existed.
        let arena_offset = self.raw_field_arena.len() as u32;
        for (start, _len) in other.raw_field_ranges.iter_mut() {
            *start += arena_offset;
        }

        self.timestamp_ms.extend(other.timestamp_ms);
        self.byte_offset.extend(other.byte_offset);
        self.kind.extend(other.kind);
        self.source_unit.extend(other.source_unit);
        self.dest_unit.extend(other.dest_unit);
        self.spell.extend(other.spell);
        self.has_advanced.extend(other.has_advanced);
        self.amount.extend(other.amount);
        self.flags.extend(other.flags);
        self.raw_field_arena.extend(other.raw_field_arena);
        self.raw_field_ranges.extend(other.raw_field_ranges);
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

/// `(amount, flags)` for a damage/heal composed event, promoted from the
/// row's raw fields. `raw` is the slice `parse_composed` is about to push
/// (advanced block if present, then suffix fields, then a trailing
/// `hitType` for spell-prefixed `_DAMAGE`/`_MISSED`). Suffix fields start
/// at offset 19 when the advanced block is present, else 0
/// (`docs/combat-log-format.md` §5/§7). Non-damage/heal suffixes, and
/// `ENVIRONMENTAL_*` (its raw slice keeps an extra leading prefix field),
/// yield `(0, 0)`.
fn extract_damage_heal(
    prefix: Prefix,
    suffix: Suffix,
    has_advanced: bool,
    raw: &[FieldSpan],
    data: &[u8],
) -> (i64, u8) {
    if prefix == Prefix::Environmental {
        return (0, 0);
    }
    let off = if has_advanced { 19 } else { 0 };
    let field = |i: usize| raw.get(off + i).map(|f| f.resolve_str(data));
    // Boolean suffix fields render as the bare token "1" / "0" / "nil"
    // in the file, never true/false (§3).
    let is_set = |s: Option<&str>| s == Some("1");

    match suffix {
        Suffix::Damage => {
            let amount = field(0).and_then(|s| s.parse().ok()).unwrap_or(0);
            let mut flags = 0u8;
            if is_set(field(6)) {
                flags |= FLAG_CRIT;
            }
            if is_set(field(9)) {
                flags |= FLAG_OFFHAND;
            }
            if is_spell_family(prefix) && raw.last().map(|f| f.resolve_str(data)) == Some("AOE") {
                flags |= FLAG_AOE;
            }
            (amount, flags)
        }
        Suffix::Heal => {
            let amount = field(0).and_then(|s| s.parse().ok()).unwrap_or(0);
            let flags = if is_set(field(3)) { FLAG_CRIT } else { 0 };
            (amount, flags)
        }
        _ => (0, 0),
    }
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
    let raw = &fields[raw_start..];

    let (amount, flags) = extract_damage_heal(prefix, suffix, has_advanced, raw, data);

    store.push(
        timestamp_ms,
        line_start as u32,
        LineKind::Composed { prefix, suffix },
        source_id,
        dest_id,
        spell_id,
        has_advanced,
        amount,
        flags,
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
        0,
        0,
        fields,
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
            store.push(
                timestamp_ms,
                line_start as u32,
                LineKind::Standalone(kind),
                source_id,
                dest_id,
                intern::NO_SPELL,
                false,
                0,
                0,
                &fields[9..],
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
            store.push(
                timestamp_ms,
                line_start as u32,
                LineKind::Standalone(kind),
                source_id,
                intern::NO_UNIT,
                intern::NO_SPELL,
                false,
                0,
                0,
                fields.get(2..).unwrap_or(&[]),
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
    let text_span = FieldSpan {
        start: text_offset as u32,
        len: (text_end.saturating_sub(text_offset)) as u32,
    };
    let raw: &[FieldSpan] = if text_offset < text_end {
        std::slice::from_ref(&text_span)
    } else {
        &[]
    };
    store.push(
        timestamp_ms,
        line_start as u32,
        LineKind::Standalone(StandaloneKind::Emote),
        source_id,
        intern::NO_UNIT,
        intern::NO_SPELL,
        false,
        0,
        0,
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

    #[test]
    fn label_reconstructs_the_subevent_name() {
        assert_eq!(classify("SPELL_DAMAGE").label(), "SPELL_DAMAGE");
        assert_eq!(classify("UNIT_DIED").label(), "UNIT_DIED");
        assert_eq!(classify("ENCOUNTER_START").label(), "ENCOUNTER_START");
        // Documented collapse (docs/combat-log-format.md, Suffix::as_str's
        // doc comment): these map to the same canonical label as their
        // more common counterpart, not their exact original text.
        assert_eq!(classify("SWING_DAMAGE_LANDED").label(), "SWING_DAMAGE");
        assert_eq!(classify("DAMAGE_SHIELD_MISSED").label(), "SPELL_MISSED");
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
        assert_eq!(store.raw_fields(0).len(), 29);
        // Promoted amount (suffix field 0) + flags (critical=0 here, no
        // hitType on SWING_*).
        assert_eq!(store.amount[0], 2099);
        assert_eq!(store.flags[0], 0);

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
        assert_eq!(store.raw_fields(0).len(), 30);
        let hit_type = store.raw_fields(0).last().unwrap();
        assert_eq!(hit_type.resolve_str(&data), "ST");
        // Promoted amount + flags: suffix field 0 is 8042, critical (field
        // 6) is 0, hitType ST -> no flags.
        assert_eq!(store.amount[0], 8042);
        assert_eq!(store.flags[0], 0);
    }

    #[test]
    fn spell_damage_promotes_crit_and_aoe_flags() {
        let (_, _, store) = parse(concat!(
            "SPELL_DAMAGE,Player-1-00000001,\"Mage-Realm-US\",0x511,0x0,",
            "Creature-0-0-0-0-1-0,\"Add\",0xa48,0x0,",
            "1449,\"Arcane Explosion\",0x40,",
            "Player-1-00000001,0000000000000000,100,100,0,0,0,0,0,0,0,0,100,0,0,0,0,0,0,",
            "5000,0,64,0,0,0,1,nil,nil,nil,AOE"
        ));
        assert_eq!(store.len(), 1);
        assert!(store.has_advanced[0]);
        assert_eq!(store.amount[0], 5000);
        assert_eq!(store.flags[0], FLAG_CRIT | FLAG_AOE);
    }

    #[test]
    fn spell_heal_promotes_amount_and_crit_from_its_shorter_suffix() {
        // _HEAL suffix is amount, overhealing, absorbed, critical (4 fields).
        let (_, _, store) = parse(concat!(
            "SPELL_HEAL,Player-1-00000002,\"Priest-Realm-US\",0x511,0x0,",
            "Player-1-00000003,\"Tank-Realm-US\",0x511,0x0,",
            "2061,\"Flash Heal\",0x2,",
            "Player-1-00000003,0000000000000000,5000,5000,0,0,0,0,0,0,0,0,100,0,0,0,0,0,0,",
            "12000,3000,0,1"
        ));
        assert_eq!(store.len(), 1);
        assert!(matches!(
            store.kind[0],
            LineKind::Composed { prefix: Prefix::Spell, suffix: Suffix::Heal }
        ));
        assert_eq!(store.amount[0], 12000);
        assert_eq!(store.flags[0], FLAG_CRIT);
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
        assert_eq!(store.raw_fields(0).len(), 1);
        // Non-damage/heal suffix -> no promoted amount or flags.
        assert_eq!(store.amount[0], 0);
        assert_eq!(store.flags[0], 0);
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
        assert_eq!(store.raw_fields(0).len(), 1);
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
        assert_eq!(store.raw_fields(0).len(), 1);
        assert_eq!(
            store.raw_fields(0)[0].resolve_str(&data),
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
