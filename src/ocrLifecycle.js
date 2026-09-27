export const OCR_WORKER_INIT_TIMEOUT_MS = 60_000;
export const OCR_PAGE_TIMEOUT_MS = 120_000;

export class PdfImportError extends Error {
  constructor(code, message, cause = null, diagnostics = null) {
    super(message);
    this.name = "PdfImportError";
    this.code = code;
    this.cause = cause;
    this.diagnostics = diagnostics;
  }
}

function cancelledError(cause = new Error("Aborted")) {
  return new PdfImportError("cancelled", "已取消解析", cause);
}

export function abortCheck(signal) {
  if (signal?.aborted) throw cancelledError(signal.reason || undefined);
}

function linkAbortSignal(parentSignal, childController) {
  if (!parentSignal) return () => {};
  const forwardAbort = () => childController.abort(parentSignal.reason);
  if (parentSignal.aborted) forwardAbort();
  parentSignal.addEventListener("abort", forwardAbort, { once: true });
  return () => parentSignal.removeEventListener("abort", forwardAbort);
}

function timeoutValue(timeoutError) {
  return typeof timeoutError === "function" ? timeoutError() : timeoutError;
}

// A timed operation consumes late rejection and lets the caller clean up a late value.
export function withTimeoutAndAbort(operation, {
  signal,
  timeoutMs,
  timeoutError,
  onLateResolve,
} = {}) {
  if (signal?.aborted) return Promise.reject(cancelledError(signal.reason || undefined));

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let removeAbort = () => {};

    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      removeAbort();
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    Promise.resolve()
      .then(operation)
      .then(
        (value) => {
          if (settled) {
            Promise.resolve(onLateResolve?.(value)).catch(() => {});
            return;
          }
          settled = true;
          cleanup();
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
      );

    if (signal) {
      const handleAbort = () => fail(cancelledError(signal.reason || undefined));
      signal.addEventListener("abort", handleAbort, { once: true });
      removeAbort = () => signal.removeEventListener("abort", handleAbort);
    }
    if (Number.isFinite(timeoutMs)) {
      timer = setTimeout(() => fail(timeoutValue(timeoutError)), timeoutMs);
    }
  });
}

async function terminateWorker(worker) {
  if (!worker || typeof worker.terminate !== "function") return;
  try {
    await worker.terminate();
  } catch {
    // Termination is best effort after an already failed worker.
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function runOcrPages(pdfDocument, pageNumbers, {
  onProgress,
  signal,
  createWorker,
  processPage,
  workerInitTimeoutMs = OCR_WORKER_INIT_TIMEOUT_MS,
  pageTimeoutMs = OCR_PAGE_TIMEOUT_MS,
} = {}) {
  if (!pageNumbers.length) return {};
  if (typeof createWorker !== "function") throw new TypeError("createWorker is required");
  if (typeof processPage !== "function") throw new TypeError("processPage is required");

  const state = { currentPage: 0, totalPages: pageNumbers.length, done: 0 };
  onProgress?.({
    phase: "ocr-loading",
    stage: "worker-init",
    page: 0,
    total: pageNumbers.length,
    percent: 33,
  });

  let worker;
  try {
    const initController = new AbortController();
    const unlinkInitAbort = linkAbortSignal(signal, initController);
    try {
      worker = await withTimeoutAndAbort(
        () => createWorker({ state, signal: initController.signal }),
        {
          signal,
          timeoutMs: workerInitTimeoutMs,
          timeoutError: () => {
            initController.abort(new Error("OCR worker initialization timed out"));
            return new PdfImportError("ocr-init-timeout", "本地 OCR 初始化超时，请重试");
          },
          onLateResolve: terminateWorker,
        },
      );
    } catch (error) {
      if (error instanceof PdfImportError) throw error;
      if (signal?.aborted) throw cancelledError(error);
      throw new PdfImportError("ocr-init-failed", `本地 OCR 初始化失败：${errorMessage(error)}`, error);
    } finally {
      unlinkInitAbort();
      initController.abort();
    }

    const results = {};
    for (let index = 0; index < pageNumbers.length; index += 1) {
      abortCheck(signal);
      const pageNumber = pageNumbers[index];
      state.currentPage = pageNumber;
      const pageController = new AbortController();
      const unlinkPageAbort = linkAbortSignal(signal, pageController);
      try {
        const text = await withTimeoutAndAbort(
          () => processPage({ pdfDocument, pageNumber, worker, signal: pageController.signal }),
          {
            signal,
            timeoutMs: pageTimeoutMs,
            timeoutError: () => {
              pageController.abort(new Error("OCR page recognition timed out"));
              return new PdfImportError("ocr-page-timeout", `OCR 第 ${pageNumber} 页超时，请重试`);
            },
          },
        );
        results[pageNumber] = text || "";
        state.done = index + 1;
        onProgress?.({
          phase: "ocr",
          page: pageNumber,
          total: pageNumbers.length,
          percent: 34 + Math.round(((index + 1) / pageNumbers.length) * 54),
          pagePercent: 100,
        });
      } catch (error) {
        if (error instanceof PdfImportError) throw error;
        if (signal?.aborted) throw cancelledError(error);
        throw new PdfImportError("ocr-page-failed", `OCR 第 ${pageNumber} 页失败：${errorMessage(error)}`, error);
      } finally {
        unlinkPageAbort();
        pageController.abort();
      }
    }
    return results;
  } finally {
    await terminateWorker(worker);
  }
}
