import test from 'node:test';
import assert from 'node:assert/strict';
import { updateState, updateStatusText } from '../ui/js/updater.js';

test('更新器初始状态可在页面启动时直接创建', () => {
  assert.equal(updateState().status, 'idle');
});

test('更新状态区分无更新、检查失败与可安装版本', () => {
  const initial = updateState(null, { type: 'info', version: '1.2.0-beta.1' });
  assert.equal(initial.currentVersion, '1.2.0-beta.1');
  assert.equal(updateState(initial, { type: 'none' }).status, 'current');
  assert.equal(updateState(initial, { type: 'check-error', error: '离线' }).status, 'error');
  const available = updateState(initial, { type: 'available', version: '1.2.1', notes: '修复说明' });
  assert.equal(available.version, '1.2.1');
  assert.equal(available.notes, '修复说明');
  assert.equal(updateStatusText(available), '发现新版本 1.2.1');
});

test('下载进度与失败重试保留目标版本', () => {
  const available = updateState(null, { type: 'available', version: '1.2.1', notes: '' });
  const downloading = updateState(available, { type: 'progress', downloaded: 50, total: 100 });
  assert.equal(updateStatusText(downloading), '正在下载 50%');
  const failed = updateState(downloading, { type: 'install-error', error: '签名错误' });
  assert.equal(failed.status, 'install-error');
  assert.equal(failed.version, '1.2.1');
  assert.equal(updateState(failed, { type: 'installing' }).status, 'installing');
});
