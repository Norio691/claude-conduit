/** Per-session mutex to serialize attach operations. */
export class SessionLock {
  private locks = new Map<string, Promise<void>>();

  async acquire<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    // Wait for any existing operation on this session
    const existing = this.locks.get(sessionId);
    if (existing) {
      await existing;
    }

    let resolve: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    this.locks.set(sessionId, promise);

    try {
      return await fn();
    } finally {
      resolve!();
      // Only delete if this is still our lock
      if (this.locks.get(sessionId) === promise) {
        this.locks.delete(sessionId);
      }
    }
  }

  isLocked(sessionId: string): boolean {
    return this.locks.has(sessionId);
  }
}
