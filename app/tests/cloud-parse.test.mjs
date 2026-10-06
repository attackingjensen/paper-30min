import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudTaskInput, cloudJobView, validateParserChoice } from '../ui/js/cloud-parse.js';

test('cloud selection requires credentials and current upload consent; local needs neither', () => {
  assert.equal(validateParserChoice('local', {}).ok, true);
  assert.equal(validateParserChoice(null, {}).ok, false);
  assert.equal(validateParserChoice('baidu', { accessToken: 'token', uploadConfirmed: false }).ok, false);
  assert.equal(validateParserChoice('baidu', { accessToken: 'token', uploadConfirmed: true }).ok, true);
});

test('accepted cloud job retry resumes without another paid submission', () => {
  assert.deepEqual(cloudTaskInput('p', { jobId: 'j', state: 'failed' }), { paperId: 'p', action: 'resume' });
  assert.deepEqual(cloudTaskInput('p', { jobId: 'old', batchId: 'batch-old', state: 'poll-timeout' }), {
    paperId: 'p', action: 'resume', batchId: 'batch-old',
  });
  assert.throws(() => cloudTaskInput('p', { state: 'submit-unknown' }), /确认/);
  assert.deepEqual(cloudTaskInput('p', { state: 'submit-unknown' }, true), {
    paperId: 'p', action: 'submit', uploadConfirmed: true, resubmitConfirmed: true,
  });
});

test('raw download is explicitly pending integration and cancellation warns about remote billing', () => {
  assert.match(cloudJobView({ state: 'downloaded' }).text, /原始结果/);
  assert.equal(cloudJobView({ state: 'downloaded' }).canResume, false);
  assert.match(cloudJobView({ state: 'cancelled', jobId: 'j' }).text, /计费/);
  assert.equal(cloudJobView({ state: 'cancelled', jobId: 'j' }).canResume, true);
});
