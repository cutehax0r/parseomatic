// Tiny typed `getElementById` shared by every Map Editor module -- each
// module grabs its own DOM refs by id at import time. `getElementById` is
// idempotent (the same id always resolves to the same node), so more than
// one module doing so for the same element is harmless.
export const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
