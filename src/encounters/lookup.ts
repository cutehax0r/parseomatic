// Matches a selected log encounter to its config file (docs/encounter-config.md
// "Matching a log encounter"), via a direct `<encounterId>.<difficulty>.json`
// file read -- no directory scan (src-tauri/src/encounters.rs).

import { invoke } from "@tauri-apps/api/core";
import { difficultyFromId, type EncounterConfig } from "./schema";

export interface ResolvedEncounterConfig {
  path: string;
  config: EncounterConfig;
}

interface FoundEncounterConfig {
  path: string;
  json: string;
}

/** Looks up the config for a log encounter, or `null` if there isn't one
 *  (unrecognized encounter, unrecognized difficulty, or no matching file --
 *  all treated the same: fall back to defaults). */
export async function findEncounterConfig(
  encounterId: number,
  difficultyId: number,
): Promise<ResolvedEncounterConfig | null> {
  const difficulty = difficultyFromId(difficultyId);
  if (!difficulty || !encounterId) return null;
  const found = await invoke<FoundEncounterConfig | null>("find_encounter_config", {
    encounterId,
    difficulty,
  });
  if (!found) return null;
  try {
    return { path: found.path, config: JSON.parse(found.json) as EncounterConfig };
  } catch {
    return null; // malformed file -- treated as "no match" rather than an error
  }
}
