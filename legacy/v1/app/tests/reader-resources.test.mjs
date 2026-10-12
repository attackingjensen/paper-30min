import test from 'node:test';
import assert from 'node:assert/strict';
import { createLatestResource, createSerialWriter } from '../ui/js/reader-resources.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('late result from an earlier paper cannot replace the current resource', async () => {
  const resources = createLatestResource();
  const first = deferred();
  const second = deferred();
  const committed = [];
  const disposed = [];
  const oldLoad = resources.load(() => first.promise, value => committed.push(value), value => disposed.push(value));
  const newLoad = resources.load(() => second.promise, value => committed.push(value), value => disposed.push(value));

  second.resolve('new paper');
  await newLoad;
  first.resolve('old paper');
  await oldLoad;

  assert.deepEqual(committed, ['new paper']);
  assert.deepEqual(disposed, ['old paper']);
});

test('closing a paper disposes a resource that finishes loading later', async () => {
  const resources = createLatestResource();
  const pending = deferred();
  const committed = [];
  const disposed = [];
  const load = resources.load(() => pending.promise, value => committed.push(value), value => disposed.push(value));

  resources.invalidate();
  pending.resolve('closed paper');
  await load;

  assert.deepEqual(committed, []);
  assert.deepEqual(disposed, ['closed paper']);
});

test('a failed obsolete load does not replace the current error state', async () => {
  const resources = createLatestResource();
  const pending = deferred();
  const oldLoad = resources.load(() => pending.promise, () => {});
  resources.invalidate();
  pending.resolve(Promise.reject(new Error('old paper failed')));

  assert.equal(await oldLoad, false);
});

test('the final reading position waits for an earlier write', async () => {
  const first = deferred();
  const writes = [];
  const write = createSerialWriter(async position => {
    writes.push(position);
    if (position === 'earlier') await first.promise;
  });

  const earlier = write('earlier');
  const final = write('final');
  await Promise.resolve();
  assert.deepEqual(writes, ['earlier']);
  first.resolve();
  await Promise.all([earlier, final]);
  assert.deepEqual(writes, ['earlier', 'final']);
});

test('a failed position write does not prevent the next save', async () => {
  const write = createSerialWriter(async value => {
    if (value === 'earlier') throw new Error('disk error');
    return value;
  });
  await assert.rejects(write('earlier'), /disk error/);
  assert.equal(await write('final'), 'final');
});
