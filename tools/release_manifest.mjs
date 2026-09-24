import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

export function verifyComponentRelease(component, trusted, filename, size, digest, version) {
  if (component.schemaVersion !== 1 || component.component !== 'pdfparse'
      || component.version !== version || component.platform !== 'windows'
      || component.arch !== 'x86_64' || component.archive !== filename
      || filename !== `Paper30Min_pdfparse_${version}_windows-x86_64.zip`
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

async function artifactInputs(values) {
  const installer = resolve(values.installer);
  const signatureFile = resolve(values.signature || `${installer}.sig`);
  if (statSync(installer).size === 0) throw new Error('安装包为空');
  const signature = readFileSync(signatureFile, 'utf8').trim();
  const version = releaseVersions();
  const componentPath = resolve(values.component);
  const componentManifest = JSON.parse(readFileSync(resolve(values.componentManifest), 'utf8'));
  const trusted = JSON.parse(readFileSync(resolve(root, 'app/src-tauri/component-release.json'), 'utf8'));
  verifyComponentRelease(componentManifest, trusted, basename(componentPath), statSync(componentPath).size,
    await fileSha256(componentPath), version);
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
      component: { type: 'string' }, componentManifest: { type: 'string' },
    } });
    if (!values.installer || !values.component || !values.componentManifest || !values.tag || !values.manifest) throw new Error('缺少安装包、组件包、Release tag 或清单路径');
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
