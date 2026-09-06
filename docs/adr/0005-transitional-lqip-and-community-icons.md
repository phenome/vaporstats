# One sticky game header with FLIP morphing and dual LQIP storage

**Status:** Accepted

VaporStats uses a stable wrapper as one sticky header element (`position: sticky; top: 3.5rem`, below the 56px site header) that retains the expanded header height. The inner header is neither fixed nor sticky: it retains the expanded layout boxes while its single DOM subtree morphs in place. The expanded and compact states never render separate header subtrees. Each persistent identity element has exactly one DOM instance inside that inner header: the title, Steam store link, status tag, main released date, and artwork shell.

The header uses scroll-position-driven FLIP-style interpolation. When the expanded hero reaches the sticky boundary, the implementation captures or defines the expanded and compact geometry for each element, then clamps scroll progress from 0 to 1 and interpolates the same elements' translation, scale, and dimensions between those geometries. This preserves semantic identity, focus targets, and accessibility while the layout changes in place. The choreography uses overlapping phases:

- **Exit phase (0–60% progress):** Description, lifecycle overview, developer/publisher metadata, and game type when omitted from the compact layout fade out only. These elements have no compact destination and are excluded from geometry interpolation.
- **Destination/morph phase (40–100% progress):** The header padding and persistent identity elements move toward their compact geometry. The artwork shell remains the same element while its geometry morphs from the landscape hero position to the compact 32×32 destination. Its visual content crossfades from the header image to the Steam Community icon, or to the icon LQIP until that icon is available. On mobile, the compact state retains the artwork and a truncated title; on desktop it also retains the status tag, main released date, and Steam store link.

**No-reflow invariant:** FLIP morphing must not move downstream document content. The stable wrapper remains `position: sticky` at `top: 3.5rem` and permanently reserves the measured expanded header height as equal flow compensation. The inner header is neither fixed nor sticky; it retains the expanded layout boxes and morphs only with transforms and opacity. The wrapper's transparent region does not intercept pointer events; interactive survivors opt into pointer events. Elements without destinations fade only and never participate in geometry interpolation.

To prevent layout shifts and blank image flashes across both states:

1. **Dual LQIP storage:** SQLite stores precomputed inline base64 placeholders for both the full landscape header image (`apps.header_lqip`) and the compact square icon (`apps.icon_lqip`). Placeholders are generated with Bun 1.4 native image processing (`Bun.Image`).
2. **Transitional square LQIP:** Until ingestion backfills the Steam Community icon hash (`apps.icon_hash`), derive the square placeholder by resizing the stored header image to 32×32 without cropping, preserving the full image content in the reduced bitmap. When the missing icon is rendered, the generated placeholder may be lazily backfilled into the database.
3. **Asset upgrade:** Once `icon_hash` is ingested, the artwork shell uses Steam's official 1:1 Community icon for the compact visual state.
