if (typeof ReadableStream !== "undefined" && typeof Symbol !== "undefined") {
  if (!Symbol.asyncIterator) {
    Object.defineProperty(Symbol, "asyncIterator", {
      configurable: true,
      value: Symbol("Symbol.asyncIterator"),
    });
  }

  const streamPrototype = ReadableStream.prototype;
  if (!streamPrototype[Symbol.asyncIterator] && typeof streamPrototype.getReader === "function") {
    Object.defineProperty(streamPrototype, Symbol.asyncIterator, {
      configurable: true,
      value() {
        const reader = this.getReader();
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          reader.releaseLock?.();
        };
        return {
          async next() {
            const result = await reader.read();
            if (result.done) release();
            return result;
          },
          async return() {
            try {
              await reader.cancel();
            } finally {
              release();
            }
            return { done: true };
          },
          [Symbol.asyncIterator]() {
            return this;
          },
        };
      },
    });
  }
}
