export type AsyncStreamFactory<T> = (attempt: number) => Promise<AsyncIterable<T>>;
export type TransientErrorPredicate = (error: unknown) => boolean;

/**
 * Retry an async stream only when a transient failure happens before any output.
 *
 * The inner iterator is always closed when the outer consumer stops early. This is
 * critical for streaming HTTP requests: downstream disconnect -> outer return() ->
 * inner return() -> response body cancel -> upstream request abort.
 */
export function retryingAsyncStream<T>(
  make: AsyncStreamFactory<T>,
  isTransientError: TransientErrorPredicate,
  maxAttempts = 2
): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (let attempt = 0; ; attempt += 1) {
        const iterator = (await make(attempt))[Symbol.asyncIterator]();
        let emitted = false;
        let completed = false;

        try {
          for (;;) {
            const next = await iterator.next();
            if (next.done) {
              completed = true;
              return;
            }
            emitted = true;
            yield next.value;
          }
        } catch (error) {
          if (!emitted && attempt + 1 < maxAttempts && isTransientError(error)) continue;
          throw error;
        } finally {
          if (!completed) {
            try {
              await iterator.return?.();
            } catch {
              // Cleanup must not replace the original stream completion/error.
            }
          }
        }
      }
    }
  };
}
