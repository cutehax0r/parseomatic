// Raid world markers (the ground flares): tuning constants, the raid-
// marker colour/shape table, and the pure shape/material builders.
// `rebuildMarkers` / `updateMarkers` (index.ts) own the per-marker rigs
// (group + meshes) and drive them each frame from these.

import * as THREE from "three";

// A faint tall column at the marker's spot with a minimal extruded icon
// on top. Both fade in/out over MARKER_FADE_MS on place / remove. Sized
// off a nominal player unit (views/replay.ts PLAYER_SIZE).
export const MARKER_UNIT = 1.6;
export const MARKER_COL_H = MARKER_UNIT * 5; // column height
export const MARKER_COL_R = MARKER_UNIT; // column radius -> ~2x a player wide
export const MARKER_COL_OPACITY = 0.28; // peak alpha of the additive glow shell
export const MARKER_ICON = MARKER_UNIT; // icon width / height
export const MARKER_ICON_DEPTH = MARKER_UNIT * 0.25; // extrusion depth
export const MARKER_ICON_OPACITY = 0.6;
export const MARKER_FADE_MS = 500;
// A downward coloured spotlight per visible marker, pooled (only so many
// live at once) so the light count -- and shader program -- stays fixed.
export const MARKER_LIGHT_MAX = 8;
export const MARKER_LIGHT_INTENSITY = 70;
export const MARKER_LIGHT_ANGLE = Math.PI / 7; // ~26deg cone
export const MARKER_LIGHT_PENUMBRA = 0.85; // very soft pool edge

// Log slot 0-7 -> [colour, shape id]. The log is 0-indexed, so slot N is
// the in-game raid marker N+1: 1 star, 2 circle, 3 diamond, 4 triangle,
// 5 moon, 6 square, 7 cross, 8 skull.
export const MARKER_DEFS: ReadonlyArray<readonly [string, string]> = [
  ["var(--ctp-yellow)", "star"], // 1  star / yellow
  ["#f0872a", "circle"], // 2  circle / orange
  ["var(--ctp-mauve)", "diamond"], // 3  diamond / purple
  ["var(--ctp-green)", "triangle"], // 4  triangle / green
  ["#c8cdd8", "moon"], // 5  moon / silver
  ["var(--ctp-blue)", "square"], // 6  square / blue
  ["var(--ctp-red)", "cross"], // 7  cross (X) / red
  ["#eef1f7", "skull"], // 8  skull / white
];

// The marker column: an additive, view-angle-softened glow shell. Alpha
// is high where the surface faces the camera and fades toward the
// silhouette (soft edges) and toward the top (a fading shaft). `uColor`
// and `uOpacity` (the marker's fade) are set per frame.
export function markerColumnMaterial(col: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: col.clone() }, uOpacity: { value: 0 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    vertexShader: `
      varying vec3 vN;
      varying vec3 vView;
      varying float vY;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalMatrix * normal;
        vView = -mv.xyz;
        vY = uv.y;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying vec3 vN;
      varying vec3 vView;
      varying float vY;
      void main() {
        float facing = abs(dot(normalize(vN), normalize(vView))); // 1 face-on, 0 at rim
        float soft = pow(facing, 1.6);
        float shaft = smoothstep(1.0, 0.3, vY) * smoothstep(0.0, 0.06, vY);
        float a = uOpacity * soft * shaft;
        gl_FragColor = vec4(uColor * (0.7 + 0.5 * soft), a);
      }`,
  });
}

// One rectangular bar of half-length `len`, thickness `w`, rotated
// `angle` -- the pieces of the "cross" (X) marker.
function markerBar(len: number, w: number, angle: number): THREE.Shape {
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const s = new THREE.Shape();
  const pts: [number, number][] = [
    [-len / 2, -w / 2],
    [len / 2, -w / 2],
    [len / 2, w / 2],
    [-len / 2, w / 2],
  ];
  pts.forEach(([x, y], i) => {
    const rx = x * ca - y * sa;
    const ry = x * sa + y * ca;
    if (i === 0) s.moveTo(rx, ry);
    else s.lineTo(rx, ry);
  });
  s.closePath();
  return s;
}

// A minimal marker icon outline in a unit box ([-0.5, 0.5]). Extruded and
// scaled to size by `markerGeoFor`.
export function markerShape(id: string): THREE.Shape | THREE.Shape[] {
  const s = new THREE.Shape();
  switch (id) {
    case "square":
      s.moveTo(-0.5, -0.5);
      s.lineTo(0.5, -0.5);
      s.lineTo(0.5, 0.5);
      s.lineTo(-0.5, 0.5);
      s.closePath();
      return s;
    case "diamond":
      s.moveTo(0, 0.5);
      s.lineTo(0.5, 0);
      s.lineTo(0, -0.5);
      s.lineTo(-0.5, 0);
      s.closePath();
      return s;
    case "triangle": // equilateral-ish, apex DOWN
      s.moveTo(-0.5, 0.4);
      s.lineTo(0.5, 0.4);
      s.lineTo(0, -0.5);
      s.closePath();
      return s;
    case "circle":
      s.absarc(0, 0, 0.5, 0, Math.PI * 2, false);
      return s;
    case "moon": {
      s.absarc(0, 0, 0.5, 0, Math.PI * 2, false);
      const bite = new THREE.Path();
      bite.absarc(0.28, 0.06, 0.44, 0, Math.PI * 2, true);
      s.holes.push(bite);
      return s;
    }
    case "star": {
      const R = 0.5;
      const r = 0.21;
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const rad = i % 2 === 0 ? R : r;
        const x = Math.cos(a) * rad;
        const y = Math.sin(a) * rad;
        if (i === 0) s.moveTo(x, y);
        else s.lineTo(x, y);
      }
      s.closePath();
      return s;
    }
    case "cross": // a saltire: two crossed bars
      return [markerBar(0.95, 0.26, Math.PI / 4), markerBar(0.95, 0.26, -Math.PI / 4)];
    case "skull": {
      s.moveTo(-0.4, 0.05);
      s.absarc(0, 0.05, 0.4, Math.PI, 0, true); // dome over the top
      s.lineTo(0.32, -0.16);
      s.lineTo(0.2, -0.42);
      s.lineTo(0.1, -0.5);
      s.lineTo(-0.1, -0.5);
      s.lineTo(-0.2, -0.42);
      s.lineTo(-0.32, -0.16);
      s.closePath();
      const eyeL = new THREE.Path();
      eyeL.absarc(-0.17, 0.03, 0.12, 0, Math.PI * 2, true);
      const eyeR = new THREE.Path();
      eyeR.absarc(0.17, 0.03, 0.12, 0, Math.PI * 2, true);
      const nose = new THREE.Path();
      nose.moveTo(0, -0.08);
      nose.lineTo(0.07, -0.24);
      nose.lineTo(-0.07, -0.24);
      nose.closePath();
      s.holes.push(eyeL, eyeR, nose);
      return s;
    }
    default:
      s.absarc(0, 0, 0.5, 0, Math.PI * 2, false);
      return s;
  }
}
