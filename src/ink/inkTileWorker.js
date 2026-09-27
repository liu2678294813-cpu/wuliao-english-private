import { drawInkStroke } from "../annotationTools.js";
import { unpackInkTileStrokes } from "./inkTileTransfer.js";

// Replay the identical ink engine off the UI thread. Completed bitmaps retain
// the paper's pixel grid; no point reduction, alternative curves or lossy images.
self.onmessage = ({ data }) => {
  try {
    const { id, strokes, pointData, width, height, ratio, offsetY, pixelWidth, pixelHeight } = data;
    const canvas = new OffscreenCanvas(pixelWidth, pixelHeight);
    const context = canvas.getContext("2d", { alpha: true });
    context.scale(ratio, ratio);
    context.translate(0, -offsetY);
    for (const stroke of unpackInkTileStrokes(strokes, pointData)) drawInkStroke(context, stroke, width, height);
    const bitmap = canvas.transferToImageBitmap();
    self.postMessage({ id, bitmap }, [bitmap]);
  } catch {
    self.postMessage({ id: data.id, failed: true });
  }
};
