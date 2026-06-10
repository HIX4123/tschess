import { searchBestMove, type AiRequest, type AiWorkerMessage } from './ai.ts';

type WorkerScope = {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<AiRequest>) => void,
  ): void;
  postMessage(message: AiWorkerMessage): void;
};

const workerScope = globalThis as unknown as WorkerScope;

workerScope.addEventListener('message', (event) => {
  const response = searchBestMove(event.data, (progress) => {
    workerScope.postMessage(progress);
  });

  workerScope.postMessage({ ...response, kind: 'result' });
});
