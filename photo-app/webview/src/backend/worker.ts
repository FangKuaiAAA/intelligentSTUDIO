import * as path from 'path';
import * as readline from 'readline';
import { runSharpInference } from './inference';
import { getPreferredProviders, getRuntimeCapabilities } from './runtime';
import type { BackendRequest, BackendResponse } from '../shared/types';

const parentPort = (process as NodeJS.Process & {
  parentPort?: {
    on: (event: 'message', cb: (messageEvent: MessageEvent | { data?: BackendRequest } | BackendRequest) => void) => void;
    postMessage: (message: BackendResponse) => void;
  };
}).parentPort;

const cancelledTasks = new Set<string>();

function post(message: BackendResponse): void {
  if (parentPort) {
    parentPort.postMessage(message);
    return;
  }

  // 独立 node 进程：stdout 只承载协议行，任何日志必须走 stderr
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/**
 * 监听宿主消息。Electron 下走 parentPort；独立进程下行协议（每行一个 JSON）。
 */
function listen(handler: (message: BackendRequest) => void): void {
  if (parentPort) {
    parentPort.on('message', (event) => {
      const message = unwrapMessage(event);
      if (message) handler(message);
    });
    return;
  }

  const reader = readline.createInterface({ input: process.stdin });
  reader.on('line', (line) => {
    const text = line.trim();
    if (!text) return;

    try {
      const message = JSON.parse(text) as BackendRequest;
      if (message && typeof message === 'object' && 'type' in message) handler(message);
    } catch {
      process.stderr.write(`bad message: ${text.slice(0, 120)}\n`);
    }
  });
}

function unwrapMessage(messageEvent: MessageEvent | { data?: BackendRequest } | BackendRequest): BackendRequest | null {
  const maybeEvent = messageEvent as { data?: BackendRequest };
  const message = maybeEvent.data ?? (messageEvent as BackendRequest);
  if (!message || typeof message !== 'object' || !('type' in message)) return null;
  return message;
}

async function handleRun(message: Extract<BackendRequest, { type: 'run' }>): Promise<void> {
  const { taskId, payload, config } = message;
  cancelledTasks.delete(taskId);
  post({ type: 'status', status: { taskId, stage: 'queued', message: 'Queued', progress: 0 } });
  try {
    const result = await runSharpInference({
      taskId,
      request: payload,
      config,
      onStatus: (status) => post({ type: 'status', status }),
      isCancelled: () => cancelledTasks.has(taskId),
    });
    if (cancelledTasks.has(taskId)) {
      post({ type: 'status', status: { taskId, stage: 'cancelled', message: 'Cancelled' } });
      return;
    }
    post({ type: 'status', status: { taskId, stage: 'ready', message: 'Ready', progress: 100, backend: result.backend } });
    post({ type: 'result', taskId, result });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    const stage = text.toLowerCase().includes('cancel') ? 'cancelled' : 'failed';
    post({ type: 'status', status: { taskId, stage, message: text } });
    post({ type: 'error', taskId, error: text });
  } finally {
    cancelledTasks.delete(taskId);
  }
}

async function handleCapabilities(message: Extract<BackendRequest, { type: 'capabilities' }>): Promise<void> {
  const capabilities = await getRuntimeCapabilities(message.config.preferredProviders);
  post({ type: 'capabilities', requestId: message.requestId, capabilities });
}

listen((message) => {
  if (message.type === 'cancel') {
    if (message.taskId) cancelledTasks.add(message.taskId);
    return;
  }

  if (message.type === 'capabilities') {
    void handleCapabilities(message);
    return;
  }
  if (message.type === 'run') {
    void handleRun(message);
  }
});

async function runSmoke(): Promise<void> {
  const imagePath = path.resolve(process.argv[3] ?? 'output/test-image.jpg');
  const root = path.resolve(__dirname, '..', '..');
  const result = await runSharpInference({
    taskId: 'smoke',
    request: { imagePath, qualityPreset: 'balanced' },
    config: {
      modelPath: path.join(root, 'models', 'sharp_web_predictor.onnx'),
      outputDir: path.join(root, 'output'),
      preferredProviders: getPreferredProviders(),
    },
    onStatus: (status) => console.log(JSON.stringify(status)),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (!parentPort && process.argv.includes('--smoke')) {
  runSmoke().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
