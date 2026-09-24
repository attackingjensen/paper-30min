import test from 'node:test';
import assert from 'node:assert/strict';
import { createManifest, verifyManifest, verifyComponentRelease } from './release_manifest.mjs';

const artifact = {
  version: '1.2.0', filename: 'Paper30Min_1.2.0_x64-setup.exe',
  signature: 'signed-content', tag: 'v1.2.0', arch: 'x86_64',
};

test('Windows NSIS 清单绑定版本、架构、附件 URL 和签名', () => {
  const manifest = createManifest(artifact);
  assert.deepEqual(manifest, {
    version: '1.2.0',
    platforms: { 'windows-x86_64': {
      signature: 'signed-content',
      url: 'https://github.com/attackingjensen/paper-30min/releases/download/v1.2.0/Paper30Min_1.2.0_x64-setup.exe',
    } },
  });
  assert.doesNotThrow(() => verifyManifest(manifest, artifact));
  assert.throws(() => verifyManifest({ ...manifest, version: '1.2.1' }, artifact), /不一致/);
  assert.throws(() => verifyManifest({ ...manifest, platforms: { 'windows-x86_64': { ...manifest.platforms['windows-x86_64'], signature: 'wrong' } } }, artifact), /不一致/);
});

test('版本、架构和签名缺失时拒绝生成清单', () => {
  assert.throws(() => createManifest({ ...artifact, filename: 'Paper30Min_1.1.0_x64-setup.exe' }), /不匹配/);
  assert.throws(() => createManifest({ ...artifact, arch: 'i686' }), /不匹配/);
  assert.throws(() => createManifest({ ...artifact, signature: '' }), /签名缺失/);
  assert.throws(() => createManifest({ ...artifact, tag: 'v1.2.1' }), /不一致/);
});

test('组件包必须与主程序内置可信清单一致', () => {
  const component = {
    schemaVersion: 1, component: 'pdfparse', version: '1.2.0', platform: 'windows', arch: 'x86_64',
    archive: 'Paper30Min_pdfparse_1.2.0_windows-x86_64.zip', archiveBytes: 12,
    sha256: 'a'.repeat(64), unpackedBytes: 24,
  };
  assert.doesNotThrow(() => verifyComponentRelease(component, component, component.archive, 12, component.sha256, '1.2.0'));
  assert.throws(() => verifyComponentRelease(component, component, component.archive, 12, 'b'.repeat(64), '1.2.0'), /不一致/);
  assert.throws(() => verifyComponentRelease({ ...component, arch: 'aarch64' }, component, component.archive, 12, component.sha256, '1.2.0'), /不一致/);
});
