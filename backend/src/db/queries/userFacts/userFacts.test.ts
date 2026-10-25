import { randomUUID } from 'node:crypto';
import { db } from '@db/db';
import type { FactCategory } from '@db/types';
import { deleteUserFact } from '@queries/userFacts/deleteUserFact';
import { findCurrentUserFact } from '@queries/userFacts/findCurrentUserFact';
import { insertUserFact } from '@queries/userFacts/insertUserFact';
import { listAllUserFacts } from '@queries/userFacts/listAllUserFacts';
import { updateUserFact } from '@queries/userFacts/updateUserFact';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { EMBEDDING_MODEL_ID } from '@services/aiService';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

useTestDb();

async function createUser(userId: string) {
  await insertUserIfNotExists({ id: userId });
}

async function createFact(input: {
  userId: string;
  content: string;
  category?: FactCategory;
  suppressed?: boolean;
}): Promise<{ id: string }> {
  const embedding = Array.from({ length: 1024 }, () => Math.random());
  return insertUserFact({
    userId: input.userId,
    content: input.content,
    category: input.category ?? 'other',
    subject: null,
    predicate: null,
    object: null,
    embedding,
    modelId: EMBEDDING_MODEL_ID,
    sourceMessageId: null,
    validAt: new Date(),
  });
}

describe('listAllUserFacts', () => {
  it('returns empty list when user has no facts', async () => {
    const userId = randomUUID();
    await createUser(userId);

    const facts = await listAllUserFacts({ userId });
    expect(facts).toHaveLength(0);
  });

  it('returns user facts newest first by validAt', async () => {
    const userId = randomUUID();
    await createUser(userId);

    const oldDate = new Date('2024-01-01');
    const newDate = new Date('2024-12-01');

    await insertUserFact({
      userId,
      content: 'Old fact',
      category: 'other',
      subject: null,
      predicate: null,
      object: null,
      embedding: Array.from({ length: 1024 }, () => Math.random()),
      modelId: EMBEDDING_MODEL_ID,
      sourceMessageId: null,
      validAt: oldDate,
    });

    await insertUserFact({
      userId,
      content: 'New fact',
      category: 'other',
      subject: null,
      predicate: null,
      object: null,
      embedding: Array.from({ length: 1024 }, () => Math.random()),
      modelId: EMBEDDING_MODEL_ID,
      sourceMessageId: null,
      validAt: newDate,
    });

    const facts = await listAllUserFacts({ userId });
    expect(facts).toHaveLength(2);
    expect(facts[0]?.content).toBe('New fact');
    expect(facts[1]?.content).toBe('Old fact');
  });

  it('orders an undated fact by when it was noted', async () => {
    const userId = randomUUID();
    await createUser(userId);
    const fact = (content: string, validAt: Date | null) =>
      insertUserFact({
        userId,
        content,
        category: 'other',
        subject: null,
        predicate: null,
        object: null,
        embedding: Array.from({ length: 1024 }, () => Math.random()),
        modelId: EMBEDDING_MODEL_ID,
        sourceMessageId: null,
        validAt,
      });
    await fact('Dated long ago', new Date('2019-01-01T00:00:00Z'));
    await fact('Noted just now', null);

    const facts = await listAllUserFacts({ userId });
    expect(facts.map((f) => [f.content, f.validAt])).toEqual([
      ['Noted just now', null],
      ['Dated long ago', new Date('2019-01-01T00:00:00Z')],
    ]);
  });

  it('includes suppressed facts', async () => {
    const userId = randomUUID();
    await createUser(userId);

    await createFact({ userId, content: 'Visible fact', suppressed: false });
    const fact2 = await createFact({ userId, content: 'Suppressed fact', suppressed: true });

    // Manually set suppressed since insertUserFact doesn't support it
    await db
      .updateTable('memory.userFacts')
      .set({ suppressed: true })
      .where('id', '=', fact2.id)
      .execute();

    const facts = await listAllUserFacts({ userId });
    expect(facts).toHaveLength(2);
    expect(facts.some((f) => f.suppressed)).toBe(true);
  });

  it('excludes invalidated facts', async () => {
    const userId = randomUUID();
    await createUser(userId);

    await createFact({ userId, content: 'Valid fact' });
    const invalidFact = await createFact({ userId, content: 'Invalidated fact' });
    await db
      .updateTable('memory.userFacts')
      .set({ invalidAt: new Date() })
      .where('id', '=', invalidFact.id)
      .execute();

    const facts = await listAllUserFacts({ userId });
    expect(facts).toHaveLength(1);
    expect(facts[0]?.content).toBe('Valid fact');
  });
});

describe('updateUserFact - suppression', () => {
  it('toggles suppression flag', async () => {
    const userId = randomUUID();
    await createUser(userId);

    const fact = await createFact({ userId, content: 'Test fact', suppressed: false });

    const updated = await updateUserFact({ factId: fact.id, userId, suppressed: true });
    expect(updated.suppressed).toBe(true);

    const updatedAgain = await updateUserFact({ factId: fact.id, userId, suppressed: false });
    expect(updatedAgain.suppressed).toBe(false);
  });

  it('throws when fact not found', async () => {
    const userId = randomUUID();
    await createUser(userId);

    await expect(
      updateUserFact({
        factId: '00000000-0000-0000-0000-000000000000',
        userId,
        suppressed: true,
      }),
    ).rejects.toThrow();
  });
});

describe('updateUserFact - replacement', () => {
  function replacementFor(content: string) {
    return {
      content,
      category: 'location' as const,
      subject: 'user',
      predicate: 'lives_in',
      object: 'porto',
      embedding: Array.from({ length: 1024 }, () => Math.random()),
      modelId: EMBEDDING_MODEL_ID,
      sourceMessageId: null,
      validAt: null,
      suppressed: true,
    };
  }

  it('invalidates old fact and inserts the replacement as given', async () => {
    const userId = randomUUID();
    await createUser(userId);

    const oldFact = await createFact({ userId, content: 'Old content' });

    const newFact = await updateUserFact({
      factId: oldFact.id,
      userId,
      replacement: replacementFor('New content'),
    });

    expect(newFact).toMatchObject({
      content: 'New content',
      category: 'location',
      subject: 'user',
      validAt: null,
      suppressed: true,
    });
    expect(newFact.id).not.toBe(oldFact.id);

    // Old fact should be invalidated
    const oldFactRow = await db
      .selectFrom('memory.userFacts')
      .select(['invalidAt'])
      .where('id', '=', oldFact.id)
      .executeTakeFirst();
    expect(oldFactRow?.invalidAt).not.toBeNull();
  });

  it('refuses to replace a Fact that is already superseded', async () => {
    const userId = randomUUID();
    await createUser(userId);
    const fact = await createFact({ userId, content: 'Old content' });
    await updateUserFact({ factId: fact.id, userId, replacement: replacementFor('First edit') });

    await expect(
      updateUserFact({ factId: fact.id, userId, replacement: replacementFor('Second edit') }),
    ).rejects.toThrow();
    expect((await listAllUserFacts({ userId })).map((f) => f.content)).toEqual(['First edit']);
  });
});

describe('findCurrentUserFact', () => {
  it("finds only the user's own current Fact", async () => {
    const userId = randomUUID();
    const otherUserId = randomUUID();
    await createUser(userId);
    await createUser(otherUserId);
    const fact = await createFact({ userId, content: 'Current' });

    expect((await findCurrentUserFact({ factId: fact.id, userId }))?.content).toBe('Current');
    expect(await findCurrentUserFact({ factId: fact.id, userId: otherUserId })).toBeNull();

    await db
      .updateTable('memory.userFacts')
      .set({ invalidAt: new Date() })
      .where('id', '=', fact.id)
      .execute();
    expect(await findCurrentUserFact({ factId: fact.id, userId })).toBeNull();
  });
});

describe('deleteUserFact', () => {
  it('hard-deletes a fact', async () => {
    const userId = randomUUID();
    await createUser(userId);

    const fact = await createFact({ userId, content: 'To be deleted' });

    expect(await deleteUserFact({ factId: fact.id, userId })).toBe(true);

    const facts = await listAllUserFacts({ userId });
    expect(facts).toHaveLength(0);
  });

  it('reports nothing deleted when the fact is not found', async () => {
    const userId = randomUUID();
    await createUser(userId);

    await expect(
      deleteUserFact({ factId: '00000000-0000-0000-0000-000000000000', userId }),
    ).resolves.toBe(false);
  });

  it('leaves another user\u2019s fact alone', async () => {
    const owner = randomUUID();
    const stranger = randomUUID();
    await createUser(owner);
    await createUser(stranger);
    const fact = await createFact({ userId: owner, content: 'Not yours' });

    expect(await deleteUserFact({ factId: fact.id, userId: stranger })).toBe(false);
    expect(await listAllUserFacts({ userId: owner })).toHaveLength(1);
  });
});
