export function createRefreshQueue(load: (force: boolean) => Promise<void>) {
  type Pending = {
    promise: Promise<void>;
    resolve: () => void;
    reject: (cause: unknown) => void;
    trailing: boolean;
    force: boolean;
  };
  let pending: Pending | null = null;

  async function drain(work: Pending, force: boolean) {
    let failed = false;
    let failure: unknown;
    do {
      work.trailing = false;
      work.force = false;
      try { await load(force); failed = false; }
      catch (cause) { failure = cause; failed = true; }
      force = work.force;
    } while (work.trailing);
    // Clear synchronously before settling so a completion callback can start a new read.
    pending = null;
    if (failed) work.reject(failure);
    else work.resolve();
  }

  return {
    refresh(force = false): Promise<void> {
      if (pending) {
        pending.trailing = true;
        pending.force ||= force;
        return pending.promise;
      }
      let resolve!: () => void;
      let reject!: (cause: unknown) => void;
      const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      const work: Pending = { promise, resolve, reject, trailing: false, force: false };
      pending = work;
      void drain(work, force);
      return promise;
    },
    isPending: () => pending !== null,
  };
}
