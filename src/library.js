import { getUserItem, setUserItem } from "./userData";

const YEARS = Array.from({ length: 17 }, (_, index) => 2007 + index);

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
    workbookSource: `${import.meta.env.BASE_URL}library/postgraduate/${year}/${year}-text-${text}.pdf`,
    referencePdfSource: `${import.meta.env.BASE_URL}library/postgraduate/${year}/reference/${year}-text-${text}-original.pdf`,
  }));
});

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
