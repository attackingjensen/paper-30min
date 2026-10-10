import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudTaskInput, cloudJobView, cloudJobVisible, validateParserChoice } from '../ui/js/cloud-parse.js';

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

test('stored candidate metadata does not create user-facing verification status', () => {
  const view = cloudJobView({ state: 'downloaded', candidateStored: true });
  assert.doesNotMatch(view.text, /候选|待校验|尚未发布/);
  assert.equal(view.canMap, true);
  assert.doesNotMatch(cloudJobView({ state: 'downloaded', candidateStored: true, visualCandidateStored: true }).text, /候选|待校验|尚未发布/);
});

test('downloaded job stays listed in the task center with a convert entry, running tasks hide it', () => {
  const downloaded = { jobId: 'j', batchId: 'b', state: 'downloaded' };
  assert.equal(cloudJobVisible(downloaded, false), true, 'downloaded 须有「转换 / 继续准备」入口');
  assert.equal(cloudJobVisible(downloaded, true), false, '运行中云端任务接管时不列出');
  assert.equal(cloudJobVisible({ jobId: 'j', state: 'poll-timeout' }, false), true);
  assert.equal(cloudJobVisible({ state: 'remote-failed' }, false), true);
  assert.equal(cloudJobVisible({}, false), false, '无任何动作的任务不列出');
});

test('downloaded row exits only after its chain is published, sealed candidate keeps the entry', () => {
  const base = { jobId: 'j', batchId: 'b', state: 'downloaded' };
  const sealed = { ...base, candidateStored: true, visualCandidateStored: true };
  assert.equal(cloudJobView(sealed).canMap, true, '视觉已封存但未发布仍保留入口，不重新付费');
  assert.equal(cloudJobVisible(sealed, false), true);
  assert.equal(cloudJobView(sealed).text, '正文与视觉资源已就绪，待确认发布');
  const published = { ...sealed, published: true };
  assert.equal(cloudJobView(published).canMap, false);
  assert.equal(cloudJobVisible(published, false), false, '发布后任务行不再滞留');
});

test('remote failure offers a confirmed new submission, while interruptions resume the old job', () => {
  const failed = { jobId: 'failed-job', batchId: 'failed-batch', state: 'remote-failed' };
  assert.equal(cloudJobView(failed).needsResubmit, true);
  assert.equal(cloudJobView(failed).canResume, false);
  assert.throws(() => cloudTaskInput('p', failed), /确认/);
  assert.deepEqual(cloudTaskInput('p', failed, true), {
    paperId: 'p', action: 'submit', uploadConfirmed: true, batchId: 'failed-batch', resubmitConfirmed: true,
  });
  for (const state of ['interrupted', 'poll-timeout', 'cancelled', 'failed']) {
    const job = { ...failed, state };
    assert.equal(cloudJobView(job).needsResubmit, false);
    assert.deepEqual(cloudTaskInput('p', job, true), { paperId: 'p', action: 'resume', batchId: 'failed-batch' });
  }
});
