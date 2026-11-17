# PicAlive AR

Point your phone camera at a picture, poster or billboard and watch it come alive.

**Open the app:** https://afaqali11.github.io/picalive/

## How to use it
1. Open the link above on your phone in Safari (iPhone) or Chrome (Android).
2. Tap **Add picture**, take or pick a photo of the picture you want to bring to life.
3. The app studies the picture: it finds the sky, water, waterfalls, trees, people and lights, and measures how deep everything is. Then it moves each part in its own way and turns the picture into a 3D scene.
4. Tap **Open AR camera**, allow the camera, and point at the real picture.

**3D scan a product:** tap "3D scan a product", take one photo of it, and the app builds a 3D model you can turn with your finger, save as a GLB file, view in your room on iPhone, or record as a turntable video. The front shape comes from the photo's real depth. The back and sides are guessed (rounded and mirrored), because one photo cannot see them.

Everything runs on your phone. Your pictures are not uploaded anywhere. The first time, the phone downloads the picture AI (about 45 MB); after that it is kept.

## What is inside
`index.html` is the app. It uses three.js for drawing and MindAR for image tracking, both bundled inside the file. The `ai/` folder holds the on-device picture AI (see `ai/NOTICE.md`).
