# Some ideas for additional effects

1. AOE.  If we can identify AOE spells then we should represent those as a ring (cylinder roughly 1 player high) that spread out from the caster.  That cylinder should be able to be sliced into just an arc.  we'd bound the left and right edge to the 'furthest' players hit.  If the ability hits 80% of the raid then we'd draw it as a full circle.

2. offensive buff. We should show this as a sphere around the player. transparent and nice.

3. defensive.  this should show up as a cube around the player (no top/bottom) when active we would change the spell-hit animations to 'bounce off a short distance.

4. knock up. iinterrupts fly along the ground from the caster to the target.  when they hit the target is bounced up into the air 1-2x their height and then fall back down.  at the point of impact we'll have a little 'jet' of particles fly into the interrupted unit from a small radius around them.

3. Debuff. These fly from the caster to the target as just a large sphere (2-3x bigger than the normal damage orb).  they fly in an almost "L" shaped path. from the caster to directly over the target then straight down. Very little curve in this path.  they travel at a 'normal' speed to the apex of the path then accelerate to double speed when they hit the target.

4. death beam.  some abilities hit all units along a path either to a target or through a target for some distance.  When these exist we should draw them as a wider path along the floor as a marker and then the spell itself would follow along that path. to the end.

5. puddle. Some abilities are ground targeted. we should draw these as little circles on the ground with a small border wall. we probably need a list of sizes for these items.  if we have the x/7 coord where it's cast then great, otherwise we may have to compute one by drawing a ring around all targets it hits.

when a player has multiple buffs or debuffs we'll show those as a second cube/sphere slightly larger (maybe 0.25 character radius further out). We'll probably want to color code these.

To drive this we'll need a categorization system for buffs/debuffs - probably a list of spell ids or something.  we'll also need a list of how important each one is: we'll only show "important" ones.  this list should be easily configurable.
