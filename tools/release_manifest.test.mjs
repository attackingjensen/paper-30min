import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign as ed25519Sign } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createManifest, verifyManifest, verifyComponentRelease,
  parseUpdaterPublicKey, loadUpdaterPublicKey, verifyInstallerSignature,
} from './release_manifest.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function makeKeyMaterial() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey, privateKey, keyId: randomBytes(8) };
}

// 按 minisign SignatureBox 格式拼装签名：主签名覆盖安装包的 BLAKE2b-512 摘要
// （prehashed，算法字节 "ED"；legacy "Ed" 覆盖原始字节），全局签名覆盖 主签名+trusted comment。
function signInstaller(content, privateKey, keyId, {
  algorithm = 'ED',
  trustedComment = 'timestamp:1760000000\tfile:Paper30Min_9.9.9_x64-setup.exe\tprehashed',
} = {}) {
  const message = algorithm === 'ED' ? createHash('blake2b512').update(content).digest() : content;
  const signature = ed25519Sign(null, message, privateKey);
  const globalSignature = ed25519Sign(null, Buffer.concat([signature, Buffer.from(trustedComment, 'utf8')]), privateKey);
  const box = [
    'untrusted comment: signature from minisign secret key',
    Buffer.concat([Buffer.from(algorithm, 'latin1'), keyId, signature]).toString('base64'),
    `trusted comment: ${trustedComment}`,
    globalSignature.toString('base64'),
    '',
  ].join('\n');
  return Buffer.from(box, 'utf8').toString('base64');
}

// 按 tauri.conf.json 中 plugins.updater.pubkey 的格式（base64 的 minisign .pub 文本）构造公钥。
function minisignPubkeyBase64(publicKey, keyId) {
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length);
  const text = `untrusted comment: minisign public key: TEST\n${Buffer.concat([Buffer.from('Ed', 'latin1'), keyId, raw]).toString('base64')}\n`;
  return Buffer.from(text, 'utf8').toString('base64');
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'release-manifest-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tempInstaller(t, content) {
  const path = join(tempDir(t), 'Paper30Min_9.9.9_x64-setup.exe');
  writeFileSync(path, content);
  return path;
}

function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, args, { encoding: 'utf8' });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return { status: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

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

test('当前安装包与签名通过更新器公钥验签', async (t) => {
  const { publicKey, privateKey, keyId } = makeKeyMaterial();
  const content = Buffer.from('installer-bytes-A');
  const installer = tempInstaller(t, content);
  const signature = signInstaller(content, privateKey, keyId);
  await verifyInstallerSignature(installer, signature, { keyId, keyObject: publicKey });
});

test('同名同版本重建的安装包不得沿用旧签名', async (t) => {
  const { publicKey, privateKey, keyId } = makeKeyMaterial();
  const installer = tempInstaller(t, Buffer.from('installer-bytes-A'));
  const staleSignature = signInstaller(Buffer.from('installer-bytes-A'), privateKey, keyId);
  writeFileSync(installer, Buffer.from('installer-bytes-B-rebuilt'));
  await assert.rejects(verifyInstallerSignature(installer, staleSignature, { keyId, keyObject: publicKey }), /不匹配/);
});

test('安装包签名后被篡改时验签失败', async (t) => {
  const { publicKey, privateKey, keyId } = makeKeyMaterial();
  const content = Buffer.from('installer-bytes-A');
  const installer = tempInstaller(t, content);
  const signature = signInstaller(content, privateKey, keyId);
  writeFileSync(installer, Buffer.concat([content, Buffer.from([0])]));
  await assert.rejects(verifyInstallerSignature(installer, signature, { keyId, keyObject: publicKey }), /不匹配/);
});

test('签名密钥标识与更新器公钥不一致时拒绝', async (t) => {
  const signer = makeKeyMaterial();
  const other = makeKeyMaterial();
  const content = Buffer.from('installer-bytes-A');
  const installer = tempInstaller(t, content);
  const signature = signInstaller(content, signer.privateKey, other.keyId);
  await assert.rejects(
    verifyInstallerSignature(installer, signature, { keyId: signer.keyId, keyObject: signer.publicKey }),
    /密钥标识/,
  );
});

test('全局签名被篡改时拒绝', async (t) => {
  const { publicKey, privateKey, keyId } = makeKeyMaterial();
  const content = Buffer.from('installer-bytes-A');
  const installer = tempInstaller(t, content);
  const box = Buffer.from(signInstaller(content, privateKey, keyId), 'base64').toString('utf8').split('\n');
  box[3] = randomBytes(64).toString('base64');
  const tampered = Buffer.from(box.join('\n'), 'utf8').toString('base64');
  await assert.rejects(verifyInstallerSignature(installer, tampered, { keyId, keyObject: publicKey }), /全局签名/);
});

test('legacy（Ed）签名被拒绝，发布仅接受预哈希（ED）签名', async (t) => {
  const { publicKey, privateKey, keyId } = makeKeyMaterial();
  const content = Buffer.from('installer-bytes-A');
  const installer = tempInstaller(t, content);
  const signature = signInstaller(content, privateKey, keyId, { algorithm: 'Ed' });
  await assert.rejects(verifyInstallerSignature(installer, signature, { keyId, keyObject: publicKey }), /legacy|预哈希/);
});

test('从 tauri.conf.json 解析更新器公钥并完成验签', async (t) => {
  const { publicKey, privateKey, keyId } = makeKeyMaterial();
  const parsed = parseUpdaterPublicKey(minisignPubkeyBase64(publicKey, keyId));
  assert.equal(parsed.keyId.toString('hex'), keyId.toString('hex'));
  assert.equal(parsed.keyObject.asymmetricKeyType, 'ed25519');
  const content = Buffer.from('installer-bytes-A');
  const installer = tempInstaller(t, content);
  await verifyInstallerSignature(installer, signInstaller(content, privateKey, keyId), parsed);

  const real = loadUpdaterPublicKey();
  assert.equal(real.keyObject.asymmetricKeyType, 'ed25519');
  assert.equal(real.keyId.length, 8);
});

test('create 与 verify 命令在验签失败时不产出或确认清单', (t) => {
  const dir = tempDir(t);
  const version = JSON.parse(readFileSync(resolve(repoRoot, 'app/package.json'), 'utf8')).version;
  const installer = join(dir, `Paper30Min_${version}_x64-setup.exe`);
  const content = Buffer.from('installer-bytes-A');
  writeFileSync(installer, content);
  const { privateKey, keyId } = makeKeyMaterial();
  const signatureFile = join(dir, 'installer.sig');
  writeFileSync(signatureFile, signInstaller(content, privateKey, keyId));
  const manifestPath = join(dir, 'latest.json');
  const script = resolve(repoRoot, 'tools/release_manifest.mjs');
  const args = (mode) => [script, mode,
    '--installer', installer, '--signature', signatureFile, '--manifest', manifestPath,
    '--component', join(dir, 'dummy.zip'), '--component-manifest', join(dir, 'dummy.json'),
    '--tag', `v${version}`];

  const createRun = runCli(args('create'));
  assert.equal(createRun.status, 1, createRun.stderr);
  assert.match(createRun.stderr, /密钥标识|不匹配|验签/);
  assert.equal(existsSync(manifestPath), false);

  writeFileSync(manifestPath, '{}\n');
  const verifyRun = runCli(args('verify'));
  assert.equal(verifyRun.status, 1, verifyRun.stderr);
  assert.match(verifyRun.stderr, /密钥标识|不匹配|验签/);
});

// ---------------- 畸形输入拒绝（发布审查 #7/#8） ----------------

test('公钥解析拒绝畸形与非规范 base64 输入', () => {
  assert.throws(() => parseUpdaterPublicKey('不是base64!!!'), /规范 base64/);
  assert.throws(() => parseUpdaterPublicKey(Buffer.from('只有一行').toString('base64')), /公钥格式无效/);
  const shortKey = Buffer.from(`untrusted comment: x\n${Buffer.alloc(41).toString('base64')}\n`).toString('base64');
  assert.throws(() => parseUpdaterPublicKey(shortKey), /公钥格式无效/);
  const badAlg = Buffer.from(`untrusted comment: x\n${Buffer.concat([Buffer.from('XX'), Buffer.alloc(40)]).toString('base64')}\n`).toString('base64');
  assert.throws(() => parseUpdaterPublicKey(badAlg), /公钥格式无效/);
});

test('验签拒绝畸形签名盒与非规范 base64', async (t) => {
  const { publicKey, privateKey, keyId } = makeKeyMaterial();
  const content = Buffer.from('installer-bytes-A');
  const installer = tempInstaller(t, content);
  const key = { keyId, keyObject: publicKey };
  const validBox = Buffer.from(signInstaller(content, privateKey, keyId), 'base64').toString('utf8').split('\n');
  const encode = lines => Buffer.from(lines.join('\n'), 'utf8').toString('base64');

  // box1 截断 1 字节（73 而非 74）
  const box1 = Buffer.from(validBox[1], 'base64');
  await assert.rejects(verifyInstallerSignature(installer, encode([validBox[0], box1.subarray(0, 73).toString('base64'), validBox[2], validBox[3]]), key), /格式无效/);
  // 缺 trusted comment 前缀
  await assert.rejects(verifyInstallerSignature(installer, encode([validBox[0], validBox[1], 'timestamp: 1', validBox[3]]), key), /格式无效/);
  // 算法字节非 Ed/ED
  const badAlgBox1 = Buffer.concat([Buffer.from('XY'), box1.subarray(2)]);
  await assert.rejects(verifyInstallerSignature(installer, encode([validBox[0], badAlgBox1.toString('base64'), validBox[2], validBox[3]]), key), /算法不受支持/);
  // 全局签名非 64 字节
  await assert.rejects(verifyInstallerSignature(installer, encode([validBox[0], validBox[1], validBox[2], Buffer.alloc(63).toString('base64')]), key), /格式无效/);
  // 外层签名是非规范 base64：内嵌换行折行（Node 宽松解码会吞掉，客户端必拒）
  const good = encode(validBox.slice(0, 4));
  const foldedSig = `${good.slice(0, 20)}\n${good.slice(20)}`;
  await assert.rejects(verifyInstallerSignature(installer, foldedSig, key), /规范 base64/);
  // base64url 字符（-/_）不得接受
  const urlSafe = good.replace(/\+/g, '-').replace(/\//g, '_');
  if (urlSafe !== good) await assert.rejects(verifyInstallerSignature(installer, urlSafe, key), /规范 base64/);
});
