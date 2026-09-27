// 测试专用 loader：项目源码使用 Vite 风格的无扩展名相对导入，
// Node 原生 ESM 需要显式扩展名。这里只用于 node --test，不影响应用运行。
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    try {
      return await nextResolve(specifier, context);
    } catch (error) {
      if (error && error.code === "ERR_MODULE_NOT_FOUND") {
        return nextResolve(`${specifier}.js`, context);
      }
      throw error;
    }
  }
  return nextResolve(specifier, context);
}
