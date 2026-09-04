// Imports every built-in widget module for its registration side effect.
// Explicit, rather than relying on a glob or on Vite not tree-shaking
// side-effect-only imports. Any view code must import this once before
// calling buildView.

import "./encounter-title";
import "./section-heading";
import "./stat-tile";
import "./player-table";
import "./line-chart";
import "./area-chart";
import "./bar-chart";
import "./pie-chart";
