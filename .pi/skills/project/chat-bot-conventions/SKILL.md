---
name: chat-bot-conventions
description: Style choices specific to this repo (what `log` in a name means, where telemetry mapping lives, where an exported type lives, that a destructured input is read). Load before writing or editing any code here, alongside typescript-conventions.
---

# Chat Bot Conventions

The **typescript-conventions** skill holds the shapes that apply to any TypeScript codebase. This skill holds the ones particular to this repo, each with the reason behind it.

## `log` in a name means telemetry only

A function with `log` in its name only records what happened. A function that does business work is named for that work, even when it writes to a log along the way; it receives the log (such as `exchangeLog`) as an input and calls its `log*` methods.

```ts
// the work is named for the work; the log is handed in
submitArrival({ ...props, exchangeLog });
```

Why: a reader can trust that anything named `log` is safe to ignore when following the logic, and that everything else is not.

Exception: `SegmentDriftLog` and its queries name a stored database table of drift results, not telemetry, and keep their name.

## Telemetry mapping lives with the log, not the flow

Code that turns a domain event into a log record (a verdict mapped to the record's words, an outcome derived from an error code) lives in the flow's logging module. That module's header states it is telemetry only and changes nothing the user sees or the database holds. The business flow keeps only the `log*` calls themselves, at the moment each event happens.

Why: the log surface stays in one place, and a reader of the flow can tell at a glance which lines are critical logic and which are only observation.

## Where an exported type lives

The **typescript-conventions** rule "Types follow the value" is enforced by `npm run audit:types`. The check fails an exported type when no other file imports it, when only tests do, or when an importer sits outside the folder of the declaring file. Its message names the folder where the type belongs, `types.ts` in the lowest folder that holds every importer. A type in a `types.ts` fails too when only one folder below it depends on it, importing it directly or through a sibling type of the same file.

These shelves are exempt, because their types are meant to be read from anywhere:

| Shelf | Where |
|---|---|
| wire contract and record formats | `lib/`, `load/src/records/`, `frontend/src/services/api.ts` |
| stored rows and query results | `backend/src/db/types.ts` |
| shapes shared across a whole workspace | `backend/src/types/`, `frontend/src/types/`, `load/src/types/`, `infra/lib/types/`, `infra/config/` |

A type that is a const table's member or inferred from a schema is listed with its reason in `scripts/checks/type-exports.allow.json`. A type that only a test uses is derived in the test.

Why: a shared word is found next to the code that shares it, and a type is never exported further than the code that needs it.

## A destructured input is read

A function that destructures a parameter annotated with a type literal binds every member the literal declares. A member that is never read comes out of the type and out of every caller. `npm run audit:params` fails the leftover, and Biome fails a binding that is bound but never used; a name kept on purpose starts with an underscore.

Why: tsc and Biome both miss a type member that nothing binds, so a removed binding leaves a phantom input that callers keep passing.

## Adding a rule

When the user states a new style preference that only makes sense in this repo, add it here in the same turn: one heading, the rule in a sentence, a short example, and the why.
