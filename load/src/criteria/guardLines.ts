import type { GuardLines } from '../types/criteria.ts';
import { HOME_LINES } from './home.ts';

/** The limits a home run records, so the guard and the verdict can never disagree. */
export const GUARD_LINES: GuardLines = HOME_LINES;
