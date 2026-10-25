---
name: typescript-conventions
description: TypeScript style choices for any TS codebase (switches end with a `never` check, single-use checks stay inline, one object parameter, type safety, read-only boundaries, types follow the value, inferred return types). Load before writing or editing any TypeScript.
---

# TypeScript Conventions

These are concrete patterns the user has chosen, each with the reason behind it. The **code-quality** skill holds the broad principles; this skill holds the exact TypeScript shapes.

Apply every rule below to the code you write or edit. Code you are not otherwise changing stays as it is unless the user asks for a sweep.

## Switches end with an inline `never` check

When you write or edit a `switch` over a union, end it with a `default` that assigns the value to `never`, written inline, and returns:

```ts
switch (gate.kind) {
  case 'failed':
    return err('gate_failed', '…');
  case 'clear':
    break;
  default: {
    const _check: never = gate;
    return _check;
  }
}
```

The `default` always exits, even when the cases fall through to shared code below: otherwise the compiler treats it as a path into that code and complains that values set in the cases may be unset. Write `return _check;` in a function that returns a value, and a bare `return;` in one that returns nothing, since linters such as Biome reject returning a value from a `void` function.

Why: a new member of the union then fails to compile at this switch, instead of quietly taking the shared path after it. The check is written out in place so a reader sees it where it acts.

## Single-use checks stay inline

A check or snippet used in one place is written where it is used. Extract a helper only once two or more places share it.

Why: a one-off helper costs a name, and naming it well is hard; the inline form reads just as clearly.

## One object parameter

A function that takes two or more inputs takes them as one object, destructured in the signature, so every call site names what it passes:

```ts
function submissionForGate({ gate, pauseOnFire, exchange, signal }: { … }) { … }

submissionForGate({ gate, pauseOnFire: true, exchange, signal });
```

A function with a single input may take it plainly. A callback whose shape a library fixes (`.map`, `.then`, an event handler) keeps that shape. Fields stay required unless callers genuinely leave them out; a value that may be absent is typed `field: T | undefined`, so every caller still has to name it.

Why: reordering or adding inputs can never silently swap two arguments, and a call site never shows a bare `true` or `null` whose meaning has to be looked up.

## Type safety

Types and interfaces enforce contracts through structural typing.

- Use `unknown` at external boundaries, with runtime validation, and keep `any` out of the code.
- Model variants as discriminated unions.
- Let inference handle locals and return types. Annotate parameters only.
- Write type assertions only where unavoidable (third-party libs, narrowing edge cases), each with an inline comment explaining why.
- Consider branded types for IDs that must not be swapped (thread IDs, user IDs).

## Return types are inferred

A function does not declare its return type. The value it returns shapes itself, and a mismatch shows where the result is used.

```ts
async function readOrders({ userId }: { userId: string }) {
  const rows = await listOrders({ userId });
  return { byId: new Map(rows.map((row) => [row.id, row])), total: rows.length };
}
```

Declare a return type only when the compiler cannot infer it (a recursive function, or a getter that reads its own object), when the function implements a port that several implementations must satisfy, or when it builds a value for a shared type with optional members (an object literal that leaves them out infers a type without them, and a consumer that reads them stops compiling).

Why: a declared return type is a second copy of what the body already says, and it needs a name that every file then has to import or repeat. Fewer named types means less to read, and a wrong shape is still caught by the first consumer that needs a different one.

## Read-only at boundaries

Collections that cross a function boundary are typed read-only (`ReadonlyMap`, `readonly T[]`), so the compiler enforces the **code-quality** immutability rule. Object keys stay plain.

A function that adds to its input returns a copy (`{ ...chain, embeddings }`). TypeScript does not warn when a returned value is ignored, so check the call sites use the copy.

## Types follow the value

A type is read off the function or schema that produces it (`ReturnType`, `Parameters`, `Awaited`, `z.infer`), at the place that needs it. A type that only describes a function's parameter or result stays in the file of that function, unexported.

```ts
// the caller derives the shape from the function it calls
type Outcome = Awaited<ReturnType<typeof generateTitle>>;
```

When deriving does not fit and several files must share a shape, the type lives as close to them as possible. Its home is the lowest folder that contains every file using it, and it is exported no further. Files of one folder share it from the file that declares it. Files of sibling folders share it from a `types.ts` in their common parent. Only a shape that the whole workspace, the stored rows, or the wire contract must agree on lives in a top-level shelf.

Why: two shapes that look alike but mean different things must not be joined by a shared name. A type that is visible only to the folder that needs it cannot be reused by accident, and when the shapes part, the compiler points at the right place. Types that are a const table's members, or inferred from a schema, stay beside that const.

## Adding a rule

When the user states a new style preference during a task, add it in the same turn: one heading, the rule in a sentence, a short example, and the why. A rule that holds for any TypeScript codebase goes here; one tied to a single repo goes in that repo's own conventions.
