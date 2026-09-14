// The "3D" toolbar toggle: builds the exact same geometry the replay
// renderer does -- `buildDevMap` in the shared `../map/extrude.ts` -- from
// the shapes being edited right now, so this preview and the replay can no
// longer drift apart into two hand-rolled extrusions
// (docs/encounter-maps.md §2 "keep the seam"). The current calibration
// fields are fed straight in, so the preview is at true world-yard scale
// too.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { buildDevMap, devMapWorldBox, framingOf } from "../map/extrude";
import type { DevMapDoc } from "../map/extrude";
import type { Shape } from "./kinds";
import { layersFromShapes } from "./kinds";
import { cal } from "./calibration";
import { $ } from "./dom";

const view3dEl = $<HTMLElement>("me-3d-view");
const btn3d = $<HTMLButtonElement>("me-3d");
const statusEl = $<HTMLElement>("me-status");
const status = (msg: string): void => {
  statusEl.textContent = msg;
};

export type PreviewMode = "2d" | "3d";
let mode: PreviewMode = "2d";
export function getMode(): PreviewMode {
  return mode;
}

let renderer3d: THREE.WebGLRenderer | null = null;
let scene3d: THREE.Scene;
let camera3d: THREE.PerspectiveCamera;
let controls3d: OrbitControls;
let mapGroup: THREE.Group;
let raf3d = 0;

function init3d(): void {
  if (renderer3d) return;
  renderer3d = new THREE.WebGLRenderer({ antialias: true });
  renderer3d.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer3d.setClearColor(0x1e2030);
  view3dEl.appendChild(renderer3d.domElement);

  scene3d = new THREE.Scene();
  camera3d = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
  controls3d = new OrbitControls(camera3d, renderer3d.domElement);
  controls3d.enableDamping = true;

  scene3d.add(new THREE.HemisphereLight(0xffffff, 0x1a1c28, 1.0));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(80, 160, 60);
  scene3d.add(sun);
  scene3d.add(new THREE.GridHelper(300, 30, 0x494d64, 0x363a4f));

  mapGroup = new THREE.Group();
  scene3d.add(mapGroup);
}

// Disposes every geometry + material (and any texture map -- `buildDevMap`
// allocates a fresh grid texture per call, unlike the old flat-colour
// preview) under `mapGroup`, then empties it.
function disposeMapGroup(): void {
  mapGroup.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    const mats = Array.isArray(mat) ? mat : mat ? [mat] : [];
    for (const mm of mats) {
      (mm as THREE.MeshStandardMaterial).map?.dispose();
      mm.dispose();
    }
  });
  mapGroup.clear();
}

function render3dOnce(): void {
  if (renderer3d) renderer3d.render(scene3d, camera3d);
}

function build3d(getShapes: () => Shape[]): void {
  init3d();
  disposeMapGroup();

  const doc: DevMapDoc = {
    layers: layersFromShapes(getShapes()),
    calibration: {
      yardsPerUnit: cal.yardsPerUnit,
      rotationDeg: cal.rotationDeg,
      originYards: [cal.originYards[0], cal.originYards[1]],
      mirrorY: cal.mirrorY,
    },
  };
  const group = buildDevMap(doc, framingOf(devMapWorldBox(doc)));
  if (!group) {
    render3dOnce();
    return;
  }
  mapGroup.add(group);

  const box = new THREE.Box3().setFromObject(mapGroup);
  const c = box.getCenter(new THREE.Vector3());
  const span = box.getSize(new THREE.Vector3()).length() || 120;
  controls3d.target.copy(c);
  camera3d.position.set(c.x + span * 0.5, c.y + span * 0.55, c.z + span * 0.75);
  camera3d.near = span / 200;
  camera3d.far = span * 40;
  camera3d.updateProjectionMatrix();
  controls3d.update();
  render3dOnce();
}

function resize3d(): void {
  if (!renderer3d) return;
  const w = view3dEl.clientWidth || 1;
  const h = view3dEl.clientHeight || 1;
  renderer3d.setSize(w, h, false);
  camera3d.aspect = w / h;
  camera3d.updateProjectionMatrix();
}

function loop3d(): void {
  controls3d.update();
  render3dOnce();
  raf3d = requestAnimationFrame(loop3d);
}

/** Rebuilds the 3D preview from the current shapes/calibration if it's the
 *  active mode -- called after a `.map.json` load (map-editor/map-io.ts). */
export function rebuildIfActive(getShapes: () => Shape[]): void {
  if (mode === "3d") build3d(getShapes);
}

// Wires the "3D" toggle button and the 3D view's own resize handling.
// `canvas` is the 2D canvas, hidden while in 3D mode; `getShapes` reads the
// live shapes array (owned by map-editor/index.ts).
export function initPreview3D(deps: { canvas: HTMLCanvasElement; getShapes: () => Shape[] }): void {
  btn3d.addEventListener("click", () => {
    mode = mode === "2d" ? "3d" : "2d";
    deps.canvas.hidden = mode === "3d";
    view3dEl.hidden = mode === "2d";
    btn3d.textContent = mode === "2d" ? "3D" : "2D";
    btn3d.classList.toggle("is-active", mode === "3d");
    if (mode === "3d") {
      build3d(deps.getShapes);
      resize3d();
      if (!raf3d) loop3d();
      status("3D preview — edits show on switching back and forth. Wheel/drag to orbit.");
    } else {
      cancelAnimationFrame(raf3d);
      raf3d = 0;
    }
  });

  new ResizeObserver(() => {
    if (mode === "3d") resize3d();
  }).observe(view3dEl);
}
