import * as os from 'os';
import * as ort from 'onnxruntime-node';
import type { BackendProvider, RuntimeCapabilities } from '../shared/types';

const PROVIDER_ALIASES: Record<string, BackendProvider> = {
  dml: 'dml',
  directml: 'dml',
  webgpu: 'webgpu',
  cuda: 'cuda',
  coreml: 'coreml',
  cpu: 'cpu',
};

function normalizeProvider(name: string): BackendProvider | null {
  return PROVIDER_ALIASES[name.toLowerCase()] ?? null;
}

export function getPreferredProviders(): BackendProvider[] {
  const forced = process.env.SHARP_VIEWER_FORCE_BACKEND;
  if (forced) {
    const provider = normalizeProvider(forced);
    return provider && provider !== 'cpu' ? [provider, 'cpu'] : ['cpu'];
  }

  const platform = os.platform();
  if (platform === 'win32') return ['webgpu', 'cpu'];
  if (platform === 'linux') return ['cuda', 'webgpu', 'cpu'];
  if (platform === 'darwin') return ['coreml', 'webgpu', 'cpu'];
  return ['cpu'];
}

export async function getSupportedProviders(): Promise<BackendProvider[]> {
  const backends = await ort.listSupportedBackends();
  const providers = backends
    .map((backend) => normalizeProvider(backend.name))
    .filter((backend): backend is BackendProvider => backend !== null);
  return Array.from(new Set(providers));
}

export async function resolveProviders(preferred: BackendProvider[]): Promise<BackendProvider[]> {
  const supported = await getSupportedProviders();
  const resolved = preferred.filter((provider) => supported.includes(provider));
  return resolved.includes('cpu') ? resolved : [...resolved, 'cpu'];
}

export function toOrtProvider(provider: BackendProvider): string {
  return provider === 'dml' ? 'dml' : provider;
}

export async function getRuntimeCapabilities(
  preferredProviders = getPreferredProviders(),
): Promise<RuntimeCapabilities> {
  const supportedProviders = await getSupportedProviders();
  return {
    platform: os.platform(),
    arch: os.arch(),
    preferredProviders,
    supportedProviders,
    nodeVersion: process.version,
    onnxRuntimeVersion: ort.env.versions?.node ?? ort.env.versions?.common ?? 'unknown',
  };
}
