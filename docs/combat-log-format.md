# WoW Advanced Combat Log — Format Reference

Fetched-and-frozen snapshot pulled from [warcraft.wiki.gg](https://warcraft.wiki.gg/wiki/Combat_Log) on **2026-08-30**. Not a live source — if field layouts change in a future patch, re-derive from the wiki (primarily [`Event:COMBAT_LOG_EVENT`](https://warcraft.wiki.gg/wiki/Event:COMBAT_LOG_EVENT), [`GUID`](https://warcraft.wiki.gg/wiki/GUID), [`UnitFlag`](https://warcraft.wiki.gg/wiki/UnitFlag), [`RaidFlag`](https://warcraft.wiki.gg/wiki/RaidFlag), [`Enum.PowerType`](https://warcraft.wiki.gg/wiki/Enum.PowerType)) rather than trusting this file blindly. This doc is written for a hand-rolled bytewise tokenizer — field order and type over prose.

**Also cross-checked against a real patch 12.0.7 log on 2026-08-30** (`src-tauri/tests/fixtures/`, gitignored, not committed). The wiki turned out to be wrong or incomplete in several concrete, load-bearing ways for current retail — timestamps carry a year+timezone the wiki says don't exist, the advanced-params block is 19 fields not 17, and a few suffix shapes differ from documented. Every place this happened is marked **RESOLVED**, **CORRECTED**, or **NEW** inline, with the old wiki claim kept alongside for context. See §10's closing note for the verification method. Treat wiki-only (unmarked) sections with correspondingly less confidence than the verified ones.

Two representations exist and are easy to conflate:
- **The Lua `CombatLogGetCurrentEventInfo()` payload** — what addons receive in-game. Includes a `hideCaster` boolean not present in the log file, and flags as decimal numbers.
- **The `WoWCombatLog.txt` file** (what this doc is about) — written by `/combatlog` or `LoggingCombat(true)`. No `hideCaster` field. Flags are `0x`-prefixed hex. This is the format parseomatic reads.

Combat logging itself (the slash command / file writer) is unaffected by Patch 12.0.0 removing addon access to the `COMBAT_LOG_EVENT` Lua event — the two are different mechanisms.

### Scope: modern retail only (patch 12.x, Midnight)

**parseomatic targets current retail WoW, patch 12.x ("Midnight") and later, only.** Classic Era, BC Classic, Wrath Classic, Cataclysm Classic, and MoP Classic are explicitly out of scope for now — the parser doesn't need to handle their format quirks (e.g. `spellId` sometimes returning `0` on vanilla Classic Era, the `PROJECT_ID` variants below, or the pre-2.4.0 GUID format).

Classic-variant and pre-current-patch details are **kept in this doc only as historical/patch-boundary context** — useful for understanding *why* a field looks the way it does, or as a pointer if classic support is added later — not as things the current parser must implement. Concretely, treat the following as **legacy/informational only, not required**:
- The `PROJECT_ID` table in §1 (parseomatic only ever sees `1` / `WOW_PROJECT_MAINLINE`, but the table is left in for context).
- The pre-9.0.1 Chromatic spell-school value (`124`, superseded by `62`) in §9.1.
- The pre-5.0.4 ALL-CAPS environmental-type strings in §9.5.
- Any patch-history bullet phrased as "added in patch X.Y" where X < 11 — informational provenance, not a compatibility target.

Everything else in this doc — base params, flags, GUID formats, the advanced-log block, prefix/suffix tables, COMBATANT_INFO, standalone events, current enum values — is the **current, must-implement** target and reflects retail as of patch 12.x per the wiki snapshot date above.

---

## 1. File structure

**Line shape:** `timestamp<space><space>field1,field2,field3,...`

- Timestamp is prefixed before the first comma, separated from the first field by **two spaces** (confirmed against a real patch 12.0.7 fixture log, not just the wiki's examples — see `src-tauri/tests/fixtures/`).
- Fields after the timestamp are comma-separated.
- String fields (names, spell names, zone names, free text) are wrapped in **double quotes**: `"Xiaohuli-DefiasBrotherhood"`, `"Smite"`. Numbers, hex flags, and GUIDs are **not** quoted.
- The literal unquoted word `nil` appears where a value is absent (e.g. a dead unit's `sourceName`). **Boolean-typed suffix fields render as the bare word `nil` or a bare digit (`0`/`1`), not `true`/`false`** — confirmed against the fixture (e.g. `SWING_DAMAGE`'s trailing `critical,glancing,crushing` fields showed as `nil,nil,nil` or `1,nil,nil`, never the word `true`/`false`). The wiki's `true`/`false` examples are from the Lua payload representation, not the file.
- The zero/null GUID sentinel is **16 zero hex digits with no type prefix**: `0000000000000000`.

### Timestamp format — CORRECTED from real-log verification

**The wiki's documented format is wrong/outdated for current retail.** Confirmed against the fixture log (patch 12.0.7, `src-tauri/tests/fixtures/`):

```
7/25/2026 20:52:35.870-6  COMBAT_LOG_VERSION,22,ADVANCED_LOG_ENABLED,0,BUILD_VERSION,12.0.7,PROJECT_ID,1
7/25/2026 21:09:13.869-6  UNIT_DIED,...
```

Format is **`M/D/YYYY HH:MM:SS.mmm-TZ`** — e.g. `7/25/2026 20:52:35.870-6`:
- **The year IS present** (`2026`), contrary to the wiki's documentation (which the original pass of this doc trusted). This resolves the doc's own previously-flagged "no year, must infer from file mtime" concern — patch 12.x's file format doesn't need that workaround at all.
- **A timezone offset suffix is present** (`-6`, i.e. UTC−6) with no separator before it, directly appended to the seconds/milliseconds. Only one offset value (`-6`) was observed in this single-session fixture, so sign/format for other offsets (e.g. positive, sub-hour) is inferred, not confirmed — a robust parser should handle a leading `+`/`-` and 1-2 digit hour count defensively.
- Whether this is genuinely new in patch 12.x or just an older-than-the-wiki-thought change is unknown — treat "year + tz present" as the current-retail fact regardless of when it landed, per this doc's retail-only scope.

### Header line

Written once, at the start of logging (i.e. top of file, or wherever `/combatlog` was toggled on mid-session):

```
11/21 12:01:34.071  COMBAT_LOG_VERSION,19,ADVANCED_LOG_ENABLED,1,BUILD_VERSION,9.1.5,PROJECT_ID,1
7/25/2026 20:52:35.870-6  COMBAT_LOG_VERSION,22,ADVANCED_LOG_ENABLED,0,BUILD_VERSION,12.0.7,PROJECT_ID,1
```
(first line: wiki's documented example, 9.1.5. second line: **confirmed real patch 12.0.7 fixture** — `src-tauri/tests/fixtures/`.)

| Field | Type | Notes |
|---|---|---|
| `COMBAT_LOG_VERSION` | literal string | event/line tag |
| version | number | log format version. Wiki documents `19` (client 9.1.5); **confirmed `22` on retail patch 12.0.7** via the fixture log. Don't hardcode either as an accept/reject gate — parse based on actual field count, not this number. |
| `ADVANCED_LOG_ENABLED` | literal string | tag preceding the next value |
| advanced flag | 0 or 1 | whether `advancedCombatLogging` CVar was on when logging started |
| `BUILD_VERSION` | literal string | tag |
| build version | string, e.g. `9.1.5` | client build |
| `PROJECT_ID` | literal string | tag |
| project id | number | see PROJECT_ID table below |

**PROJECT_ID values** (from `WOW_PROJECT_ID`):

| Value | Constant | Product |
|---|---|---|
| 1 | `WOW_PROJECT_MAINLINE` | Retail |
| 2 | `WOW_PROJECT_CLASSIC` | Classic Era / 20th Anniversary |
| 3 | `WOW_PROJECT_WOWLABS` | Plunderstorm |
| 5 | `WOW_PROJECT_BURNING_CRUSADE_CLASSIC` | BC Classic / Anniversary |
| 11 | `WOW_PROJECT_WRATH_CLASSIC` | Wrath Classic |
| 14 | `WOW_PROJECT_CATACLYSM_CLASSIC` | Cataclysm Classic |
| 19 | `WOW_PROJECT_MISTS_CLASSIC` | Mists of Pandaria Classic |

A single log file's `ADVANCED_LOG_ENABLED` value is a **hint at parse time, not a per-line guarantee — confirmed false in practice, not just theoretical.** The fixture log's header says `ADVANCED_LOG_ENABLED,0` on *every* occurrence (checked all 4 header lines in the file, all say `0`), yet `SPELL_DAMAGE`/`SWING_DAMAGE`/`SPELL_HEAL`/`SPELL_ENERGIZE`/`SPELL_DRAIN`/`SPELL_CAST_SUCCESS`/etc. lines throughout the same file all carry the full advanced-params block regardless (see §5). Whether patch 12.x always writes the block now (independent of the CVar, likely because the built-in damage-meter replacement needs it after the addon-API lockout) or this specific client had a stale/irrelevant header value is unconfirmed — but either way, **the header cannot be trusted, full stop.** Detect advanced-vs-basic per line by field count, unconditionally.

> **Resolved (2026-08-30) via real fixture log** (`src-tauri/tests/fixtures/WoWCombatLog-072526_205235.txt`, patch 12.0.7): `COMBAT_LOG_VERSION` is **22** on current retail (wiki only documents `19` as of client 9.1.5). The wiki still doesn't document this number for patch 12.x as of the last check, but it's no longer a gap — we have a confirmed real value now. As above, don't hardcode either number as an accept/reject gate.

---

## 2. Base event params (every event line)

Every combat log line (aside from the handful of truly standalone lines in §8) starts with these 9 comma-fields immediately after the timestamp:

| # | Field | Type | Notes |
|---|---|---|---|
| 1 | subevent | string, unquoted | e.g. `SPELL_DAMAGE`, `SWING_MISSED` |
| 2 | sourceGUID | string, unquoted | see §3 |
| 3 | sourceName | string, quoted (or `nil`) | may carry a `-RealmName` suffix (see §9) |
| 4 | sourceFlags | hex, `0x`-prefixed | see §4 |
| 5 | sourceRaidFlags | hex, `0x`-prefixed | see §4 |
| 6 | destGUID | string, unquoted | see §3 |
| 7 | destName | string, quoted (or `nil`) | |
| 8 | destFlags | hex, `0x`-prefixed | |
| 9 | destRaidFlags | hex, `0x`-prefixed | |

This is **9 fields**, not 11 — the Lua API's `timestamp` and `hideCaster` params are not written to the file (timestamp is the line's leading prefix; `hideCaster` doesn't exist in the file at all).

Patch history: `sourceRaidFlags`/`destRaidFlags` added 4.2.0 (prior logs won't have them — irrelevant for modern parsing but explains old sample lines found online with fewer fields).

---

## 3. Flag bitfields

### 3.1 sourceFlags / destFlags — `COMBATLOG_OBJECT_*`

Four mutually-exclusive-within-category bit groups, packed into one 32-bit value, plus non-exclusive special-case bits:

| Constant | Hex | Category |
|---|---|---|
| `COMBATLOG_OBJECT_AFFILIATION_MINE` | `0x00000001` | Affiliation |
| `COMBATLOG_OBJECT_AFFILIATION_PARTY` | `0x00000002` | Affiliation |
| `COMBATLOG_OBJECT_AFFILIATION_RAID` | `0x00000004` | Affiliation |
| `COMBATLOG_OBJECT_AFFILIATION_OUTSIDER` | `0x00000008` | Affiliation |
| `COMBATLOG_OBJECT_AFFILIATION_MASK` | `0x0000000F` | mask |
| `COMBATLOG_OBJECT_REACTION_FRIENDLY` | `0x00000010` | Reaction |
| `COMBATLOG_OBJECT_REACTION_NEUTRAL` | `0x00000020` | Reaction |
| `COMBATLOG_OBJECT_REACTION_HOSTILE` | `0x00000040` | Reaction |
| `COMBATLOG_OBJECT_REACTION_MASK` | `0x000000F0` | mask |
| `COMBATLOG_OBJECT_CONTROL_PLAYER` | `0x00000100` | Controller (player-controlled, incl. pets) |
| `COMBATLOG_OBJECT_CONTROL_NPC` | `0x00000200` | Controller |
| `COMBATLOG_OBJECT_CONTROL_MASK` | `0x00000300` | mask |
| `COMBATLOG_OBJECT_TYPE_PLAYER` | `0x00000400` | Type |
| `COMBATLOG_OBJECT_TYPE_NPC` | `0x00000800` | Type |
| `COMBATLOG_OBJECT_TYPE_PET` | `0x00001000` | Type |
| `COMBATLOG_OBJECT_TYPE_GUARDIAN` | `0x00002000` | Type |
| `COMBATLOG_OBJECT_TYPE_OBJECT` | `0x00004000` | Type (traps, totems, etc.) |
| `COMBATLOG_OBJECT_TYPE_MASK` | `0x0000FC00` | mask |
| `COMBATLOG_OBJECT_TARGET` | `0x00010000` | Special (non-exclusive): unit is your target |
| `COMBATLOG_OBJECT_FOCUS` | `0x00020000` | Special: is your focus |
| `COMBATLOG_OBJECT_MAINTANK` | `0x00040000` | Special: has main tank role |
| `COMBATLOG_OBJECT_MAINASSIST` | `0x00080000` | Special: has main assist role |
| `COMBATLOG_OBJECT_NONE` | `0x80000000` | Special: unit doesn't exist (no GUID/name) |
| `COMBATLOG_OBJECT_SPECIAL_MASK` | `0xFFFF0000` | mask |

A unit picks exactly one bit from Affiliation, Reaction, Controller, and Type each (four independent single-bit selections), plus zero or more Special bits. Example: `0x10A48` = TARGET + TYPE_NPC + CONTROL_NPC + REACTION_HOSTILE + AFFILIATION_OUTSIDER.

### 3.2 sourceRaidFlags / destRaidFlags — raid target markers

| Icon | Constant | Hex |
|---|---|---|
| Star | `COMBATLOG_OBJECT_RAIDTARGET1` | `0x1` |
| Circle | `COMBATLOG_OBJECT_RAIDTARGET2` | `0x2` |
| Diamond | `COMBATLOG_OBJECT_RAIDTARGET3` | `0x4` |
| Triangle | `COMBATLOG_OBJECT_RAIDTARGET4` | `0x8` |
| Moon | `COMBATLOG_OBJECT_RAIDTARGET5` | `0x10` |
| Square | `COMBATLOG_OBJECT_RAIDTARGET6` | `0x20` |
| Cross | `COMBATLOG_OBJECT_RAIDTARGET7` | `0x40` |
| Skull | `COMBATLOG_OBJECT_RAIDTARGET8` | `0x80` |
| — | `COMBATLOG_OBJECT_RAIDTARGET_MASK` | `0xFF` |

**Gotcha:** as of Patch 11.1.7, Blizzard packed additional (undocumented on the wiki) info into the upper bits of raidFlags. Always mask with `RAIDTARGET_MASK` (`0xFF`) before treating the value as a marker index — don't compare the raw field directly against the 8 marker constants anymore.

---

## 4. GUID formats

All entity references (`sourceGUID`, `destGUID`, `infoGUID`, `ownerGUID`, COMBATANT_INFO's `playerGUID`, interesting-aura caster GUIDs, etc.) use one hyphen-delimited string format per entity type. Directly relevant to parseomatic's interning design — the numeric fields embedded in these GUIDs are the actual stable identity, not the display name.

| Prefix | Format | Field meanings | Example |
|---|---|---|---|
| `Player` | `Player-serverID-playerUID` | serverID: realm id; playerUID: permanent per-character id, survives forever, unique even cross-realm | `Player-970-0002FD64` |
| `Creature` | `Creature-0-serverID-instanceID-zoneUID-npcID-spawnUID` | npcID (field 6) = creature template id — this is what's shared across all spawns of "the same" mob; spawnUID's low 23 bits = spawn-time Unix epoch offset mod 2²³, higher bits = a spawn counter for collisions within the same second | `Creature-0-1465-0-2105-448-000043F59F` |
| `Pet` | `Pet-0-serverID-instanceID-zoneUID-npcID-spawnUID` | same shape as Creature, but spawnUID's low 32 bits are a unique id (Player-GUID-like) and the upper 8 bits are a wrapping "times summoned" counter. **Pets get a new GUID every summon** — do not treat pet GUID as a stable per-character-pet identity, key pet ownership off `ownerGUID` (advanced params) instead | `Pet-0-4234-0-6610-165189-0202F859E9` |
| `Vehicle` | `Vehicle-0-serverID-instanceID-zoneUID-npcID-spawnUID` | same shape/semantics as Creature | |
| `GameObject` | `GameObject-0-serverID-instanceID-zoneUID-objectID-spawnUID` | same shape as Creature; traps, portals, etc. | |
| `Cast` | `Cast-type-serverID-instanceID-zoneUID-spellID-castUID` | `type`: 2 = local-client-only (failed cast that never reached server; serverID/instanceID/zoneUID are 0 and castUID is a locally-incrementing int), 3 = active-ability cast (most casts), 4 = passive effect, 13 = single DoT/HoT tick (e.g. Divine Hymn), 16 = single multi-tick-attack tick (e.g. Flurry). For types 3/4/13/16, castUID's low 23 bits = Unix epoch mod 2²³, higher bits = incrementing counter within the same second | `Cast-3-4170-0-8-84714-000CB03025` |
| `Item` | `Item-serverID-0-spawnUID` | | `Item-1598-0-4000000A369860E1` |
| `BattlePet` | `BattlePet-0-ID` | aka petID in some APIs; **not** the same as speciesID | `BattlePet-0-00000338F951` |
| `Vignette` | `Vignette-0-serverID-instanceID-zoneUID-vignetteID-spawnUID` | rare mob / treasure markers | `Vignette-0-970-1116-7-340-0017CAE465` |
| `BNetAccount` | `BNetAccount-0-accountID` | accountID is hex | `BNetAccount-0-000000000016` |
| `ClientActor` | `ClientActor-x-yy-zzzz` | client-simulated-only NPC, not server-authoritative — unlikely to appear in combat logs but documented for completeness | `ClientActor-3-5-1340` |
| (none) | `0000000000000000` | 16 zero hex digits, no type prefix at all — sentinel for "no unit" (paired with `COMBATLOG_OBJECT_NONE` flag and `nil` name) | |

**GUID lifecycle rules** (load-bearing for the interning design):
- A Creature/Vehicle/GameObject keeps one GUID from spawn to death/despawn; respawn = new GUID. Don't assume "same npcID → same combatant" across a fight if there are multiple simultaneous adds — dedupe by full GUID, group by npcID for "which mob type."
- Pets get a new GUID every summon (see above).
- Players keep their GUID forever.
- Monster/pet GUIDs **can be recycled** after a server/instance restart — full GUID uniqueness is not eternal for non-player entities, only within one continuous server session.

---

## 5. Advanced combat log params block — CORRECTED from real-log verification, 19 fields not 17

**The wiki documents 17 fields. The real patch-12.0.7 fixture confirms 19.** This was cross-checked across 9 different event types (`SPELL_DAMAGE`, `SWING_DAMAGE`, `SWING_DAMAGE_LANDED`, `SPELL_HEAL`, `SPELL_PERIODIC_DAMAGE`, `RANGE_DAMAGE`, `SPELL_ENERGIZE`, `SPELL_DRAIN`, `SPELL_CAST_SUCCESS`) by anchoring on unambiguous known-good values — `uiMapID` matching a `MAP_CHANGE` line's map ID (`2427`, "Sporefall") earlier in the same file, `facing` staying in `[0, 2π)`, and `level`/`itemLevel` landing in plausible ranges — so the field count is solid even though 2 of the 19 fields' exact semantics are not.

The block is inserted between the prefix params and the suffix params. **Presence is not gated by the file header's `ADVANCED_LOG_ENABLED` value** (see §1) — detect per line by field count, always, no exceptions.

| # | Field | Type | Example (from fixture) | Notes |
|---|---|---|---|---|
| 1 | infoGUID | GUID string | `Creature-0-4227-1592-26103-238693-0000657958` | GUID of the unit these advanced params describe. For `SWING_DAMAGE`/`SPELL_DAMAGE` this was the **dest** in every fixture sample; wiki's "source for SWING_DAMAGE" claim wasn't reproduced — verify further before trusting either rule universally |
| 2 | ownerGUID | GUID string or zero-GUID | `0000000000000000` | owner GUID for pets/minions |
| 3 | currentHP | number | `608368408` | modern retail HP pools are large (post-squish-removal numbers) |
| 4 | maxHP | number | `608376450` | |
| 5 | attackPower | number | `0` | |
| 6 | spellPower | number | `0` | |
| 7 | armor | number | `1470` | |
| 8 | absorb | number | `0` | currently-applied absorb amount |
| 9 | powerType | `Enum.PowerType` | `0` | see §9.2. **Confirmed present**, but see the 2-new-fields note below — its exact position within the now-6-field power region is not fully pinned down |
| 10 | *(new, unidentified)* | number | `0` | **Not in the wiki.** One of 2 new fields inserted somewhere in the power-info region (old doc had 4 fields here: powerType/currentPower/maxPower/powerCost; fixture has 6). Seen values: `0` in most samples, but `3` in one `SPELL_ENERGIZE` example alongside a plausible Energy current/max pair — plausibly a second `powerType`-like slot, unconfirmed |
| 11 | *(new, unidentified)* | number | `0` | second new field, same caveat |
| 12 | currentPower | number | `0` | inferred from position + plausible values (e.g. `120` alongside `maxPower=120` for what's plausibly Energy) — not 100% certain this is the right slot vs. field 10/11 |
| 13 | maxPower | number | `3` | see above caveat |
| 14 | powerCost | number | `0` | power required for the ability that triggered this line |
| 15 | positionX | number | `3903.18` | world position — **high confidence**, matches known coordinate scale |
| 16 | positionY | number | `-8675.71` | |
| 17 | uiMapID | number | `2427` | **confirmed** — matches this fixture's own `MAP_CHANGE,2427,"Sporefall",...` line |
| 18 | facing | number | `1.1315` | radians, `[0, 2π)` — confirmed in range across all samples |
| 19 | level | number | `93` | NPC level, or **item level** for players (e.g. `291`, `285` seen for player targets — too high to be character level, consistent with item level) |

**Fields 9-13 (the power-info region) are the one part of this block not fully resolved.** The count (6 fields where the wiki's old doc had 4) is solid; which 2 are new and what they mean is not. Recommendation: parse this region as "6 raw numeric fields, positions 9-14 inclusive" without assigning semantic names to all of them until a wider variety of class/power-type samples (Rogue Energy+Combo Points, Death Knight Runes, dual-resource specs) can be checked — don't hardcode field-10/11 semantics from this doc.

**Old "multi-power-type pipe-delimited" quirk (wiki-sourced) was NOT observed in the fixture** — every power-region value in every sample was a plain scalar, no `|` characters found. Either this patch replaced that mechanism with the 2 new dedicated fields above (plausible — dedicated fields are a cleaner design than packing multiple values into one), or it just didn't come up in this particular log's spell mix. Don't assume `|`-splitting is required for patch 12.x, but don't rule it out either — a defensive parser should still handle a `|` if one shows up.

---

## 6. Prefix categories

Inserted directly after the 9 base fields, before the (optional) 19 advanced fields (§5), before the suffix fields.

| Prefix | Extra params (in order) | Notes |
|---|---|---|
| `SWING` | *(none)* | |
| `RANGE` | spellId, spellName, spellSchool | |
| `SPELL` | spellId, spellName, spellSchool | covers instant, channeled, and DoT/HoT *cast* events — periodic *damage/heal ticks* use `SPELL_PERIODIC` instead |
| `SPELL_PERIODIC` | spellId, spellName, spellSchool | only the periodic **tick** effects (damage/heal) use this; the cast itself is still `SPELL_CAST_*` |
| `SPELL_BUILDING` | spellId, spellName, spellSchool | damage/healing affecting destructible buildings (WotLK+) |
| `ENVIRONMENTAL` | environmentalType | see §9.5 for the value set |

`spellSchool` is the bitmask from §9.1, not necessarily a single-bit value (multi-school spells set multiple bits).

---

## 7. Suffix categories

Field numbering below is relative — "1st suffix param" is the first field after the prefix params (or after the advanced block, if present).

| Suffix | Fields (in order) |
|---|---|
| `_DAMAGE` | amount, **baseAmount**, overkill, school, resisted, blocked, absorbed, **critical**, glancing, crushing — **10 fields**, but the composition below the count is `amount, baseAmount, overkill, school, …`, *not* the wiki's `amount, overkill, school, …` (there is no `isOffHand`; `baseAmount` — pre-mitigation — sits at index 1). Verified across two 2026 captures. `SPELL_DAMAGE`/`SPELL_PERIODIC_DAMAGE`/`RANGE_DAMAGE` (spell-prefixed) then append an **11th field, `hitType`** (`ST`/`AOE`); `SWING_DAMAGE`/`SWING_DAMAGE_LANDED` do not. **`critical` is best read anchored from the end** — it is the 4th-from-last field on spell-prefixed lines (`…,critical,glancing,crushing,hitType`) and 3rd-from-last on `SWING_*` — since the leading fields have drifted between the wiki and retail and could drift again (`parser::event::extract_damage_heal`). |
| `_MISSED` | missType, isOffHand, amountMissed, critical — **confirmed variable beyond this** for at least `missType=ABSORB`, which carried extra numeric fields in the fixture (2 large amount-like values instead of 1). Not fully resolved; don't assume a fixed 4-field suffix for every `missType`. Spell-prefixed `_MISSED` also carries the new trailing `hitType` field |
| `_HEAL` | amount, overhealing, absorbed, critical |
| `_HEAL_ABSORBED` | extraGUID, extraName, extraFlags, extraRaidFlags, extraSpellID, extraSpellName, extraSchool, absorbedAmount, totalAmount *(9 fields — wiki explicitly calls out `totalAmount` as an extra 9th field beyond the base 8)* |
| `_ABSORBED` (`SPELL_ABSORBED`) | see §8 dedicated entry — has its own irregular shape, **and confirmed 1 more field than documented (see §8)** |
| `_ENERGIZE` | amount, overEnergize, powerType, maxPower — **confirmed 4 fields against the fixture** |
| `_DRAIN` | amount, powerType, extraAmount, maxPower — **confirmed 4 fields against the fixture** |
| `_LEECH` | amount, powerType, extraAmount |
| `_INTERRUPT` | extraSpellId, extraSpellName, extraSchool |
| `_DISPEL` | extraSpellId, extraSpellName, extraSchool, auraType |
| `_DISPEL_FAILED` | extraSpellId, extraSpellName, extraSchool |
| `_STOLEN` | extraSpellId, extraSpellName, extraSchool, auraType |
| `_EXTRA_ATTACKS` | amount |
| `_AURA_APPLIED` | auraType, **amount is conditional, not always present** — see resolved-gotcha below |
| `_AURA_APPLIED_DOSE` | auraType, amount *(new stack count, confirmed always present)* |
| `_AURA_REMOVED` | auraType, **amount is conditional, same as `_AURA_APPLIED`** — a stackless-buff example in the fixture carried only `auraType` |
| `_AURA_REMOVED_DOSE` | auraType, amount *(remaining stack count)* |
| `_AURA_REFRESH` | auraType *(no `amount` field — see gotcha below)* |
| `_AURA_BROKEN` | auraType |
| `_AURA_BROKEN_SPELL` | extraSpellId, extraSpellName, extraSchool, auraType |
| `_CAST_START` | *(none)* |
| `_CAST_SUCCESS` | *(none) — confirmed: base9+prefix3+advanced19=31 fields exactly, zero suffix fields* |
| `_CAST_FAILED` | failedType (string — see §9.6) |
| `_INSTAKILL` | unconsciousOnDeath |
| `_DURABILITY_DAMAGE` | *(none)* |
| `_DURABILITY_DAMAGE_ALL` | *(none)* |
| `_CREATE` | *(none)* — objects (traps, portals), as opposed to `_SUMMON` for NPCs |
| `_SUMMON` | *(none)* — NPCs (pets, totems) |
| `_RESURRECT` | *(none)* |
| `_EMPOWER_START` | *(none)* — Dragonflight empowered-spell casts (10.0.0+) |
| `_EMPOWER_END` | empoweredRank |
| `_EMPOWER_INTERRUPT` | empoweredRank |

### Suffix gotchas / irregularities

- **CORRECTED (2026-09) — `_DAMAGE` suffix IS `amount, baseAmount, overkill, school, …`.** The field *count* is 10 (confirmed by `SWING_*` arithmetic), but the earlier "no `baseAmount`" reading was wrong: field 1 is `baseAmount` (pre-mitigation, ≈ or > `amount`), pushing `critical` to index 7, not 6, and there is no trailing `isOffHand`. Verified against `WoWCombatLog-072526_205235.txt` *and* `WoWCombatLog-090326_192352.txt`. The parser had been reading `absorbed` (index 6) as `critical` and so reported essentially zero crits on every log; `extract_damage_heal` now anchors `critical` from the end of the row (4th-from-last with a trailing `hitType`, 3rd-from-last on `SWING_*`), which is stable regardless of leading-field drift. `_HEAL`'s `critical` is likewise read as the last field.
- **NEW, not in the wiki — `hitType` trailing field on spell-prefixed damage/missed lines.** `SPELL_DAMAGE`, `SPELL_PERIODIC_DAMAGE`, `RANGE_DAMAGE`, and `SPELL_MISSED` all carry **one extra field at the very end of the line**, beyond every suffix table above — observed values `ST` (single-target) and `AOE`. Confirmed **absent** on `SWING_DAMAGE`/`SWING_DAMAGE_LANDED` (no spell prefix). This looks like a patch-12.x addition distinguishing single-target vs. AoE hits, useful directly for stats (no need to infer AoE from "many simultaneous hits on different targets" the hard way) — but the wiki doesn't document it at all, so treat the value set (`ST`/`AOE`) as open, not closed, until more samples turn up other values.
- **NEW, unresolved — `SPELL_MISSED` is not a fixed 4-field suffix.** An `missType=IMMUNE` sample matched the documented 4-field shape; a `missType=ABSORB` sample carried 6 fields instead (two large numeric values where the table predicts one `amountMissed`). Likely `missType`-dependent variable arity (similar in spirit to `SPELL_ABSORBED`'s established variable-arity behavior), not pinned down further — don't assume a fixed suffix length for `_MISSED` regardless of `missType`.
- **RESOLVED — `_AURA_APPLIED`/`_AURA_REMOVED`'s `amount` field is conditional, not fixed.** A non-stacking buff (`Efflorescence`) in the fixture produced a bare `auraType` with **no** trailing `amount` (13 total fields: base9+prefix3+auraType1), contradicting the wiki's implied fixed `auraType, amount` shape. `_AURA_APPLIED_DOSE`/`_AURA_REMOVED_DOSE` (the explicit stack-count variants) did always carry both fields. Read: `amount` is present only when the application/removal itself carries a stack-count-relevant value, not universally.
- **`SPELL_AURA_REFRESH` is missing `amount`** — confirmed directly in the fixture (13 fields, same shape as a stackless `_AURA_APPLIED`). Don't assume a fixed 2-field suffix for every `_AURA_*` variant; `_REFRESH` is one exception, stackless `_AURA_APPLIED`/`_AURA_REMOVED` are two more.
- **RESOLVED — boolean encoding.** Confirmed: the file uses the bare word `nil` or a bare digit (`0`/`1`), never the Lua-payload's `true`/`false` words. See §1.
- **`DAMAGE_SPLIT`, `DAMAGE_SHIELD`, `DAMAGE_SHIELD_MISSED`** are not prefix+suffix combinations in the literal sense — they're standalone subevent names that reuse `SPELL` prefix shape + `_DAMAGE`/`_MISSED` suffix shape respectively.
- **`ENCHANT_APPLIED` / `ENCHANT_REMOVED`** are their own subevents (not prefix+suffix composed) with fields: spellName, itemID, itemName — following the base 9 fields directly, no prefix/advanced/suffix composition.

---

## 8. Standalone / special events

These deviate from the base-9 + prefix + [advanced] + suffix composition, or are unique event lines outside the SPELL/SWING/RANGE/ENVIRONMENTAL family.

### ENCOUNTER_START
```
ENCOUNTER_START,encounterID,"encounterName",difficultyID,groupSize,instanceID
ENCOUNTER_START,1146,"Randolph Moloch",1,5,34
```
| # | Field | Type |
|---|---|---|
| 1 | encounterID | number (`DungeonEncounterID`) |
| 2 | encounterName | string, quoted |
| 3 | difficultyID | number |
| 4 | groupSize | number |
| 5 | instanceID | number |

### ENCOUNTER_END
```
ENCOUNTER_END,encounterID,"encounterName",difficultyID,groupSize,success,fightTime
ENCOUNTER_END,2435,"Sylvanas Windrunner",15,16,1,671425
```
| # | Field | Type | Notes |
|---|---|---|---|
| 1 | encounterID | number | |
| 2 | encounterName | string, quoted | |
| 3 | difficultyID | number | |
| 4 | groupSize | number | |
| 5 | success | 0 or 1 | 1 = kill, 0 = wipe |
| 6 | fightTime | number | **milliseconds** |

Note: `instanceID` is present on `ENCOUNTER_START` but not documented as present on `ENCOUNTER_END` — asymmetric field lists, don't assume they mirror each other.

**Both confirmed exactly as documented against the fixture** (`ENCOUNTER_START,3159,"Rotmire",233,23,1592` / `ENCOUNTER_END,3159,"Rotmire",233,23,0,95771`), including the asymmetric field count.

### COMBATANT_INFO

One line per player, emitted immediately after every `ENCOUNTER_START`. Added Patch 7.0.3, format explicitly called out by Blizzard as "subject to change." This is the single largest and most irregular line shape in the log — variable-length nested lists, not a flat field list.

**Not observed in the *original* fixture** (`WoWCombatLog-072526_205235.txt` — `grep -c COMBATANT_INFO` → 0). A later capture, `WoWCombatLog-090326_192352.txt` (local, gitignored), has **418** `COMBATANT_INFO` lines, all 34 top-level fields, uniform shape — enough to pin the patch-12 layout. The wiki-sourced table further below is kept as the pre-Dragonflight reference; **the verified 12.x layout is:**

| slot (0-indexed `raw[]`, `raw[0]` = faction) | content |
|---|---|
| `raw[1 .. B-1]` | **22 numeric stat fields** — `s[0]` Strength, `s[1]` Agility, `s[2]` Stamina, `s[3]` Intellect, `s[4]` Dodge, `s[5]` Parry, `s[6]` Block, `s[7]` reserved (always 0), `s[8..11]` Crit (melee/ranged/spell, equal), `s[11]` Speed, `s[12]` Leech, `s[13..16]` Haste (equal), `s[16]` Avoidance, `s[17]` Mastery, `s[18..21]` Versatility (dmg-done/heal-done/dmg-taken, equal), `s[21]` Armor. (`B` = index of the first `[`/`(` group.) The wiki list drifted +1 in 12.x; this is anchored from *both* ends — primaries from the front, the three equal secondary triples from the back — cross-checked across 19 specs. Parser stores `None` unless it's exactly 22 clean numbers. |
| `raw[B-1]` | **CurrentSpecID** (unchanged anchor — already how the parser finds spec) |
| `raw[B]` | **Talents** — `[(traitNodeID, traitNodeEntryID, rank), ...]`, ~73–81 tuples. **One flat list** combining class + spec + hero + Apex + **Omnium Folio** (12.0.5 account-wide power tree) selections. There is **no** separate field or event for any of those sub-trees; splitting the list needs trait-tree lookup data the wiki doesn't provide. This resolves the long-standing "hero/Apex talent" open question — they're in the flat list, as suspected. |
| `raw[B+1]` | **PvP Talents** — `(0, spellId, spellId, spellId)` or `(0,0,0,0)` |
| `raw[B+2]` | **Equipped Items** (pre-DF logs slot an extra `[0,0,[],[],[]]` artifact/covenant block here first — detect gear by shape: the first `[...]` after the talent field whose first element is an item tuple `(itemID, iLvl, ...)`) |
| `raw[B+3]` | **Interesting Auras** — pre-DF `[casterGUID, spellID, ...]` **pairs**; 12.x adds a trailing stack count per entry → `[casterGUID, spellID, count, ...]` **triples** (detect by whether every third element is a small number) |
| `raw[B+4 .. B+7]` | 4 PvP-stat numbers (honor level / season / rating / tier) |

Field 27's "expansion-dependent shape" caveat below still holds for pre-12 logs; in 12.x that block is simply **gone** (no covenant/artifact/anima structure between PvP talents and gear).

**Delimiter structure (critical for a bytewise tokenizer):** top-level fields are comma-separated same as any other line, but several fields are themselves **parenthesized `(...)` tuples or bracketed `[...]` lists containing their own comma-separated sub-values**, with no quoting or escaping distinguishing "this comma is inside a nested group" from "this comma ends a top-level field." A naive split-on-top-level-commas parser must track paren/bracket nesting depth. This is the one line type where the field count is not statically knowable from the event name alone.

Full ordered field list:

| # | Field | Type / shape | Notes |
|---|---|---|---|
| 1 | playerGUID | GUID string | |
| 2 | Faction | 0 or 1 | 0 = Horde, 1 = Alliance |
| — | *Character stats (8 fields, raw values at time of log line):* | | |
| 3 | Strength | number | |
| 4 | Agility | number | |
| 5 | Stamina | number | |
| 6 | Intelligence | number | |
| 7 | Dodge | number | rating, not % |
| 8 | Parry | number | rating |
| 9 | Block | number | rating |
| 10 | CritMelee | number | rating |
| — | *(secondary stats continue)* | | |
| 11 | CritRanged | number | rating |
| 12 | CritSpell | number | rating |
| 13 | Speed | number | rating |
| 14 | Lifesteal | number | rating |
| 15 | HasteMelee | number | rating |
| 16 | HasteRanged | number | rating |
| 17 | HasteSpell | number | rating |
| 18 | Avoidance | number | rating |
| 19 | Mastery | number | rating |
| 20 | VersatilityDamageDone | number | rating |
| 21 | VersatilityHealingDone | number | rating |
| 22 | VersatilityDamageTaken | number | rating |
| 23 | Armor | number | **pre-multiplier** amount (e.g. before Bear Form) |
| 24 | CurrentSpecID | number | |
| 25 | Class Talents | `(id, id, ...)` | selected talent spell/talent IDs, variable length |
| 26 | PvP Talents | `(id, id, ...)` | up to 3-4 selected PvP talent IDs |
| 27 | Artifact Traits *(or Covenant block — see below)* | `[id, level, id, level, ...]` | expansion-dependent shape |
| 28 | Equipped Items | `[(itemID, iLvL, (permEnchant, tempEnchant, onUseEnchant), (bonusID, ...), (gemID, gemILvl, ...)), ...]` | one tuple per gear slot, fixed slot order; see nested shape below |
| 29 | Interesting Auras | `[casterGUID, spellID, casterGUID, spellID, ...]` | flat, variable-length, flagged by Blizzard as "interesting" (set bonuses, flasks, Vantus runes, etc.) — pairs, not tuples |
| 30 | PvP Stats: Honor Level | number | |
| 31 | PvP Stats: Season | number | |
| 32 | PvP Stats: Rating | number | |
| 33 | PvP Stats: Tier | number | |

**Equipped item tuple shape**, one per item: `(itemID, iLvl, (permanentEnchantID, tempEnchantID, onUseSpellEnchantID), (bonusListID1, bonusListID2, ...), (gemID1, gemLvl1, gemID2, gemLvl2, ...))`. Empty slots appear as `(0,0,(),(),())`. Empty sub-lists appear as bare `()`.

**Expansion-dependent field 27:** on a character with no Shadowlands-or-later "extra power" system, this is the Artifact Traits shape `[artifactTraitID, effectiveLevel, ...]`. On Shadowlands+ characters it's replaced by a differently-shaped block: `[soulbindID, covenantID, [(animaSpellID, mawPowerID, count), ...], [(soulbindTraitID), ...], [(conduitID, conduitLevel), ...]]`. **This means field 27 (and therefore everything after it) is not a fixed shape across characters/expansions — parse it as "whatever nested bracket structure is there," not by a hardcoded schema.**

> **Patch-12 gap — RESOLVED (2026-09) against `WoWCombatLog-090326_192352.txt`.** In 12.x there is no field-27 covenant/artifact block at all: the layout is spec → one flat `[(node,entry,rank),...]` talent list → PvP-talent tuple → gear → interesting auras → 4 PvP-stat numbers (see the verified table above). Hero talents, Apex talents, and the 12.0.5 Omnium Folio are all folded into that single talent list — the wiki's guess was right. The parser (`parser::reports::parse_combatant_info`) anchors on the first `[`/`(` group for spec, detects gear by tuple shape (so it spans both layouts), and stores the stat block only when it's exactly 22 fields.

Example (pre-Shadowlands-power character):
```
COMBATANT_INFO,Player-3299-004E8630,1,132,184,906,653,0,0,0,257,257,257,11,0,188,188,188,0,118,90,90,90,120,257,(193155,64129,238136,200199,321377,193157,265202),(0,235587,215982,328530),[0,0,[],[],[]],[(173845,90,(),(1479,4786,6502),()),(158075,140,(),(4932,4933,6316),()), ...],[Player-3299-004E8630,295365,Player-3299-004E8630,298268,Player-3299-004E8630,296320],1,0,0,0
```

### ZONE_CHANGE
```
ZONE_CHANGE,instanceID,"zoneName",difficultyID
ZONE_CHANGE,34,"Stormwind Stockade",1
```

### MAP_CHANGE
```
MAP_CHANGE,uiMapID,"uiMapName",x0,x1,y0,y1
MAP_CHANGE,37,"Elwynn Forest",-7939.580078,-10254.200195,1535.420044,-1935.420044
```
`x0,x1,y0,y1` are the world-map bounding box corners (not a unit position).

### WORLD_MARKER_PLACED
```
WORLD_MARKER_PLACED,instanceID,marker,x,y
WORLD_MARKER_PLACED,2450,2,269.82,-828.35
```
`marker` is 1-8, same star/circle/diamond/triangle/moon/square/cross/skull ordering as the raid-target-flag bits in §4.2 (1=star ... 8=skull).

### WORLD_MARKER_REMOVED
```
WORLD_MARKER_REMOVED,marker
WORLD_MARKER_REMOVED,2
```

### PARTY_KILL
Base 9 fields only, both source and dest populated, plus one trailing field (see Death Events below). Only reported for the log owner's own kills or their **4 party members** — not full raid — so this event under-reports raid-wide kills.

### UNIT_DIED / UNIT_DESTROYED / UNIT_DISSIPATES
Base 9 fields (source is typically the zero-GUID/`nil`/`0x80000000` sentinel — these fire with an empty source), plus a trailing death-recap field. `destGUID`/`destName` identify the unit that died.

```
UNIT_DIED,0000000000000000,nil,0x80000000,0x80000000,Creature-0-1469-2450-16377-99773-0000785473,"Bloodworm",0x2114,0x0,0
UNIT_DESTROYED,0000000000000000,nil,0x80000000,0x80000000,Creature-0-1469-2450-16377-26125-0000785441,"Risen Ghoul",0x2114,0x0,0
```

Per patch notes (6.1.0): `recapID` was added to `UNIT_DIED`, and `unconsciousOnDeath` was added to `UNIT_DIED`/`UNIT_DESTROYED`/`UNIT_DISSIPATES`. The worked examples above show only **one** trailing field, not two.

**RESOLVED against the fixture**: every `UNIT_DIED` sample checked (2332 total occurrences in the file, spot-checked several) carried **exactly 1 trailing field**, value `0` in all samples seen, e.g. `UNIT_DIED,0000000000000000,nil,0x80000000,0x80000000,Creature-...,"Lesser Ghoul",0x2114,0x80000000,0`. Only one field was ever observed varying — never two — so treat this as confirmed 1 trailing field for current retail, not "0, 1, or 2." (Whether that one field is `recapID` or `unconsciousOnDeath` under the hood is unconfirmed — the value `0` is consistent with either being a boolean-ish flag or an absent recap ID — but the *count* is settled.) `UNIT_DESTROYED`/`UNIT_DISSIPATES` are for GameObjects (the latter specifically for gas clouds extracted with Zapthrottle Mote Extractor-type items).

### SPELL_ABSORBED
Irregular shape — optionally carries a spell payload (present when the underlying attack was spell-based, absent for a plain-swing absorb), then always carries an absorbing-spell payload:

```
timestamp, subevent, sourceGUID, sourceName, sourceFlags, sourceRaidFlags, destGUID, destName, destFlags, destRaidFlags, [spellID, spellName, spellSchool], casterGUID, casterName, casterFlags, casterRaidFlags, absorbSpellId, absorbSpellName, absorbSpellSchool, amount, critical
```

- The bracketed `[spellID, spellName, spellSchool]` group is present only when the triggering event would otherwise have been `SPELL_DAMAGE`/`SPELL_MISSED` (i.e. `SPELL_ABSORBED` follows a `SPELL_*` line); absent when following a `SWING_*` line. **This is a variable-arity event** — field count depends on what preceded it.
- `casterGUID`/`casterName`/`casterFlags`/`casterRaidFlags` = who cast the absorb shield; `absorbSpellId`/`absorbSpellName`/`absorbSpellSchool` = the absorb spell itself (e.g. Power Word: Shield); `amount` = amount absorbed this tick; `critical` = boolean.
- Fires **in addition to** a `SWING_MISSED`/`SPELL_MISSED` line with `missType = "ABSORB"` and the same `amount` — expect a paired line immediately before it.

**NEW field found, not in the wiki:** the fixture's `SPELL_ABSORBED` samples (following a `SWING_*` line, no leading spell-payload bracket) carried **10 fields after base9**, not the documented 9 — `casterGUID, casterName, casterFlags, casterRaidFlags, absorbSpellId, absorbSpellName, absorbSpellSchool, amount, <unidentified extra field>, critical`. E.g. `...,209388,"Bulwark of Order",0x2,5452,884778,nil` — `5452` is a plausible `amount`, `884778` is the new unidentified field (large enough to plausibly be a total/remaining shield capacity, but this is a guess, not confirmed), `nil` is `critical`. Don't hardcode a 9-field assumption for the post-caster-info portion of this event; verify the exact semantics of the new field before relying on it.

Examples:
```
SWING_MISSED,Creature-0-4234-0-138-44176-000016DAE1,"Bluegill Wanderer",0x2632,0x0,Player-1096-06DF65C1,"Xiaohuli",0x66833,0x0,"ABSORB",false,13,false
SPELL_ABSORBED,Creature-0-4234-0-138-44176-000016DAE1,"Bluegill Wanderer",0x2632,0x0,Player-1096-06DF65C1,"Xiaohuli",0x66833,0x0,Player-1096-06DF65C1,"Xiaohuli",0x66833,0x0,17,"Power Word: Shield",0x2,13,false

SPELL_MISSED,Creature-0-4234-0-138-44176-000016DAE1,"Bluegill Wanderer",0x2632,0x0,Player-1096-06DF65C1,"Xiaohuli",0x66833,0x0,83669,"Water Bolt",0x16,"ABSORB",false,15,false
SPELL_ABSORBED,Creature-0-4234-0-138-44176-000016DAE1,"Bluegill Wanderer",0x2632,0x0,Player-1096-06DF65C1,"Xiaohuli",0x66833,0x0,83669,"Water Bolt",0x16,Player-1096-06DF65C1,"Xiaohuli",0x66833,0x0,17,"Power Word: Shield",0x2,15,false
```
(hex-ified flags above to match file convention; the wiki's source examples for this event happened to render flags as decimal Lua values — another reminder the wiki mixes Lua-payload and file-format examples inconsistently.)

### SPELL_RESURRECT
Not a standalone event — it's the ordinary `SPELL` prefix + `_RESURRECT` suffix composition (base 9 + spellId/spellName/spellSchool + [advanced 19, §5] + no extra suffix fields).

### EMOTE
No dest unit at all — only 5 fields, all source-side, plus free text:
```
EMOTE,sourceGUID,"sourceName",sourceFlags,sourceRaidFlags,text
```
`text` is **unquoted, unescaped free text** running to end of line — may itself contain commas, WoW markup (`|T...|t` textures, `|c...|r` colors, `|H...|h` hyperlinks). Do not attempt to comma-split this field; once you've consumed the first 4 fields, the remainder of the line is the text. Example: `EMOTE,Vehicle-0-1465-2450-15939-175732-000016A7D7,"Sylvanas Windrunner",0000000000000000,nil,|TInterface\ICONS\Achievement_Leader_Sylvanas.blp:20|t Sylvanas Windrunner gains |cFFFF0000|Hspell:347504|h[Windrunner]|h|r!` (note: `sourceRaidFlags` here is literally `nil`, not a hex zero — inconsistent with every other event type, worth defensive handling).

### Other standalone events (bonus — found alongside the above, not explicitly requested but cheap to capture)

| Event | Fields |
|---|---|
| `ARENA_MATCH_START` | instanceID, unk, matchType (string, e.g. `Skirmish`), teamId |
| `ARENA_MATCH_END` | winningTeam, matchDuration, newRatingTeam1, newRatingTeam2 |
| `CHALLENGE_MODE_START` | zoneName, instanceID, challengeModeID, keystoneLevel, `[affixID, ...]` |
| `CHALLENGE_MODE_END` | instanceID, success, keystoneLevel, totalTime (milliseconds, includes death time penalties) |

---

## 9. Enums

### 9.1 Spell school bitmask

Single-bit base schools, bitwise-OR'd for multi-school spells (values below are the raw bitmask, decimal):

| Bit | Decimal | School |
|---|---|---|
| `00000001` | 1 | Physical |
| `00000010` | 2 | Holy |
| `00000100` | 4 | Fire |
| `00001000` | 8 | Nature |
| `00010000` | 16 | Frost |
| `00100000` | 32 | Shadow |
| `01000000` | 64 | Arcane |

Named combinations actually seen in spell data (non-exhaustive; any bitwise-OR combination is technically valid, these are the ones with wiki-documented names): 3 Holystrike, 5 Flamestrike, 6 Radiant, 9 Stormstrike, 10 Holystorm, 12 Volcanic, 17 Froststrike, 18 Holyfrost, 20 Frostfire, 24 Froststorm, 33 Shadowstrike, 34 Twilight, 36 Shadowflame, 40 Plague, 48 Shadowfrost, 65 Spellstrike, 66 Divine, 68 Spellfire, 72 Astral, 80 Spellfrost, 96 Spellshadow, 28 Elemental, 62 Chromatic, 106 Cosmic, 124/127 Chaos, 126 Magic.

**Gotcha:** Chromatic's decimal value **changed from 124 to 62** around Patch 9.0.1/9.2.0 (Cosmic school added, 9.2.0). Don't hardcode a single Chromatic value if supporting logs across that patch boundary.

### 9.2 Power types (`Enum.PowerType`)

| Value | Name | Notes |
|---|---|---|
| 0 | Mana | default for most non-player units |
| 1 | Rage | 0-100 (+talents), decays out of combat |
| 2 | Focus | Hunters/pets |
| 3 | Energy | Rogues, Monks, cat-form Druids |
| 4 | ComboPoints | 0-5 (up to 10 via talents), decays out of combat |
| 5 | Runes | Death Knights, 6 runes |
| 6 | RunicPower | 0-100, decays out of combat |
| 7 | SoulShards | Warlocks, 0-5 |
| 8 | LunarPower | moonkin-form Druids, 0-100, decays |
| 9 | HolyPower | Retribution Paladins, 0-5, decays |
| 10 | Alternate | boss-mechanic-specific (Atramedes sound, Cho'gall corruption, etc.) |
| 11 | Maelstrom | Enhancement/Elemental Shaman, decays |
| 12 | Chi | Windwalker Monk, 0-5, decays |
| 13 | Insanity | Shadow Priest, decays |
| 14 | BurningEmbers | pre-Legion Destro Warlock, obsolete |
| 15 | DemonicFury | pre-Legion Demo Warlock, obsolete |
| 16 | ArcaneCharges | Arcane Mage, 0-5, decays |
| 17 | Fury | Havoc DH, 0-100 (up to 170), decays |
| 18 | Pain | Vengeance DH, 0-100, decays |
| 19 | Essence | Evoker, 0-6, regenerates passively |
| 20 | RuneBlood | DK rune subtype (10.0.0+) |
| 21 | RuneFrost | DK rune subtype |
| 22 | RuneUnholy | DK rune subtype |
| 23 | AlternateQuest | quest-specific (10.1.0+) |
| 24 | AlternateEncounter | encounter-specific (10.1.0+) |
| 25 | AlternateMount | Dragonriding Vigor (10.1.0+) |
| 26 | Balance | (10.2.7+) |
| 27 | Happiness | (11.0.5+) |
| 28 | ShadowOrbs | (11.0.5+) |
| 29 | RuneChromatic | (11.0.5+) |

Two more power types (`AMMOSLOT`, `FUEL`) exist for vehicles but have no `Enum.PowerType` constant — they won't appear as a numeric `powerType` combat log field in the normal sense.

### 9.3 Miss types (`missType` string values)

`ABSORB`, `BLOCK`, `DEFLECT`, `DODGE`, `EVADE`, `IMMUNE`, `MISS`, `PARRY`, `REFLECT`, `RESIST`

### 9.4 Aura type

`BUFF`, `DEBUFF`

### 9.5 Environmental damage types (`environmentalType`)

`Drowning`, `Falling`, `Fatigue`, `Fire`, `Lava`, `Slime`

(Patch 5.0.4: changed from all-caps to proper-case strings, e.g. `Falling` not `FALLING` — irrelevant for modern logs but a landmine if testing against very old archived logs.)

### 9.6 Cast-failed reasons (`failedType`, non-exhaustive — free text, not a closed enum, sourced from client GlobalStrings)

`"A more powerful spell is already active"`, `"Another action is in progress"`, `"Can't do that while asleep"`, `"Can't do that while charmed"`, `"Can't do that while confused"`, `"Can't do that while fleeing"`, `"Can't do that while horrified"`, `"Can't do that while incapacitated"`, `"Can't do that while moving"`, `"Can't do that while silenced"`, `"Can't do that while stunned"`, `"Interrupted"`, `"Invalid target"`, `"No target"`, `"Not enough energy"`, `"Not enough mana"`, `"Not enough rage"`, `"Out of range"`, `"Target needs to be in front of you."`, `"Target not in line of sight"`, `"Target too close"`, `"You are dead"`, `"You are in combat"`, `"You are in shapeshift form"`, `"You are unable to move"`, `"You can't do that yet"`, `"You must be behind your target."`

Treat as an open string set (localized to client language, can vary by patch) rather than a hard enum — store as an interned string, don't try to match a Rust enum exhaustively.

### 9.7 Trailing damage/heal booleans

`critical`, `glancing`, `crushing`, `isOffHand` (on `_DAMAGE`), `critical` (on `_HEAL`/`_MISSED`) — see §7 gotcha regarding uncertain true/false vs 0/1/nil encoding in the raw file; confirm against a real captured log.

---

## 10. Quirks / gotchas summary

For quick scanning while writing the tokenizer — each of these is detailed in its section above, collected here for reference:

1. **RESOLVED — timestamps DO include a year and a timezone offset on current retail** (`M/D/YYYY HH:MM:SS.mmm-TZ`, e.g. `7/25/2026 20:52:35.870-6`), contradicting the wiki. No mtime-inference workaround needed — confirmed against the fixture (§1).
2. **`hideCaster` (Lua-only) is not in the file.** Base event is 9 comma-fields, not 11 (§2).
3. **Flags are `0x`-prefixed hex in the file**, decimal in the Lua API — don't mix reference examples from the two representations (this doc flags mixed examples where found) (§1, §3).
4. **Advanced-log block presence must be detected per-line by field count**, not assumed from the file header — **confirmed false in the wild, not just theoretical**: the fixture's header says `ADVANCED_LOG_ENABLED,0` throughout, yet the block is present on every damage/heal/energize/drain/cast_success line in the file (§1, §5).
5. **RESOLVED — the advanced-log block is 19 fields on current retail, not 17.** Confirmed by cross-referencing known-good values (`uiMapID` matching a same-file `MAP_CHANGE` line, `facing` in `[0,2π)`) across 9 event types. The 2 new fields sit in the power-info region; their exact semantics are unconfirmed — don't hardcode field-10/11 meaning (§5). The old wiki-sourced "`powerType`/`currentPower`/`maxPower`/`powerCost` can be pipe (`|`)-delimited" quirk was **not observed** in the fixture — no `|` characters found anywhere in that region across all samples checked.
6. **`COMBATANT_INFO` has genuinely variable-length nested paren/bracket structure**, not a fixed field count — and the shape of one section (artifact traits vs. covenant/soulbind block) is expansion-dependent. **Not observed at all in the fixture** (0 occurrences despite real `ENCOUNTER_START`/`ENCOUNTER_END` pairs present) — this section of the doc remains wiki-sourced only, not yet cross-checked (§8).
7. **`SPELL_ABSORBED` is variable-arity** — the leading spell-payload triplet is present or absent depending on the preceding event. **Also confirmed to carry 1 more field than documented** (10 fields after base9, not 9) — an unidentified numeric field between `amount` and `critical` (§8).
8. **`EMOTE`'s `text` field is unescaped free text to end-of-line**, may contain commas and WoW UI markup — don't comma-split past the 4th field. Also observed with a literal `nil` in `sourceRaidFlags` rather than a hex zero (§8).
9. **`SPELL_AURA_REFRESH` drops the `amount` field**, and so do **stackless `_AURA_APPLIED`/`_AURA_REMOVED`** — confirmed the `amount` field on these three is conditional on there being a stack count to report, not a fixed part of the suffix shape (§7).
10. **CORRECTED — `_DAMAGE` suffix is 10 fields `amount, baseAmount, overkill, school, resisted, blocked, absorbed, critical, glancing, crushing`** (no `isOffHand`). Count confirmed by `SWING_*` arithmetic; the composition (with `baseAmount` at index 1) confirmed across two 2026 captures. `critical` is read anchored from the end — see §7 gotcha and `parser::event::extract_damage_heal`.
11. **NEW, not in the wiki — a trailing `hitType` field (`ST`/`AOE`) on spell-prefixed damage/missed lines.** `SPELL_DAMAGE`, `SPELL_PERIODIC_DAMAGE`, `RANGE_DAMAGE`, `SPELL_MISSED` all carry one extra field past every documented suffix table; absent on `SWING_*` (no spell prefix) (§7).
12. **NEW, unresolved — `SPELL_MISSED` is not a fixed 4-field suffix.** A `missType=ABSORB` sample carried 6 fields instead of the documented 4 (§7).
13. **RESOLVED — boolean encoding is `nil`/`0`/`1`, never `true`/`false`, in the file.** The wiki's `true`/`false` examples are Lua-payload-only (§1, §7).
14. **RESOLVED — `UNIT_DIED`/`UNIT_DESTROYED`/`UNIT_DISSIPATES` carry exactly 1 trailing field**, not "0, 1, or 2" as the wiki's patch-note history implied. Confirmed across all fixture samples checked (§8).
15. **Raid-target flags gained extra undocumented upper bits in Patch 11.1.7** — always mask with `0xFF` before interpreting as a marker (§3.2).
16. **Names may carry a `-RealmName` suffix** for cross-realm units (spaces stripped from the realm name), so a hyphen inside a quoted name field isn't necessarily an escaping problem — it's semantically meaningful (§2, referenced from GUID section).
17. **Pet GUIDs are not stable across summons** — don't key long-lived pet identity off the GUID; use `ownerGUID` (advanced params) to link a pet to its owner instead (§4).
18. **Monster/pet GUIDs can be recycled after a server/instance restart** — full uniqueness only holds within one continuous server session, not eternally (§4).
19. **`Cast-` GUIDs of type 2 are local-client-only** (failed casts that never left the client) and have zeroed server/instance/zone fields with a locally-incrementing `castUID` — don't treat them as globally meaningful identifiers (§4).
20. **Patch 12.0.0's Lua-side "addon apocalypse"** (new `COMBAT_LOG_MESSAGE`, `DAMAGE_METER_*`, `ENCOUNTER_TIMELINE_*` etc. events, and `COMBAT_LOG_EVENT`/`COMBAT_LOG_EVENT_UNFILTERED` now erroring if an addon tries to register them) is confirmed **Lua-API-only** — the file writer (`/combatlog`, `LoggingCombat(true)`) is unaffected. Doesn't change anything for a file-reading parser like parseomatic (§Scope note).
21. **RESOLVED (2026-09):** hero talents / Apex talents / the 12.0.5 Omnium Folio all fold into the single flat `COMBATANT_INFO` talent list — no new field. Verified against `WoWCombatLog-090326_192352.txt` (418 `COMBATANT_INFO` lines); the 12.x `COMBATANT_INFO` layout is now pinned in §8.

### Verified against a real log — and how to re-verify

Items marked **RESOLVED**/**confirmed**/**NEW** above were checked against a real patch 12.0.7 fixture log at `src-tauri/tests/fixtures/WoWCombatLog-072526_205235.txt` (gitignored — see repo `.gitignore` — 547 MB, not meant to ever be committed; smaller synthetic fixtures may be added later under the same directory). The verification method throughout: exact per-line field splitting (respecting quoted strings) via Python's `csv` module, cross-referencing known-good values (e.g. `uiMapID` against a same-file `MAP_CHANGE` line) rather than eyeballing raw text. Items still marked unresolved/unconfirmed genuinely need either more samples from this same fixture (e.g. more `SPELL_MISSED` `missType` variants, more diverse power-type classes) or a fixture that actually contains `COMBATANT_INFO` lines, which this one doesn't.
