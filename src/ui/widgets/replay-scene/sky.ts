// A dark, minimal line-art panorama drawn to a canvas -- the scene's
// "lazy skybox". Self-contained: pure canvas drawing, no scene-graph
// ownership (the caller sets `.mapping` / assigns it as `scene.background`).

import * as THREE from "three";

// A dark, minimal line-art panorama drawn to a canvas -- the "lazy
// skybox", mapped equirectangular. Vertical texture coord: v=1 (top) =
// zenith, v=0.5 (middle) = the HORIZON, v=0 (bottom) = straight down. So
// the mountain ridgeline is drawn across the vertical middle (peaks poke
// just above it), and the lower half is dark distant ground. Fancy
// per-arena art is later (docs/replay-view.md §4, §10).
export function skyTexture(): THREE.Texture {
  const w = 2048;
  const h = 1024;
  const horizon = h * 0.5;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;

  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0.0, "#0d0e17"); // zenith
  grad.addColorStop(0.46, "#161822");
  grad.addColorStop(0.5, "#1c1f2c"); // faint glow at the horizon
  grad.addColorStop(0.54, "#131520");
  grad.addColorStop(1.0, "#090a11"); // nadir
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);

  // Ridges straddling the horizon. Endpoints pinned to `base` so the
  // 360deg wrap doesn't show a hard seam. Fill runs downward to cover
  // the lower hemisphere as distant ground.
  const ridge = (base: number, amp: number, fill: string) => {
    const steps = 64;
    g.beginPath();
    g.moveTo(0, base);
    for (let i = 1; i < steps; i++) {
      const x = (w / steps) * i;
      const edge = Math.min(i, steps - i) / 6; // taper randomness toward the seam
      const k = Math.min(1, edge);
      g.lineTo(x, base - Math.random() * amp * k);
    }
    g.lineTo(w, base);
    g.lineTo(w, h);
    g.lineTo(0, h);
    g.closePath();
    g.fillStyle = fill;
    g.fill();
  };
  ridge(horizon - 6, h * 0.09, "#1e212e"); // far range, peaks just above the horizon
  ridge(horizon + 10, h * 0.06, "#141620"); // nearer, lower, darker

  // Faint cloud strokes a little above the horizon (visible looking out).
  g.strokeStyle = "rgba(180,190,220,0.09)";
  g.lineWidth = 2;
  for (let i = 0; i < 6; i++) {
    const cy = horizon - h * 0.18 - i * (h * 0.03) - Math.random() * 10;
    g.beginPath();
    g.moveTo(60 + Math.random() * 200, cy);
    g.bezierCurveTo(w * 0.35, cy - 14, w * 0.6, cy + 14, w - 120 - Math.random() * 200, cy);
    g.stroke();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
