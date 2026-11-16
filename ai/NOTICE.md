# Picture AI files

These files let the app understand a picture on the phone itself. Nothing is uploaded.

- `depth.onnx`: Depth Anything V2 Small (Apache-2.0), converted to ONNX and made smaller (8-bit and 16-bit weights).
- `seg.onnx`: DeepLabV3 with MobileNetV2, trained on ADE20K, from the TensorFlow models repository (Apache-2.0), converted to ONNX.
- `ort.wasm.min.js`, `ort-wasm*.wasm`: ONNX Runtime Web 1.17.3 (MIT).
- `pai-core.js`, `worker.js`: PicAlive code that turns the two results into a living 3D scene.
