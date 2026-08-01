import { isAndroidApp } from "./platform";

function installReadableStreamAsyncIterator() {
  const prototype = globalThis.ReadableStream?.prototype;
  if (!prototype || typeof Symbol === "undefined" || typeof prototype[Symbol.asyncIterator] === "function") {
    return false;
  }

  Object.defineProperty(prototype, Symbol.asyncIterator, {
    configurable: true,
    writable: true,
    async *value() {
      const reader = this.getReader();
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) return;
          yield result.value;
        }
      } finally {
        reader.releaseLock();
      }
    },
  });
  return true;
}

if (isAndroidApp()) installReadableStreamAsyncIterator();
