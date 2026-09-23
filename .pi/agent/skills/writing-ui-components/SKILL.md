---
name: writing-ui-components
description: Guidelines for building UI components, splitting bloated files into folders, handling subcomponents, and managing TypeScript exports.
---

# Writing UI Components

## 1. Modularize Big Components
*   **Folder per Component**: Large or complex UI components (e.g., `ChatView`, `AnalysisTab`) should live in their own dedicated folder (e.g., `src/components/chat/ChatView/`).
*   **Internal Subcomponents**: Subcomponents, helper functions, and local types used exclusively by the main component should be split into their own separate files within this folder. DO NOT dump all subcomponents into a single massive `.tsx` file.
*   **Clean Export Facade**: The folder must contain an `index.ts` file that acts as the public API. It should purely contain `export` statements (e.g., `export { default } from './ChatView';`). Never place actual component logic inside `index.tsx` or `index.ts`.

## 2. Shared/Reusable Atoms
*   **Truly Reusable Elements**: Shared concepts can live in `components/ui/` or `components/atoms/`, but only if they are genuinely reusable.
*   **Avoid Bloat**: Be careful not to make atoms bloated with partial implementations or screen-specific conditional logic. Atoms should only know how to render themselves, not handle the business logic of specific screens.

## 3. TypeScript Export Hygiene
*   **Duck Typing over Explicit Types**: Lean into TypeScript's structural typing and inference. Do not manually type and export everything if TS can infer it automatically.
*   **Keep Types Local**: Do not use the `export` keyword on types (e.g., component `Props` interfaces) if they are only used within a single file.
*   **Export Only When Necessary**: Only `export` explicit types when they are genuinely consumed across multiple files (or globally). Unused or internal-only exports pollute the namespace and violate dependency boundaries (caught by `knip`). Global constants and enums are exceptions and can be exported as needed.

## 4. Strict Encapsulation
*   **Everything not used outside will not be exported**: A component's folder is its private boundary. Do not export internal subcomponents or internal types from the folder's `index.ts`.
