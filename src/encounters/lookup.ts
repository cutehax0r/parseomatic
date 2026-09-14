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

// Kanban/Timeline/Replay all resolve the same handful of bosses over and
// over as they repaint (once per pull, on every log reload) -- cache by
// (encounterId, difficultyId) rather than re-issuing the same IPC call and
// JSON.parse each time. `invalidateEncounterConfig` clears it when the
// encounter editor writes a file out from under this cache.
const cache = new Map<string, ResolvedEncounterConfig | null>();

function cacheKey(encounterId: number, difficultyId: number): string {
  return `${encounterId}:${difficultyId}`;
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
  const key = cacheKey(encounterId, difficultyId);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const found = await invoke<FoundEncounterConfig | null>("find_encounter_config", {
    encounterId,
    difficulty,
  });
  let resolved: ResolvedEncounterConfig | null;
  if (!found) {
    resolved = null;
  } else {
    try {
      resolved = { path: found.path, config: JSON.parse(found.json) as EncounterConfig };
    } catch {
      resolved = null; // malformed file -- treated as "no match" rather than an error
    }
  }
  cache.set(key, resolved);
  return resolved;
}

/** Drops a cached lookup so the next `findEncounterConfig` call re-reads
 *  from disk -- call after writing a config file out from under this
 *  cache (the encounter editor's Save). */
export function invalidateEncounterConfig(encounterId: number, difficultyId: number): void {
  cache.delete(cacheKey(encounterId, difficultyId));
}
