/**
 * Inter-token idle guard: arms only after the first token (prefill is
 * exempt) and fires `onIdle` when no chunk arrives within the deadline.
 * Fire semantics: the caller aborts the stream; `fired` distinguishes
 * idle timeout from user stop / client disconnect.
 */

export type IdleGuard = {
  readonly fired: boolean;
  arm(): void;
  clear(): void;
};

export function createIdleGuard(timeoutMs: number, onIdle: () => void): IdleGuard {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let fired = false;

  return {
    get fired() {
      return fired;
    },
    arm() {
      if (timer !== null) clearTimeout(timer);
      if (timeoutMs <= 0) return;
      timer = setTimeout(() => {
        fired = true;
        timer = null;
        onIdle();
      }, timeoutMs);
    },
    clear() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
