// A faker that is seeded per sandbox. Seeding runs inside AsyncLocalStorage, so two
// trainees creating sandboxes at the same time can't disturb each other's sequence.
import { AsyncLocalStorage } from 'node:async_hooks';
import { Faker, en, faker as sharedFaker } from '@faker-js/faker';

const store = new AsyncLocalStorage();

export const faker = new Proxy({}, { get: (_, key) => (store.getStore() || sharedFaker)[key] });

export function withSeed(seed, fn) {
  const seeded = new Faker({ locale: [en] });
  seeded.seed(seed);
  return store.run(seeded, fn);
}
