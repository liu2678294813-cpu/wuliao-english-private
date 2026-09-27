import test from "node:test";
import assert from "node:assert/strict";
import {
  createDeepInkGeometryAdapter,
  deepInkPreviewLayout,
  deepInkPreviewPoint,
  deriveReaderPanelOffset,
  finalizeDeepRegionStroke,
  projectDeepRegionStroke,
  selectDeepInkRegion,
  stageIdForDeepInkStroke,
} from "../src/deepInkGeometry.js";
import { deepInkDigest, mergeDeepInkStrokes, partitionDeepInkByStage } from "../src/deepStageInk.js";

const contentRect = { left: 0, top: 0, width: 1000, height: 1000 };
const snapshot = {
  contentRect,
  regions: [
    { id: "stage:deep-clean-text", stageId: "deep-clean-text", left: 0, top: 0, right: 1, bottom: 0.8, priority: 2 },
    { id: "sentence:clean:p1:s1", stageId: "deep-clean-text", left: 0.1, top: 0.1, right: 0.5, bottom: 0.3, priority: 0 },
    { id: "sentence:clean:p1:s2", stageId: "deep-clean-text", left: 0.5, top: 0.1, right: 0.9, bottom: 0.3, priority: 0 },
  ],
};
snapshot.byId = new Map(snapshot.regions.map((region) => [region.id, region]));

test("live preview shares the committed paper pixel grid at fractional origins, scaling and tile seams", () => {
  const surface = { width: 920, height: 18001 };
  const ratio = 1.5;
  for (const scale of [.6, .75, 1, 1.25]) {
    for (const top of [100.137, -432.237, -2048 * scale - .371, -16001.113 * scale]) {
      const rect = { left: 127.237, top, width: surface.width * scale, height: surface.height * scale };
      const layout = deepInkPreviewLayout(rect, surface, 768, ratio);
      const start = (layout.top - rect.top) / scale;
      assert.ok(Math.abs(start * ratio - Math.round(start * ratio)) < 1e-8);
      assert.ok(layout.height <= 768 / scale + 1, "only a visible band, not the full document");
      for (const point of [{ x: .1237, y: .0237 }, { x: .7931, y: .8913 }]) {
        const pixel = deepInkPreviewPoint(point, { rect, surface }, layout);
        assert.ok(Math.abs(pixel[0] - point.x * surface.width) < 1e-8);
        assert.ok(Math.abs(pixel[1] + start - point.y * surface.height) < 1e-8);
      }
    }
  }
});

test("uniform paper scaling keeps stroke width padding and region attachment in logical coordinates", () => {
  const source = { tool: "pen", width: 4, points: [{ x: .103, y: .16 }, { x: .3, y: .2 }] };
  const scaled = { ...snapshot, contentRect: { left: 18, top: -400, width: 500, height: 500 }, logicalRect: contentRect };
  assert.equal(selectDeepInkRegion(source, scaled).id, selectDeepInkRegion(source, snapshot).id);
  assert.deepEqual(finalizeDeepRegionStroke(source, scaled), finalizeDeepRegionStroke(source, snapshot));
});

test("region-v2：选择完整容纳 bounds 的最小稳定 region，跨句回退 stage", () => {
  const local = { tool: "pen", width: 4, points: [{ x: 0.2, y: 0.16 }, { x: 0.3, y: 0.2 }] };
  assert.equal(selectDeepInkRegion(local, snapshot).id, "sentence:clean:p1:s1");
  const cross = { tool: "pen", width: 4, points: [{ x: 0.3, y: 0.16 }, { x: 0.7, y: 0.2 }] };
  assert.equal(selectDeepInkRegion(cross, snapshot).id, "stage:deep-clean-text");
});

test("region-v2：canonical 保留 v1 x/y，投影随 region 更新且不覆写 canonical", () => {
  const source = { tool: "pen", width: 4, points: [{ x: 0.2, y: 0.16, pressure: 0.5 }] };
  const canonical = finalizeDeepRegionStroke(source, snapshot);
  assert.equal(canonical.coordinateSpace, "deep-region-v2");
  assert.deepEqual(canonical.points[0].deepLocal, { x: 0.25, y: 0.3 });
  assert.deepEqual(canonical.points[0].x, 0.2);
  const moved = { ...snapshot, regions: snapshot.regions.map((region) => region.id === "sentence:clean:p1:s1" ? { ...region, top: 0.4, bottom: 0.6 } : region) };
  moved.byId = new Map(moved.regions.map((region) => [region.id, region]));
  const projected = projectDeepRegionStroke(canonical, moved);
  assert.equal(projected.points[0].y, 0.46);
  assert.equal(canonical.points[0].y, 0.16);
});

test("region-v2：region 消失使用 v1 fallback，不丢 stroke", () => {
  const source = finalizeDeepRegionStroke({ tool: "pen", width: 4, points: [{ x: 0.2, y: 0.16 }] }, snapshot);
  assert.equal(projectDeepRegionStroke(source, { contentRect, regions: [], byId: new Map() }), source);
});

test("region-v2：无采样会话的旧调用仍读取新 geometry snapshot", () => {
  let freshReads = 0;
  const moved = { ...snapshot, regions: snapshot.regions.map((region) => region.id === "sentence:clean:p1:s1" ? { ...region, top: 0.4, bottom: 0.6 } : region) };
  moved.byId = new Map(moved.regions.map((region) => [region.id, region]));
  const adapter = createDeepInkGeometryAdapter(() => snapshot, () => {
    freshReads += 1;
    return moved;
  });
  const canonical = adapter.finalizeStroke({ tool: "pen", width: 4, points: [{ x: 0.2, y: 0.46 }] });
  assert.equal(freshReads, 1);
  assert.equal(canonical.deepAnchor.regionId, "sentence:clean:p1:s1");
});

test("region-v2：布局在采样后变化也必须用起笔快照解释坐标", () => {
  let current = snapshot;
  const adapter = createDeepInkGeometryAdapter(() => current, () => current);
  const active = {};
  adapter.beginStroke(active);
  current = { ...snapshot, regions: snapshot.regions.map(region => region.id === "sentence:clean:p1:s1" ? { ...region, top: .4, bottom: .6 } : region) };
  current.byId = new Map(current.regions.map(region => [region.id, region]));
  const canonical = adapter.finalizeStroke({ tool: "pen", width: 4, points: [{ x: .2, y: .16 }] }, { active });
  assert.equal(canonical.deepAnchor.regionId, "sentence:clean:p1:s1");
  assert.deepEqual(canonical.points[0].deepLocal, { x: .25, y: .3 });
  assert.equal(adapter.projectStroke(canonical).points[0].y, .46);
});

test("panel geometry：有安全左空间时可见左移，832×544 的受限空间也不直接归零", () => {
  assert.equal(deriveReaderPanelOffset({ workspaceRect: { left: 0 }, contentRect: { left: 200, right: 900 }, panelRects: [{ left: 700, width: 220, height: 400 }] }), -170);
  assert.equal(deriveReaderPanelOffset({ workspaceRect: { left: 0 }, contentRect: { left: 200, right: 900 }, panelRects: [{ left: 700, width: 220, height: 400 }, { left: 760, width: 180, height: 400 }] }), -170, "双 panel 取最近边界，不能叠加两次 translate");
  const tablet = deriveReaderPanelOffset({ workspaceRect: { left: 0 }, contentRect: { left: 24, right: 820 }, panelRects: [{ left: 520, width: 280, height: 440 }] });
  assert.ok(tablet < 0, "832px viewport 有 16px 安全容量时仍必须左移");
  assert.equal(deriveReaderPanelOffset({ workspaceRect: { left: 0 }, contentRect: { left: 8, right: 800 }, panelRects: [{ left: 600, width: 220, height: 400 }] }), 0);
});

test("阶段字迹：stage anchor 优先，旧全局坐标按所在阶段唯一分组", () => {
  const stageSnapshot = {
    contentRect,
    regions: [
      { id: "stage:deep-cover", stageId: "deep-cover", left: 0, top: 0, right: 1, bottom: 0.45, priority: 2 },
      { id: "stage:deep-first-read", stageId: "deep-first-read", left: 0, top: 0.55, right: 1, bottom: 1, priority: 2 },
    ],
  };
  stageSnapshot.byId = new Map(stageSnapshot.regions.map((region) => [region.id, region]));
  const anchored = { tool: "pen", deepAnchor: { regionId: "stage:deep-cover" }, points: [{ x: 0.5, y: 0.8 }] };
  const global = { tool: "pen", points: [{ x: 0.4, y: 0.72 }, { x: 0.6, y: 0.76 }] };
  assert.equal(stageIdForDeepInkStroke(anchored, stageSnapshot), "deep-cover");
  assert.equal(stageIdForDeepInkStroke(global, stageSnapshot), "deep-first-read");
  const partition = partitionDeepInkByStage([anchored, global], stageSnapshot, ["deep-cover", "deep-first-read"]);
  assert.equal(partition.unresolved.length, 0);
  assert.deepEqual(partition.byStage["deep-cover"], [anchored]);
  assert.deepEqual(partition.byStage["deep-first-read"], [global]);
});

test("阶段字迹：迁移合并幂等且摘要能识别源数据变化", () => {
  const first = { tool: "pen", points: [{ x: 0.1, y: 0.2 }] };
  const second = { tool: "pen", points: [{ x: 0.3, y: 0.4 }] };
  assert.deepEqual(mergeDeepInkStrokes([first], [first, second]), [first, second]);
  assert.equal(deepInkDigest([first]), deepInkDigest([first]));
  assert.notEqual(deepInkDigest([first]), deepInkDigest([first, second]));
});
