export class EdfWorkerClient {
  constructor() {
    this.worker = new Worker(new URL("./edfWorker.js", import.meta.url), { type: "module" });
    this.pending = new Map();
    this.nextId = 1;
    this.worker.addEventListener("message", (event) => {
      const { id, ok, study, result, error } = event.data;
      const callbacks = this.pending.get(id);
      if (!callbacks) return;
      this.pending.delete(id);
      if (ok) callbacks.resolve(study || result);
      else callbacks.reject(new Error(error || "EDF worker failed."));
    });
  }

  request(type, payload) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, ...payload });
    });
  }

  loadStudy(file) {
    return this.request("load-study", { file });
  }

  readWindow(request) {
    return this.request("read-window", { request });
  }
}
