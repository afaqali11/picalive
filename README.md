# PicAlive 3D

Turn real products into 3D models you can spin all the way round and place in your room at real size.

**Open the app:** https://afaqali11.github.io/picalive/

## How to use it
1. Open the link above on your phone in Safari (iPhone) or Chrome (Android).
2. Tap **New 360° scan** and walk slowly around the product. The app takes sharp photos by itself and shows a ring that fills as you go round.
3. Check the four main views (front, left, back, right) and tap **Build 3D model**. The photos go to the 3D service you set up in **3D service** (fal.ai: Hunyuan3D 3 or Tripo). Your key is kept only on your phone.
4. Turn the model with your finger, tap **View in my room** to place it at real size, or save it as GLB or USDZ (iPhone).

**Quick draft from 1 photo** builds a rough model on your phone for free. The back is guessed, so use a 360° scan for a real model.

## What is inside
`index.html` is the app (three.js bundled inside). `ai/` holds the on-device cut-out and depth AI used for quick drafts (see `ai/NOTICE.md`). `mv/` holds Google's model-viewer (Apache-2.0, see `mv/LICENSE.txt`) for the 360° viewer and AR placement.
