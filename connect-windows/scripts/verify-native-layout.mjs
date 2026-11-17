import {createHash} from 'node:crypto';
import {lstat, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

export async function verifyNativeLayout(resources, version, runtime) {
  const descriptors = new Map();
  async function descriptor(name) {
    const bytes = await readFile(join(resources, name));
    descriptors.set(name, {file: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')});
    return JSON.parse(bytes.toString('utf8'));
  }

  const bridge = 'PackProof.Connect.Bridge';
  const deps = await descriptor('bridge/' + bridge + '.deps.json');
  const config = await descriptor('bridge/' + bridge + '.runtimeconfig.json');
  const serviceConfig = await descriptor('service/service-config.json');
  const bridgeConfig = await descriptor('bridge/bridge-config.json');
  const expectedEnvironment = runtime.channel === 'production' ? 'live' : runtime.channel;
  if (serviceConfig.environment !== expectedEnvironment || serviceConfig.apiOrigin !== runtime.apiBaseUrl ||
      serviceConfig.webOrigin !== runtime.webBaseUrl || serviceConfig.operatorsSid !== 'UNCONFIGURED' ||
      bridgeConfig.channel !== runtime.channel || bridgeConfig.publisher !== runtime.publisher) {
    throw Error('Packaged native configuration does not match the candidate runtime.');
  }

  const target = '.NETCoreApp,Version=v10.0/win-x64';
  const assemblies = deps.targets?.[target];
  const framework = config.runtimeOptions?.includedFrameworks?.find(entry => entry.name === 'Microsoft.NETCore.App');
  const core = assemblies?.['runtimepack.Microsoft.NETCore.App.Runtime.win-x64/' + framework?.version];
  const owned = assemblies?.[bridge + '/' + version];
  if (deps.runtimeTarget?.name !== target || config.runtimeOptions?.tfm !== 'net10.0' ||
      !core?.native?.['coreclr.dll'] || !core?.runtime?.['System.Private.CoreLib.dll'] || !owned?.runtime?.[bridge + '.dll']) {
    throw Error('The packaged bridge runtime or application version does not match this candidate.');
  }

  const files = new Set(['service/PackProof.Connect.Service.exe', 'service/e_sqlite3.dll', 'bridge/' + bridge + '.exe']);
  for (const assembly of Object.values(assemblies)) {
    for (const name of [...Object.keys(assembly.runtime ?? {}), ...Object.keys(assembly.native ?? {})]) {
      if (!/^[a-z0-9_-][a-z0-9_.-]*\.(dll|exe)$/i.test(name)) {
        throw Error('Unexpected path in the Win-x64 bridge dependency manifest.');
      }
      files.add('bridge/' + name);
    }
  }
  for (const name of files) {
    const file = await lstat(join(resources, name));
    if (!file.isFile() || !file.size) throw Error('Packaged native component is missing or empty: ' + name);
  }
  return {architecture: 'win-x64', bridgeRuntime: framework.version, requiredBinaryCount: files.size, descriptors: [...descriptors.values()]};
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [resources, version, runtimePath] = process.argv.slice(2);
  console.log(JSON.stringify(await verifyNativeLayout(resources, version, JSON.parse(await readFile(runtimePath, 'utf8')))));
}
