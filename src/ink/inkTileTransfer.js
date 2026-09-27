// Transfer derived render coordinates, never the saved point objects. Float64
// preserves JavaScript number precision and avoids cloning thousands of nested
// pressure/tilt/anchor objects on the UI thread for every newly visible tile.
export function packInkTileStrokes(strokes) {
  const pointCount = strokes.reduce((count, stroke) => count + (stroke.points?.length || 0), 0);
  const pointData = new Float64Array(pointCount * 3);
  let offset = 0;
  const metadata = strokes.map(({ points = [], ...stroke }) => {
    for (const point of points) {
      pointData[offset++] = point.x;
      pointData[offset++] = point.y;
      pointData[offset++] = Number.isFinite(point.pressure) ? point.pressure : NaN;
    }
    return { ...stroke, pointCount: points.length };
  });
  return { strokes: metadata, pointData };
}

export function unpackInkTileStrokes(strokes, pointData) {
  let offset = 0;
  return strokes.map(({ pointCount, ...stroke }) => {
    const points = [];
    for (let index = 0; index < pointCount; index++) {
      points.push({ x: pointData[offset++], y: pointData[offset++], pressure: pointData[offset++] });
    }
    return { ...stroke, points };
  });
}
