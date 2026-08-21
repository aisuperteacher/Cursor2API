import type { ServerResponse } from "node:http";

function waitForDrainOrClose(res: ServerResponse): Promise<void> {
  if (res.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      res.off("drain", finish);
      res.off("close", finish);
      resolve();
    };
    res.once("drain", finish);
    res.once("close", finish);
  });
}

export async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);

  if (!response.body) {
    res.end();
    return;
  }

  const reader = response.body.getReader();
  let clientClosed = res.destroyed;
  const onClose = () => {
    clientClosed = true;
    void reader.cancel("downstream client disconnected").catch(() => undefined);
  };
  res.on("close", onClose);

  try {
    for (;;) {
      if (clientClosed) break;
      const { value, done } = await reader.read();
      if (done || clientClosed) break;
      if (value && !res.write(Buffer.from(value))) {
        await waitForDrainOrClose(res);
      }
    }
  } catch (error) {
    if (!clientClosed) throw error;
  } finally {
    res.off("close", onClose);
    if (clientClosed) {
      await reader.cancel("downstream client disconnected").catch(() => undefined);
    }
    reader.releaseLock();
    if (!res.writableEnded && !res.destroyed) res.end();
  }
}
