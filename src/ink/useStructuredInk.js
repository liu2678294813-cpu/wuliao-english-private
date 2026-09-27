// React 接入层：把无 React 依赖的 Shared Ink Runtime 控制器绑定到组件生命周期。
// - 控制器只创建一次（useRef 缓存），业务回调通过 setDeps 每次渲染刷新，
//   因此 persistStrokes / commitAppendStroke / renderCommitted 等闭包永不过期。
// - unmount 时调用 dispose() 清理 rAF 与未结束的笔迹会话（兜底，不作为数据保障主路径）。

import { useEffect, useLayoutEffect, useRef } from "react";
import { createInkRuntimeController } from "./inkRuntime";

export function useStructuredInk(deps) {
  const controllerRef = useRef(null);
  if (!controllerRef.current) {
    controllerRef.current = createInkRuntimeController(deps);
  }
  useLayoutEffect(() => {
    controllerRef.current.setDeps(deps);
  });
  useEffect(() => () => {
    controllerRef.current.dispose();
  }, []);
  useEffect(() => controllerRef.current.attachRawInput());
  return controllerRef.current;
}
