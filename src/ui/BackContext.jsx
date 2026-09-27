import { createContext, useContext, useEffect, useRef } from "react";

const BackControllerContext = createContext(null);

export function BackControllerProvider({ controller, children }) {
  return (
    <BackControllerContext.Provider value={controller}>
      {children}
    </BackControllerContext.Provider>
  );
}

export function useBackHandler(handler, { enabled = true, priority = 0, key = "" } = {}) {
  const controller = useContext(BackControllerContext);
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    if (!controller || !enabled) return undefined;
    return controller.register(() => handlerRef.current(), { priority });
  }, [controller, enabled, key, priority]);
}
