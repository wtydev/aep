import type { ConformanceTest } from '../suite.js';
import { TestRegistry } from '../suite.js';
import { assetTests } from './assets.js';
import { audioTests } from './audio.js';
import { coreTests } from './core.js';
import { durabilityTests } from './durability.js';
import { historyTests } from './history.js';
import { jobTests } from './jobs.js';
import { proposalTests } from './proposals.js';
import { securityTests } from './security.js';

/** The full conformance suite, in report order. */
export const ALL_TESTS: ConformanceTest[] = [
  ...coreTests,
  ...audioTests,
  ...proposalTests,
  ...historyTests,
  ...assetTests,
  ...jobTests,
  ...securityTests,
  ...durabilityTests,
];

/** A fresh registry holding {@link ALL_TESTS}; third parties may `register` more tests. */
export function defaultRegistry(): TestRegistry {
  return new TestRegistry(ALL_TESTS);
}
