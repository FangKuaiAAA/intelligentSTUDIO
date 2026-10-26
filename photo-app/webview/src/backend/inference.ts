import * as ort from 'onnxruntime-node';
import { prepareImage } from './image';
import { pruneGaussians, unprojectGaussiansInPlace } from './gaussian';
import { writePlyFile } from './ply';
import { resolveProviders, toOrtProvider } from './runtime';
import type {
  BackendProvider,
  BackendRunConfig,
  InferenceResult,
  InferenceStartRequest,
  InferenceStatus,
} from '../shared/types';

type StatusCallback = (status: InferenceStatus) => void;

interface RunOptions {
  taskId: string;
  request: InferenceStartRequest;
  config: BackendRunConfig;
  onStatus?: StatusCallback;
  isCancelled?: () => boolean;
}

let cachedSession: ort.InferenceSession | null = null;
let cachedProviderKey = '';

function tensorData(outputs: ort.InferenceSession.OnnxValueMapType, key: string): Float32Array {
  const value = outputs[key] as ort.Tensor | undefined;
  if (!value || !(value.data instanceof Float32Array)) {
    throw new Error(`Missing float32 output '${key}'. Available: ${Object.keys(outputs).join(', ')}`);
  }
  return value.data;
}

function assertNotCancelled(isCancelled?: () => boolean): void {
  if (isCancelled?.()) throw new Error('Inference cancelled');
}

async function releaseSession(): Promise<void> {
  if (cachedSession) {
    await cachedSession.release();
    cachedSession = null;
    cachedProviderKey = '';
  }
}

async function getSession(modelPath: string, providers: BackendProvider[]): Promise<ort.InferenceSession> {
  const providerKey = providers.join(',');
  if (cachedSession && cachedProviderKey === `${modelPath}|${providerKey}`) return cachedSession;
  await releaseSession();
  cachedSession = await ort.InferenceSession.create(modelPath, {
    graphOptimizationLevel: 'all',
    executionProviders: providers.map(toOrtProvider),
  });
  cachedProviderKey = `${modelPath}|${providerKey}`;
  return cachedSession;
}

async function runOnProviders(
  modelPath: string,
  providers: BackendProvider[],
  imageTensor: ort.Tensor,
  disparityFactor: number,
): Promise<{ outputs: ort.InferenceSession.OnnxValueMapType; backend: BackendProvider }> {
  const session = await getSession(modelPath, providers);
  const outputs = await session.run({
    image: imageTensor,
    disparity_factor: new ort.Tensor('float32', new Float32Array([disparityFactor]), [1]),
  });
  return { outputs, backend: providers[0] ?? 'cpu' };
}

export async function runSharpInference({
  taskId,
  request,
  config,
  onStatus,
  isCancelled,
}: RunOptions): Promise<Omit<InferenceResult, 'plyUrl'>> {
  const startedAt = Date.now();
  const status = (stage: InferenceStatus['stage'], message: string, progress?: number, backend?: BackendProvider): void => {
    onStatus?.({ taskId, stage, message, progress, backend });
  };

  status('loading-model', 'Loading ONNX Runtime backend...', 5);
  const providers = await resolveProviders(config.preferredProviders);
  const primaryProviders = providers.length > 0 ? providers : ['cpu'];
  assertNotCancelled(isCancelled);

  status('preprocessing', 'Preparing image tensor...', 12, primaryProviders[0]);
  const image = await prepareImage(request.imagePath, request.focalPxOverride);
  assertNotCancelled(isCancelled);

  status('running-inference', `Running SHARP with ${primaryProviders[0].toUpperCase()}...`, 25, primaryProviders[0]);
  let outputs: ort.InferenceSession.OnnxValueMapType;
  let backend = primaryProviders[0];
  try {
    ({ outputs, backend } = await runOnProviders(
      config.modelPath,
      primaryProviders,
      image.tensor,
      image.focalPx / image.width,
    ));
  } catch (error) {
    if (primaryProviders.length === 1 && primaryProviders[0] === 'cpu') throw error;
    status('running-inference', `GPU failed, retrying on CPU: ${String(error)}`, 30, 'cpu');
    await releaseSession();
    ({ outputs, backend } = await runOnProviders(
      config.modelPath,
      ['cpu'],
      image.tensor,
      image.focalPx / image.width,
    ));
  }
  assertNotCancelled(isCancelled);

  status('postprocessing', 'Filtering Gaussians...', 70, backend);
  const meanVectors = tensorData(outputs, 'mean_vectors_ndc');
  const singularValues = tensorData(outputs, 'singular_values_ndc');
  const quaternions = tensorData(outputs, 'quaternions_ndc');
  const colors = tensorData(outputs, 'colors');
  const opacities = tensorData(outputs, 'opacities');
  const { pruned, totalCount } = pruneGaussians(
    meanVectors,
    singularValues,
    quaternions,
    colors,
    opacities,
    request.qualityPreset ?? 'balanced',
    {
      opacityThreshold: request.opacityThreshold,
      maxGaussians: request.maxGaussians,
    },
  );

  status('postprocessing', 'Converting NDC Gaussians to metric space...', 80, backend);
  unprojectGaussiansInPlace(pruned, image.width / (2 * image.focalPx), image.height / (2 * image.focalPx));
  assertNotCancelled(isCancelled);

  status('writing-ply', 'Writing Gaussian splat PLY...', 92, backend);
  const plyPath = await writePlyFile(
    {
      ...pruned,
      imageWidth: image.width,
      imageHeight: image.height,
      focalPx: image.focalPx,
    },
    config.outputDir,
    taskId,
  );

  return {
    taskId,
    plyPath,
    backend,
    durationMs: Date.now() - startedAt,
    selectedGaussians: pruned.count,
    totalGaussians: totalCount,
    image: {
      width: image.width,
      height: image.height,
      focalPx: image.focalPx,
      focalSource: image.focalSource,
    },
  };
}
