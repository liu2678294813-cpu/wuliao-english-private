export const BACK_PRIORITY = Object.freeze({
  temporary: 100,
  floating: 200,
  drawer: 300,
  modal: 400,
});

export function resolveBackAction({
  modal = false,
  drawer = false,
  temporary = false,
  immersive = false,
  hasHistory = false,
  iframeHasRoute = false,
} = {}) {
  if (modal) return "close-modal";
  if (drawer) return "close-drawer";
  if (temporary) return "close-temporary";
  if (immersive) return "exit-immersive";
  if (hasHistory) return "history-back";
  if (iframeHasRoute) return "iframe-back";
  return "home-fallback";
}

export function createBackController() {
  const entries = new Map();
  let nextId = 0;

  return {
    register(handler, { priority = 0 } = {}) {
      if (typeof handler !== "function") return () => {};
      const id = nextId;
      nextId += 1;
      entries.set(id, { handler, priority, order: id });
      return () => entries.delete(id);
    },

    handle() {
      const active = [...entries.values()].sort((left, right) => (
        right.priority - left.priority || right.order - left.order
      ));
      for (const entry of active) {
        if (entry.handler() === true) return true;
      }
      return false;
    },
  };
}
