import { AssistantMessageRow } from './AssistantMessageRow';
import { SystemMessageRow } from './SystemMessageRow';
import { UserMessageRow } from './UserMessageRow';
import type { ChatViewStatus, DisplayRow } from './types';

/** Per-row edit + retry affordances; extracted to keep ChatView shallow. */
export function MessageRow(props: {
  row: DisplayRow;
  isLast: boolean;
  isLastUser: boolean;
  busy: boolean;
  status: ChatViewStatus;
  onRetryLast: () => void;
  onEditMessage: (messageId: string, content: string) => Promise<boolean>;
}) {
  const role = props.row.message.role;
  if (role === 'system') return <SystemMessageRow row={props.row} />;
  if (role === 'user') return <UserMessageRow {...props} />;
  if (role === 'assistant') return <AssistantMessageRow {...props} />;
  return null;
}
