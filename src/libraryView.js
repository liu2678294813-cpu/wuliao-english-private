export function customResourceVisibleInLibrary(resource, libraryMode) {
  if (!resource || resource.kind !== "custom") return false;
  if (resource.conversionStatus !== "ready") return true;
  if (libraryMode === "cloze") return Boolean(resource.analysis?.clozes?.length);
  return Boolean(resource.analysis?.passages?.length);
}

export function selectCustomLibraryResources(resources, libraryMode) {
  return (Array.isArray(resources) ? resources : [])
    .filter((resource) => customResourceVisibleInLibrary(resource, libraryMode));
}

