import { describe, expect, it } from 'vitest';
import { editMessage } from '../messages/edit.ts';
import { renameThread } from '../threads/thread.ts';
import { pathOf } from './endpoint.ts';

describe('input read through an endpoint schema', () => {
  it('keeps only the keys the schema names', () => {
    expect(renameThread.body.parse({ title: 'Trip', userId: 'someone-else', admin: true })).toEqual(
      {
        title: 'Trip',
      },
    );
  });

  it('refuses a value of the wrong type', () => {
    expect(renameThread.body.safeParse({ title: 42 }).success).toBe(false);
    expect(renameThread.params.safeParse({ id: 'not-an-id' }).success).toBe(false);
  });

  it('keeps text as sent but refuses text that is only whitespace', () => {
    expect(editMessage.body.parse({ content: '  hi  ' })).toEqual({ content: '  hi  ' });
    expect(editMessage.body.safeParse({ content: '   ' }).success).toBe(false);
  });
});

describe('pathOf', () => {
  it('fills each parameter, escaped', () => {
    expect(pathOf(renameThread, { id: 'a b/c' })).toBe('/api/threads/a%20b%2Fc');
  });

  it('refuses a path with a parameter left unfilled', () => {
    expect(() => pathOf(renameThread)).toThrow('needs a value for id');
  });
});
