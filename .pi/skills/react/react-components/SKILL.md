---
name: react-components
description: React component structure (a folder per large component behind an index facade, genuinely reusable atoms, private subcomponents, a switch for visual variants). Load when building, editing, or splitting UI components.
---

# React Components

Exports follow the **typescript-conventions** skill; this skill adds what is particular to components.

## 1. Modularize Big Components
*   **Folder per Component**: Large or complex UI components live in their own dedicated folder (e.g., `components/Dashboard/`).
*   **Internal Subcomponents**: Subcomponents, helper functions, and local types used only by the main component each get their own file within this folder. DO NOT dump all subcomponents into a single massive `.tsx` file.
*   **Clean Export Facade**: The folder contains an `index.ts` that acts as the public API and holds only `export` statements (e.g., `export { default } from './Dashboard';`). Component logic lives in its own files, never in `index.ts` or `index.tsx`.

## 2. Shared/Reusable Atoms
*   **Truly Reusable Elements**: Shared concepts can live in `components/ui/` or `components/atoms/`, but only if they are genuinely reusable.
*   **Avoid Bloat**: Atoms only know how to render themselves. Screen-specific conditions and partial implementations stay in the screen that needs them.

## 3. Variants
*   **Divergent markup**: Use explicit `switch` cases for visual variants and divergent markup.
*   **Scaling attributes**: Use object maps only for simple scaling attributes (e.g., `size`).

## 4. Strict Encapsulation
*   **Everything not used outside stays unexported**: A component's folder is its private boundary. The folder's `index.ts` exports neither internal subcomponents nor internal types.
