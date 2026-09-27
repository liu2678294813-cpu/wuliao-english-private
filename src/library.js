import { getUserItem, setUserItem } from "./userData";
import { normalizeCloze } from "./clozeParser";

const YEARS = Array.from({ length: 17 }, (_, index) => 2007 + index);
const env = (typeof import.meta !== "undefined" && import.meta.env) || {};
const assetBase = env.BASE_URL || "";

export const postgraduateResources = YEARS.flatMap((year) => {
  const texts = [1, 2, 3, 4];
  return texts.map((text) => ({
    id: `postgraduate-${year}-text-${text}`,
    kind: "official",
    category: "postgraduate",
    year,
    text,
    title: `${year} 英语（一）Text ${text}`,
    subtitle: "Part A · 精读全流程",
    workbookSource: `${assetBase}library/postgraduate/${year}/${year}-text-${text}.pdf`,
    referencePdfSource: `${assetBase}library/postgraduate/${year}/reference/${year}-text-${text}-original.pdf`,
  }));
});

export const postgraduateClozeResources = YEARS.map((year) => ({
  id: `postgraduate-${year}-cloze`,
  kind: "official-cloze",
  category: "postgraduate-cloze",
  year,
  title: `${year} 英语（一）完形填空`,
  subtitle: "Section I · Use of English · 正式训练",
  clozeSource: `${assetBase}library/postgraduate/${year}/${year}-cloze.json`,
}));

const officialClozeCache = new Map();

export async function loadOfficialCloze(resource) {
  if (!resource?.clozeSource) throw new Error("完形资料缺少数据地址");
  if (officialClozeCache.has(resource.id)) return officialClozeCache.get(resource.id);
  const response = await fetch(resource.clozeSource, { cache: "no-store" });
  if (!response.ok) throw new Error(`完形数据读取失败（${response.status}）`);
  const cloze = normalizeCloze(await response.json());
  if (!cloze) throw new Error("完形数据格式无效");
  officialClozeCache.set(resource.id, cloze);
  return cloze;
}

const progressKey = (id) => `wuliao:progress:${id}`;

export function readProgress(id) {
  try {
    return JSON.parse(getUserItem(progressKey(id))) || null;
  } catch {
    return null;
  }
}

export function saveProgress(resource, page, total) {
  setUserItem(
    progressKey(resource.id),
    JSON.stringify({
      id: resource.id,
      title: resource.title,
      page,
      total,
      updatedAt: Date.now(),
    }),
  );
}

export function getRecentProgress() {
  return postgraduateResources
    .map((resource) => ({ resource, progress: readProgress(resource.id) }))
    .filter((item) => item.progress)
    .sort((a, b) => b.progress.updatedAt - a.progress.updatedAt)
    .slice(0, 3);
}
