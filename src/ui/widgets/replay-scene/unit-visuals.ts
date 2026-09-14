// Unit mesh factories + the overlap de-conflict / dim pass that keeps
// stacked shapes readable. Pure over a `Placement` snapshot built by
// `applyTime` (index.ts) each frame -- no scene-graph ownership here.

import * as THREE from "three";

import { FLOOR_LIFT } from "../../../map/extrude";
import type { ReplayTeam } from "./types";
import { setMeshOpacity } from "./math";

// De-conflicting overlaps (`deconflictOverlaps`). `STACK_DIST` x the
// mean shape size is the "overlapping" threshold. Player cubes fan up
// `PLAYER_STEP` x height per tier; an add over a player drops flush to
// the deck; adds over each other fan up `ADD_STEP` x height per tier
// (smallest highest).
const STACK_DIST = 0.85;
const PLAYER_STEP = 0.1;
const ADD_STEP = 0.25;

// A player / big-creature cube of side `size`, one flat class colour on
// every face (matching the Overview's class swatch).
export function cubeMesh(col: THREE.Color, size: number): THREE.Mesh {
  const mat = new THREE.MeshStandardMaterial({
    color: col,
    roughness: 0.55,
    metalness: 0.05,
    emissive: col.clone().multiplyScalar(0.18),
  });
  const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
  m.scale.setScalar(size);
  return m;
}

// A sphere of diameter `size` for a smaller creature.
export function sphereMesh(col: THREE.Color, size: number): THREE.Mesh {
  const mat = new THREE.MeshStandardMaterial({
    color: col,
    roughness: 0.6,
    metalness: 0.05,
    emissive: col.clone().multiplyScalar(0.15),
  });
  return new THREE.Mesh(new THREE.SphereGeometry(size / 2, 24, 16), mat);
}

export interface Placement {
  mesh: THREE.Mesh;
  x: number;
  z: number;
  team: ReplayTeam;
  size: number;
  rank: number;
  guid: string;
  settled: boolean; // false while spawning / dead / mid revive -- skipped by de-conflict
}

const overlaps = (a: Placement, b: Placement): boolean =>
  Math.hypot(a.x - b.x, a.z - b.z) < ((a.size + b.size) / 2) * STACK_DIST;

// Greedy overlap clusters (O(n^2), n <= ~40) over a subset.
function overlapClusters(items: Placement[]): Placement[][] {
  const clusters: Placement[][] = [];
  for (const p of items) {
    const near = clusters.find((cl) => cl.some((o) => overlaps(o, p)));
    if (near) near.push(p);
    else clusters.push([p]);
  }
  return clusters;
}

// De-conflict shapes sharing a spot (z-fighting):
//  - overlapping player cubes fan UP into a little stack -- tank ->
//    melee -> ranged -> healer by `rank`, GUID alphabetical as the
//    tiebreak, each lifted `PLAYER_STEP x its height` above the previous;
//  - an enemy overlapping a *player* is pushed DOWN to rest flush on the
//    deck (the `HOVER` gap dropped);
//  - enemies overlapping *each other* fan UP, biggest on the bottom,
//    each smaller one `ADD_STEP x its height` higher.
// Reused per frame in phase C when positions move.
export function deconflictOverlaps(placed: Placement[]): void {
  const live = placed.filter((p) => p.settled);
  for (const cl of overlapClusters(live.filter((p) => p.team === "player"))) {
    if (cl.length < 2) continue;
    cl.sort((a, b) => a.rank - b.rank || (a.guid < b.guid ? -1 : a.guid > b.guid ? 1 : 0));
    cl.forEach((p, i) => {
      p.mesh.position.y += i * p.size * PLAYER_STEP;
    });
  }

  const players = live.filter((p) => p.team === "player");
  const enemies = live.filter((p) => p.team === "enemy");
  for (const e of enemies) {
    if (players.some((p) => overlaps(p, e))) {
      e.mesh.position.y = FLOOR_LIFT + e.size / 2; // flush on the deck
    }
  }

  for (const cl of overlapClusters(enemies)) {
    if (cl.length < 2) continue;
    cl.sort((a, b) => b.size - a.size || (a.guid < b.guid ? -1 : a.guid > b.guid ? 1 : 0));
    cl.forEach((e, i) => {
      e.mesh.position.y += i * e.size * ADD_STEP;
    });
  }
}

// When one shape's centre is inside another's sphere -- a player soaking
// a boss orb, an orb swallowing an add -- fade the LARGER of the two to
// 80% so the thing inside stays visible. O(n^2) over settled shapes,
// n <= ~120; runs each frame.
export function dimOverlapping(placed: Placement[]): void {
  const live = placed.filter((p) => p.settled);
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i];
      const b = live[j];
      if (Math.hypot(a.x - b.x, a.z - b.z) >= Math.max(a.size, b.size) / 2) continue;
      const big = a.size >= b.size ? a : b;
      setMeshOpacity(big.mesh, 0.8);
      big.mesh.castShadow = false;
    }
  }
}
