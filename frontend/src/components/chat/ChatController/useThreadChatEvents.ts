import type { RestoredDraft } from '@/components/chat/types';
import { fetchResumeDraft } from '@/services/api';
import { VERDICT_PART_TYPE } from '@ari/lib/api/schemas/chat/chat';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { subscribeToThreadChat } from './chatRegistry';
import type { StreamVerdict, UiMessageLike } from './types';
import { lastUserMessage, readVerdictData } from './utils';

/**
 * What the thread's exchanges report to this view: the verdict streaming in
 * for the pending arrival, and a draft to put back in the input after a failed
 * submit or an abandoned exchange. `onSettle` runs after every stream end;
 * `messagesRef` holds the live chat messages.
 */
export function useThreadChatEvents({
  threadId,
  messagesRef,
  onSettle,
}: {
  threadId: string;
  messagesRef: RefObject<UiMessageLike[]>;
  onSettle: () => void;
}) {
  // The transient `data-thread-verdict` part arrives only through `onData`
  // (the SDK keeps it out of message.parts), so the verdict is held here and
  // applied to the pending user bubble before the reply grows.
  const [streamVerdict, setStreamVerdict] = useState<StreamVerdict | null>(null);
  const [restoredDraft, setRestoredDraft] = useState<RestoredDraft | null>(null);

  // Settlement handlers keep the render's identity; the registry
  // subscription is tied to the thread alone.
  const settleRef = useRef({ onSettle });
  settleRef.current = { onSettle };

  // The registry fans exchange events to whichever view is subscribed.
  useEffect(() => {
    return subscribeToThreadChat(threadId, {
      // The verdict flows `onData` as the stream's first event: map it to the
      // pending arrival (the last user message) so the bubble tints before the
      // reply starts growing.
      onData: (part) => {
        if (part.type !== VERDICT_PART_TYPE) return;
        const payload = readVerdictData(part);
        const arrival = lastUserMessage(messagesRef.current);
        if (!payload || !arrival) return;
        setStreamVerdict({ ...payload, userMessageId: arrival.id });
      },
      // After every stream end (including user stop) refetch rows so usage
      // metadata and persisted ids replace the optimistic/streaming state.
      onSettle: () => {
        setStreamVerdict(null);
        settleRef.current.onSettle();
      },
      // A failed submit puts the draft back in the input; recovery is a resend.
      onFailedSubmit: (draft) => {
        setRestoredDraft((prev) => ({ text: draft, nonce: (prev?.nonce ?? 0) + 1 }));
      },
    });
  }, [threadId, messagesRef]);

  // The thread's newest abandoned/failed exchange offers its arrival text
  // back for the input; fetched once per mount, a local draft wins.
  useEffect(() => {
    let cancelled = false;
    void fetchResumeDraft(threadId)
      .then((draft) => {
        if (cancelled || !draft) return;
        setRestoredDraft((prev) => prev ?? { text: draft.text, nonce: 0 });
      })
      .catch(() => {
        // No draft owed, or the API was unavailable — the input stays as-is.
      });
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  return { streamVerdict, restoredDraft };
}
