import type { Generated, Insertable, Selectable, Updateable } from 'kysely';

export interface Database {
  users: UsersTable;
  threads: ThreadsTable;
  messages: MessagesTable;
}

export interface UsersTable {
  id: Generated<string>; // UUID
  created_at: Generated<Date>;
}

export interface ThreadsTable {
  id: Generated<string>; // UUID
  user_id: string;
  title: string;
  created_at: Generated<Date>;
}

export interface MessagesTable {
  id: Generated<string>; // UUID
  thread_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: Generated<Date>;
}

export type User = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;

export type Thread = Selectable<ThreadsTable>;
export type NewThread = Insertable<ThreadsTable>;

export type Message = Selectable<MessagesTable>;
export type NewMessage = Insertable<MessagesTable>;
