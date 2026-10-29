# Terminal skin artwork

`ollobot-jump.png` is the transparent four-pose Ollo atlas from
`mixcode/lasini/images/runtime/ollo-jump.png`, reused at the user's request.
The crop coordinates in `src/ui/theme.ts` follow lasini's `js/notbeme.js`
(`OLLO_JUMP_RECTS`, normalized to 1280 × 1280).

The build copies this directory into `dist/assets/skins/`. Runtime loading
uses packaged assets and does not depend on the neighboring lasini project.

To add a skin, register its palette and optional `loadingAnimation` in
`src/ui/theme.ts`, and place its PNG atlas here. The generic renderer handles
alpha blending, caching, frame timing, and cleanup on unmount.
