import { useEffect } from "react";
import { onAppEvent } from "../events/appEvents.js";
import { ANSWERS_CHANGED, IMPORT_CHANGED } from "./repository.js";

export default function AnswerRegrading({ username }) {
  useEffect(() => {
    const abort = new AbortController();
    let running = false, pending = false;
    const resume = async () => {
      pending = true;
      if (running || abort.signal.aborted) return;
      running = true;
      try {
        const { resumeAnswerRegrading } = await import("./answers.js");
        while (pending && !abort.signal.aborted) {
          pending = false;
          await resumeAnswerRegrading({ signal: abort.signal });
        }
      } catch (error) {
        if (!abort.signal.aborted) console.warn("Local answer regrading will resume on the next checkpoint", error.message);
      } finally { running = false; }
    };
    const timer = setTimeout(resume, 0);
    const offAnswers = onAppEvent(ANSWERS_CHANGED, resume);
    const offImport = onAppEvent(IMPORT_CHANGED, resume);
    window.addEventListener("focus", resume);
    return () => { abort.abort(); clearTimeout(timer); offAnswers(); offImport(); window.removeEventListener("focus", resume); };
  }, [username]);
  return null;
}
