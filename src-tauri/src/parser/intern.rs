//! Interning tables for units (GUIDs), display strings, spells, and zones,
//! per `docs/planning.md`'s data-representation design: each table is a
//! `HashMap` (first-sight lookup) backing a dense `Vec` (id -> record).
//!
//! Parsing runs one independent copy of these tables per rayon chunk (zero
//! contention across threads), then [`InternTables::merge`] combines a
//! chunk's tables into the running global tables and returns an
//! [`InternRemap`] the caller uses to rewrite that chunk's already-parsed
//! event columns from chunk-local ids to global ids.

use std::sync::Arc;

use rustc_hash::FxHashMap;

/// Reserved id meaning "no unit" (nil source/dest, or the zero-GUID
/// sentinel) -- never assigned to a real [`GuidTable`] entry.
pub const NO_UNIT: u32 = u32::MAX;
/// Reserved id meaning "no spell" (line has no SPELL/RANGE/etc prefix) --
/// never assigned to a real [`SpellTable`] entry.
pub const NO_SPELL: u16 = u16::MAX;
/// Reserved id meaning "no zone" -- never assigned to a real [`ZoneTable`]
/// entry.
pub const NO_ZONE: u16 = u16::MAX;

/// What kind of entity a GUID belongs to, from its prefix
/// (`docs/combat-log-format.md` §4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnitKind {
    Player,
    Creature,
    Pet,
    Vehicle,
    GameObject,
    Item,
    BattlePet,
    Vignette,
    BnetAccount,
    ClientActor,
    Cast,
    /// The all-zero GUID sentinel (`0000000000000000`) -- "no unit."
    None,
    /// A prefix we don't recognize -- format grows over patches, don't
    /// treat this as an error.
    Other,
}

impl UnitKind {
    pub fn from_guid(guid: &str) -> UnitKind {
        if guid.bytes().all(|b| b == b'0') {
            return UnitKind::None;
        }
        let prefix = guid.split('-').next().unwrap_or("");
        match prefix {
            "Player" => UnitKind::Player,
            "Creature" => UnitKind::Creature,
            "Pet" => UnitKind::Pet,
            "Vehicle" => UnitKind::Vehicle,
            "GameObject" => UnitKind::GameObject,
            "Item" => UnitKind::Item,
            "BattlePet" => UnitKind::BattlePet,
            "Vignette" => UnitKind::Vignette,
            "BNetAccount" => UnitKind::BnetAccount,
            "ClientActor" => UnitKind::ClientActor,
            "Cast" => UnitKind::Cast,
            _ => UnitKind::Other,
        }
    }
}

/// Deduplicated display strings -- unit names, spell names, and zone names
/// share one table (dedup by exact string is harmless across categories;
/// one table is simpler than three).
#[derive(Default)]
pub struct StringTable {
    index: FxHashMap<Arc<str>, u16>,
    strings: Vec<Arc<str>>,
}

impl StringTable {
    pub fn intern(&mut self, s: &str) -> u16 {
        if let Some(&id) = self.index.get(s) {
            return id;
        }
        assert!(
            self.strings.len() < u16::MAX as usize,
            "StringTable overflow: more than 65535 distinct strings in one log"
        );
        let id = self.strings.len() as u16;
        let arc: Arc<str> = Arc::from(s);
        self.index.insert(arc.clone(), id);
        self.strings.push(arc);
        id
    }

    pub fn get(&self, id: u16) -> &str {
        &self.strings[id as usize]
    }

    pub fn len(&self) -> usize {
        self.strings.len()
    }

    /// Merges `other` into `self` (cheap `Arc` clones, no string-byte
    /// copies for values that already existed in `other`), returning a
    /// local id -> global id remap for `other`'s ids.
    pub fn merge(&mut self, other: StringTable) -> Vec<u16> {
        other
            .strings
            .into_iter()
            .map(|s| {
                if let Some(&id) = self.index.get(&*s) {
                    id
                } else {
                    assert!(
                        self.strings.len() < u16::MAX as usize,
                        "StringTable overflow: more than 65535 distinct strings in one log"
                    );
                    let id = self.strings.len() as u16;
                    self.index.insert(s.clone(), id);
                    self.strings.push(s);
                    id
                }
            })
            .collect()
    }
}

pub struct UnitRecord {
    pub guid: Arc<str>,
    pub name_id: u16,
    pub kind: UnitKind,
    pub owner_id: Option<u32>,
}

/// GUID -> unit-instance table. Every unique spawn instance gets its own
/// entry even when it shares a name with another instance (two "Timber
/// Wolf" spawns have different GUIDs) -- `docs/planning.md`'s two-level
/// unit interning design.
#[derive(Default)]
pub struct GuidTable {
    index: FxHashMap<Arc<str>, u32>,
    records: Vec<UnitRecord>,
}

impl GuidTable {
    /// Interns `guid`. If already known, updates its record's `owner_id`
    /// when a richer sighting supplies one (advanced-params `ownerGUID`
    /// isn't present on every line that mentions a given unit).
    pub fn intern(&mut self, guid: &str, name_id: u16, owner_id: Option<u32>) -> u32 {
        if let Some(&id) = self.index.get(guid) {
            if owner_id.is_some() {
                self.records[id as usize].owner_id = owner_id;
            }
            return id;
        }
        assert!(
            self.records.len() < u32::MAX as usize,
            "GuidTable overflow: more than u32::MAX-1 distinct units in one log"
        );
        let id = self.records.len() as u32;
        let arc: Arc<str> = Arc::from(guid);
        let kind = UnitKind::from_guid(guid);
        self.index.insert(arc.clone(), id);
        self.records.push(UnitRecord {
            guid: arc,
            name_id,
            kind,
            owner_id,
        });
        id
    }

    pub fn get(&self, id: u32) -> &UnitRecord {
        &self.records[id as usize]
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn iter(&self) -> impl Iterator<Item = &UnitRecord> {
        self.records.iter()
    }

    /// Merges `other` into `self`. `name_remap` is `other`'s already-merged
    /// string-id remap (name ids must be global by the time a `UnitRecord`
    /// lands in the merged table). `owner_id` is self-referential within
    /// `other` (a pet's owner is itself a `GuidTable` entry, possibly
    /// inserted later in file order than the pet) so it's fixed up in a
    /// second pass once every local id in `other` has a known global id.
    pub fn merge(&mut self, other: GuidTable, name_remap: &[u16]) -> Vec<u32> {
        let mut remap = Vec::with_capacity(other.records.len());
        for rec in &other.records {
            if let Some(&id) = self.index.get(&*rec.guid) {
                remap.push(id);
            } else {
                assert!(
                    self.records.len() < u32::MAX as usize,
                    "GuidTable overflow: more than u32::MAX-1 distinct units in one log"
                );
                let id = self.records.len() as u32;
                self.index.insert(rec.guid.clone(), id);
                self.records.push(UnitRecord {
                    guid: rec.guid.clone(),
                    name_id: name_remap[rec.name_id as usize],
                    kind: rec.kind,
                    owner_id: None, // fixed up below
                });
                remap.push(id);
            }
        }
        for (local_id, rec) in other.records.iter().enumerate() {
            if let Some(local_owner) = rec.owner_id {
                let global_id = remap[local_id];
                let global_owner = remap[local_owner as usize];
                self.records[global_id as usize]
                    .owner_id
                    .get_or_insert(global_owner);
            }
        }
        remap
    }
}

pub struct SpellRecord {
    pub spell_id: u32,
    pub name_id: u16,
    /// Spell-school bitmask (`docs/combat-log-format.md` §9.1). Only 7
    /// base bits are documented, but this is stored as u32 rather than u8
    /// -- guard the assumption rather than hope no wider combination ever
    /// appears in a real log.
    pub school: u32,
}

/// Real (Blizzard) spellId -> dense local index. The real id is sparse
/// (six digits, mostly unused) so it's a `HashMap` key, never used
/// directly as an array index.
#[derive(Default)]
pub struct SpellTable {
    index: FxHashMap<u32, u16>,
    records: Vec<SpellRecord>,
}

impl SpellTable {
    pub fn intern(&mut self, spell_id: u32, name_id: u16, school: u32) -> u16 {
        if let Some(&id) = self.index.get(&spell_id) {
            return id;
        }
        assert!(
            self.records.len() < u16::MAX as usize,
            "SpellTable overflow: more than 65535 distinct spells in one log"
        );
        let id = self.records.len() as u16;
        self.index.insert(spell_id, id);
        self.records.push(SpellRecord {
            spell_id,
            name_id,
            school,
        });
        id
    }

    pub fn get(&self, id: u16) -> &SpellRecord {
        &self.records[id as usize]
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn iter(&self) -> impl Iterator<Item = &SpellRecord> {
        self.records.iter()
    }

    pub fn merge(&mut self, other: SpellTable, name_remap: &[u16]) -> Vec<u16> {
        other
            .records
            .into_iter()
            .map(|rec| self.intern(rec.spell_id, name_remap[rec.name_id as usize], rec.school))
            .collect()
    }
}

pub struct ZoneRecord {
    pub map_id: u32,
    pub name_id: u16,
}

/// `uiMapID` -> zone-name table (`ZONE_CHANGE`/`MAP_CHANGE` lines).
#[derive(Default)]
pub struct ZoneTable {
    index: FxHashMap<u32, u16>,
    records: Vec<ZoneRecord>,
}

impl ZoneTable {
    pub fn intern(&mut self, map_id: u32, name_id: u16) -> u16 {
        if let Some(&id) = self.index.get(&map_id) {
            return id;
        }
        assert!(
            self.records.len() < u16::MAX as usize,
            "ZoneTable overflow: more than 65535 distinct zones in one log"
        );
        let id = self.records.len() as u16;
        self.index.insert(map_id, id);
        self.records.push(ZoneRecord { map_id, name_id });
        id
    }

    pub fn get(&self, id: u16) -> &ZoneRecord {
        &self.records[id as usize]
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn iter(&self) -> impl Iterator<Item = &ZoneRecord> {
        self.records.iter()
    }

    pub fn merge(&mut self, other: ZoneTable, name_remap: &[u16]) -> Vec<u16> {
        other
            .records
            .into_iter()
            .map(|rec| self.intern(rec.map_id, name_remap[rec.name_id as usize]))
            .collect()
    }
}

/// The four intern tables bundled together -- one instance per rayon
/// chunk during parsing (fully independent, zero contention), one more
/// instance as the running global merge target.
#[derive(Default)]
pub struct InternTables {
    pub strings: StringTable,
    pub guids: GuidTable,
    pub spells: SpellTable,
    pub zones: ZoneTable,
}

/// Local -> global id remaps produced by one [`InternTables::merge`] call,
/// one vec per table. The caller uses these to rewrite a chunk's
/// already-parsed `EventStore` columns from chunk-local ids to global ids.
pub struct InternRemap {
    pub strings: Vec<u16>,
    pub guids: Vec<u32>,
    pub spells: Vec<u16>,
    pub zones: Vec<u16>,
}

impl InternTables {
    /// Merges `other` (a completed chunk-local table set) into `self`,
    /// growing `self` toward the final global table set. Order matters:
    /// strings are merged first since guid/spell/zone records reference
    /// string ids that must already be global by the time they land.
    pub fn merge(&mut self, other: InternTables) -> InternRemap {
        let strings = self.strings.merge(other.strings);
        let guids = self.guids.merge(other.guids, &strings);
        let spells = self.spells.merge(other.spells, &strings);
        let zones = self.zones.merge(other.zones, &strings);
        InternRemap {
            strings,
            guids,
            spells,
            zones,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unit_kind_from_guid_prefixes() {
        assert_eq!(UnitKind::from_guid("Player-1-1"), UnitKind::Player);
        assert_eq!(UnitKind::from_guid("Creature-0-1-1-1-1-1"), UnitKind::Creature);
        assert_eq!(UnitKind::from_guid("Pet-0-1-1-1-1-1"), UnitKind::Pet);
        assert_eq!(UnitKind::from_guid("0000000000000000"), UnitKind::None);
        assert_eq!(UnitKind::from_guid("IMMUNE"), UnitKind::Other);
        assert_eq!(UnitKind::from_guid("nil"), UnitKind::Other);
    }

    #[test]
    fn string_table_dedupes_exact_matches() {
        let mut t = StringTable::default();
        let a = t.intern("Rotmire");
        let b = t.intern("Rotmire");
        let c = t.intern("Sporefall");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(t.len(), 2);
        assert_eq!(t.get(a), "Rotmire");
    }

    #[test]
    fn same_guid_gets_same_unit_id() {
        let mut strings = StringTable::default();
        let mut guids = GuidTable::default();
        let name = strings.intern("Bob");
        let a = guids.intern("Player-1-1", name, None);
        let b = guids.intern("Player-1-1", name, None);
        assert_eq!(a, b);
        assert_eq!(guids.len(), 1);
    }

    #[test]
    fn different_guids_sharing_a_name_get_different_unit_ids() {
        // Two "Timber Wolf" spawns: same display name, different unit
        // instances -- the whole point of the two-level intern design.
        let mut strings = StringTable::default();
        let mut guids = GuidTable::default();
        let name = strings.intern("Timber Wolf");
        let a = guids.intern("Creature-0-1-1-1-1-0000000001", name, None);
        let b = guids.intern("Creature-0-1-1-1-1-0000000002", name, None);
        assert_ne!(a, b);
        assert_eq!(guids.get(a).name_id, guids.get(b).name_id);
    }

    #[test]
    fn owner_id_is_set_on_a_later_sighting_without_touching_name() {
        let mut strings = StringTable::default();
        let mut guids = GuidTable::default();
        let pet_name = strings.intern("Pet");
        let owner_name = strings.intern("Owner");
        let pet = guids.intern("Pet-0-1-1-1-1-1", pet_name, None);
        assert_eq!(guids.get(pet).owner_id, None);

        let owner = guids.intern("Player-1-1", owner_name, None);
        // Re-sighting with a placeholder name (as link_owner does in
        // event.rs) must not clobber the name already on record.
        let placeholder = strings.intern("");
        guids.intern("Pet-0-1-1-1-1-1", placeholder, Some(owner));

        assert_eq!(guids.get(pet).owner_id, Some(owner));
        assert_eq!(guids.get(pet).name_id, pet_name);
    }

    #[test]
    fn spell_table_dedupes_by_real_spell_id() {
        let mut t = SpellTable::default();
        let a = t.intern(589, 0, 0x20);
        let b = t.intern(589, 0, 0x20);
        assert_eq!(a, b);
        assert_eq!(t.len(), 1);
        assert_eq!(t.get(a).school, 0x20);
    }

    #[test]
    fn zone_table_dedupes_by_map_id() {
        let mut t = ZoneTable::default();
        let a = t.intern(2427, 0);
        let b = t.intern(2427, 0);
        assert_eq!(a, b);
        assert_eq!(t.len(), 1);
    }

    #[test]
    fn merge_combines_chunk_local_tables_with_globally_consistent_ids() {
        let mut global = InternTables::default();

        let mut chunk_a = InternTables::default();
        let name_a = chunk_a.strings.intern("Shared Name");
        let unit_a = chunk_a.guids.intern("Player-1-1", name_a, None);

        let mut chunk_b = InternTables::default();
        let name_b = chunk_b.strings.intern("Shared Name");
        // Same GUID as chunk_a (e.g. the same player mentioned in both
        // chunks) plus one genuinely new unit that happens to share a name.
        let unit_b_same = chunk_b.guids.intern("Player-1-1", name_b, None);
        let unit_b_new = chunk_b.guids.intern("Player-2-2", name_b, None);

        let remap_a = global.merge(chunk_a);
        let remap_b = global.merge(chunk_b);

        let global_a = remap_a.guids[unit_a as usize];
        let global_b_same = remap_b.guids[unit_b_same as usize];
        let global_b_new = remap_b.guids[unit_b_new as usize];

        assert_eq!(
            global_a, global_b_same,
            "the same GUID sighted in two different chunks must merge to one global id"
        );
        assert_ne!(global_b_same, global_b_new);
        assert_eq!(
            global.guids.get(global_b_same).name_id,
            global.guids.get(global_b_new).name_id,
            "two units sharing a display name should share one interned string id"
        );
        assert_eq!(global.strings.len(), 1);
        assert_eq!(global.guids.len(), 2);
    }

    #[test]
    fn merge_fixes_up_owner_link_when_owner_local_id_comes_after_pet() {
        let mut global = InternTables::default();
        let mut chunk = InternTables::default();
        let name = chunk.strings.intern("x");

        // Intern the pet first (lower local id), then its owner (higher
        // local id) -- the pet's owner_id references a local id that
        // doesn't exist yet at the moment the pet record is created.
        let pet = chunk.guids.intern("Pet-0-1-1-1-1-1", name, None);
        let owner = chunk.guids.intern("Player-1-1", name, None);
        chunk.guids.intern("Pet-0-1-1-1-1-1", name, Some(owner));

        let remap = global.merge(chunk);
        let global_pet = remap.guids[pet as usize];
        let global_owner = remap.guids[owner as usize];

        assert_eq!(global.guids.get(global_pet).owner_id, Some(global_owner));
    }
}
