import { db } from '@db/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach } from 'vitest';

/**
 * Lets a test read which `synchronous_commit` setting each write to a queue
 * job was made under. The database records the setting itself, from
 * inside the session that wrote, so no code path can be read wrong.
 *
 * The recording is DDL on purpose: the setting is only visible from the
 * writing session. Entries from before each test are cleared.
 */
export function useRecordedJobCommits() {
  beforeAll(async () => {
    await sql
      .raw(
        `create table if not exists job_commit_settings (
           id serial primary key,
           operation text not null,
           task text not null,
           setting text not null
         )`,
      )
      .execute(db);
    await sql
      .raw(
        `create or replace function record_job_commit_setting() returns trigger language plpgsql as
         $$
         declare written queues._private_jobs;
         begin
           written := case when tg_op = 'DELETE' then old else new end;
           insert into job_commit_settings (operation, task, setting)
           values (
             tg_op,
             (select identifier from queues._private_tasks where id = written.task_id),
             current_setting('synchronous_commit')
           );
           return null;
         end $$`,
      )
      .execute(db);
    await sql
      .raw(
        `create or replace trigger record_job_commit_setting
         after insert or update or delete on queues._private_jobs
         for each row execute function record_job_commit_setting()`,
      )
      .execute(db);
  });

  beforeEach(async () => {
    await sql.raw('truncate job_commit_settings').execute(db);
  });

  afterAll(async () => {
    await sql
      .raw('drop trigger if exists record_job_commit_setting on queues._private_jobs')
      .execute(db);
    await sql.raw('drop table if exists job_commit_settings').execute(db);
    await sql.raw('drop function if exists record_job_commit_setting()').execute(db);
  });

  /** The setting each write of the kind to the task's jobs ran under, oldest first. */
  return async function commitSettingsOf({
    operation,
    task,
  }: {
    operation: 'INSERT' | 'UPDATE' | 'DELETE';
    task: string;
  }) {
    const { rows } = await sql<{ setting: string }>`
      select setting from job_commit_settings
      where operation = ${operation} and task = ${task}
      order by id`.execute(db);
    return rows.map((row) => row.setting);
  };
}
