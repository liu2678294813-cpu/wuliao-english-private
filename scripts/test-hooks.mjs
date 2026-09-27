// 测试专用：注册 ESM loader，让 node --test 能解析源码的无扩展名相对导入。
import { register } from "node:module";

register("./esm-extension-loader.mjs", import.meta.url);
