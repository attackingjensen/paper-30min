import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, verify as ed25519Verify } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const repo = 'attackingjensen/paper-30min';

export function releaseVersions() {
  const app = JSON.parse(readFileSync(resolve(root, 'app/package.json'), 'utf8')).version;
  const config = JSON.parse(readFileSync(resolve(root, 'app/src-tauri/tauri.conf.json'), 'utf8')).version;
  const metadata = JSON.parse(execFileSync('cargo', [
    'metadata', '--no-deps', '--format-version', '1', '--manifest-path',
    resolve(root, 'app/src-tauri/Cargo.toml'),
  ], { encoding: 'utf8' }));
  const rust = metadata.packages.find(pkg => pkg.name === 'paper30min')?.version;
  if (!app || app !== config || app !== rust) {
    throw new Error(`版本不一致：package=${app} tauri=${config} cargo=${rust}`);
  }
  return app;
}

export function createManifest({ version, filename, signature, tag, arch = 'x86_64' }) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('版本号无效');
  if (tag !== `v${version}`) throw new Error('Release tag 与版本号不一致');
  const suffix = { x86_64: 'x64', i686: 'x86', aarch64: 'arm64' }[arch];
  if (!suffix) throw new Error('Windows 架构无效');
  if (filename !== `Paper30Min_${version}_${suffix}-setup.exe`) throw new Error('安装包文件名、版本或架构不匹配');
  if (!signature || !signature.trim()) throw new Error('更新签名缺失');
  return {
    version,
    platforms: {
      [`windows-${arch}`]: {
        signature: signature.trim(),
        url: `https://github.com/${repo}/releases/download/${tag}/${filename}`,
      },
    },
  };
}

export function verifyManifest(manifest, expected) {
  const generated = createManifest(expected);
  if (JSON.stringify(manifest) !== JSON.stringify(generated)) {
    throw new Error('清单中的版本、架构、附件 URL 或签名与本地产物不一致');
  }
}

export function verifyComponentRelease(component, trusted, filename, size, digest) {
  if (component.schemaVersion !== 1 || component.component !== 'pdfparse'
      || component.version !== trusted.version || component.platform !== 'windows'
      || component.arch !== 'x86_64' || component.archive !== filename
      || filename !== `Paper30Min_pdfparse_${trusted.version}_windows-x86_64.zip`
      || component.archiveBytes !== size || component.sha256 !== digest
      || component.unpackedBytes <= 0 || JSON.stringify(component) !== JSON.stringify(trusted)) {
    throw new Error('解析组件与主程序内置的可信清单、版本或实际 ZIP 不一致');
  }
}

async function fileSha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

// 严格 base64 解码：Node 的 Buffer.from(x, 'base64') 静默忽略空白、容忍缺 padding、
// 接受 base64url 字符，而客户端 minisign-verify 的解码是严格的。发布门卫必须至少与
// 客户端一样严，否则会放行「客户端必拒」的签名（门卫变绿、真物变红）。
function strictBase64(value, what) {
  const text = String(value).trim();
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) {
    throw new Error(`${what}不是规范 base64`);
  }
  const decoded = Buffer.from(text, 'base64');
  if (decoded.toString('base64') !== text) throw new Error(`${what}不是规范 base64`);
  return decoded;
}

// 解析 tauri.conf.json 的 plugins.updater.pubkey：base64 解码得 minisign .pub 文本，
// 第二行再 base64 解码为 42 字节 [2B 算法][8B key_id][32B Ed25519 公钥]。
export function parseUpdaterPublicKey(pubkeyBase64) {
  const lines = strictBase64(pubkeyBase64, '更新器公钥').toString('utf8')
    .split('\n').map(line => line.trim()).filter(Boolean);
  if (lines.length < 2 || !lines[0].startsWith('untrusted comment:')) throw new Error('更新器公钥格式无效');
  const raw = strictBase64(lines[1], '更新器公钥');
  const algorithm = raw.subarray(0, 2).toString('latin1');
  if (raw.length !== 42 || (algorithm !== 'Ed' && algorithm !== 'ED')) throw new Error('更新器公钥格式无效');
  return {
    keyId: raw.subarray(2, 10),
    keyObject: createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw.subarray(10, 42)]),
      format: 'der', type: 'spki',
    }),
  };
}

export function loadUpdaterPublicKey(configPath = resolve(root, 'app/src-tauri/tauri.conf.json')) {
  const pubkey = JSON.parse(readFileSync(configPath, 'utf8'))?.plugins?.updater?.pubkey;
  if (!pubkey) throw new Error('tauri.conf.json 缺少 plugins.updater.pubkey');
  return parseUpdaterPublicKey(pubkey);
}

// 解析 base64 的 minisign SignatureBox：四行分别为 untrusted comment、
// 74 字节 [2B 算法][8B keynum][64B 签名]、trusted comment 行、64 字节全局签名。
function decodeSignatureBox(signatureBase64) {
  const lines = strictBase64(signatureBase64, '更新签名').toString('utf8')
    .split('\n').map(line => line.replace(/\r$/, ''));
  const prefix = 'trusted comment: ';
  if (lines.length < 4 || !lines[2].startsWith(prefix)) {
    throw new Error('更新签名格式无效');
  }
  const box1 = strictBase64(lines[1], '更新签名');
  const globalSignature = strictBase64(lines[3], '更新签名');
  if (box1.length !== 74 || globalSignature.length !== 64) {
    throw new Error('更新签名格式无效');
  }
  return {
    algorithm: box1.subarray(0, 2).toString('latin1'),
    keyId: box1.subarray(2, 10),
    signature: box1.subarray(10, 74),
    trustedComment: lines[2].slice(prefix.length),
    globalSignature,
  };
}

// 用更新器公钥对当前安装包字节实际验签，语义对齐 tauri-plugin-updater 的 minisign-verify：
// keynum 必须等于公钥 key_id；主签名覆盖安装包的 BLAKE2b-512 摘要（流式计算，避免大文件入内存）；
// 全局签名覆盖 主签名+trusted comment。任一失败即抛错。
export async function verifyInstallerSignature(installerPath, signatureBase64, publicKey, expectedVersion) {
  const box = decodeSignatureBox(signatureBase64);
  if (!box.keyId.equals(publicKey.keyId)) throw new Error('更新签名的密钥标识与更新器公钥不匹配');
  // tauri-cli 产出的安装包签名恒为预哈希（ED）格式。legacy（Ed）需对原始字节验签、
  // 大安装包必须整文件入内存；本项目发布不会出现，从严拒绝（客户端 allow_legacy 更宽松）。
  if (box.algorithm === 'Ed') throw new Error('更新签名为 legacy（Ed）格式，发布仅接受预哈希（ED）签名');
  if (box.algorithm !== 'ED') throw new Error('更新签名算法不受支持');
  const digest = createHash('blake2b512');
  for await (const chunk of createReadStream(installerPath)) digest.update(chunk);
  if (!ed25519Verify(null, digest.digest(), publicKey.keyObject, box.signature)) {
    throw new Error('安装包内容与更新签名不匹配');
  }
  const globalMessage = Buffer.concat([box.signature, Buffer.from(box.trustedComment, 'utf8')]);
  if (!ed25519Verify(null, globalMessage, publicKey.keyObject, box.globalSignature)) {
    throw new Error('更新签名的全局签名验签失败');
  }
  const fields = box.trustedComment.split('\t');
  const signedFiles = fields.filter(field => field.startsWith('file:'));
  if (signedFiles.length !== 1 || signedFiles[0].slice(5) !== basename(installerPath)) {
    throw new Error('更新签名中的安装包文件名与当前产物不匹配');
  }
  const signedVersions = fields.filter(field => field.startsWith('version:'));
  if (signedVersions.length > 1 || (signedVersions.length === 1
      && expectedVersion && signedVersions[0].slice(8) !== expectedVersion)) {
    throw new Error('更新签名中的版本与当前产物不匹配');
  }
}

async function artifactInputs(values) {
  const installer = resolve(values.installer);
  const signatureFile = resolve(values.signature || `${installer}.sig`);
  if (statSync(installer).size === 0) throw new Error('安装包为空');
  const signature = readFileSync(signatureFile, 'utf8').trim();
  const version = releaseVersions();
  await verifyInstallerSignature(installer, signature, loadUpdaterPublicKey(), version);
  const componentPath = resolve(values.component);
  const componentManifest = JSON.parse(readFileSync(resolve(values['component-manifest']), 'utf8'));
  const trusted = JSON.parse(readFileSync(resolve(root, 'app/src-tauri/component-release.json'), 'utf8'));
  verifyComponentRelease(componentManifest, trusted, basename(componentPath), statSync(componentPath).size,
    await fileSha256(componentPath));
  return {
    version,
    filename: basename(installer),
    signature,
    tag: values.tag,
    arch: values.arch || 'x86_64',
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, ...args] = process.argv.slice(2);
    if (!['create', 'verify'].includes(mode)) throw new Error('用法：create|verify --installer <exe> --component <zip> --component-manifest <json> --tag <v版本> --manifest <json>');
    const { values } = parseArgs({ args, options: {
      installer: { type: 'string' }, signature: { type: 'string' },
      manifest: { type: 'string' }, tag: { type: 'string' }, arch: { type: 'string' },
      component: { type: 'string' }, 'component-manifest': { type: 'string' },
    } });
    const componentManifest = values['component-manifest'];
    if (!values.installer || !values.component || !componentManifest || !values.tag || !values.manifest) throw new Error('缺少安装包、组件包、Release tag 或清单路径');
    const expected = await artifactInputs(values);
    if (mode === 'create') {
      writeFileSync(values.manifest, `${JSON.stringify(createManifest(expected), null, 2)}\n`);
      process.stdout.write(`已生成 ${values.manifest}\n`);
    } else {
      verifyManifest(JSON.parse(readFileSync(values.manifest, 'utf8')), expected);
      process.stdout.write('更新清单与本地产物一致\n');
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
