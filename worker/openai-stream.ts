import { streamCursorText, type CursorTextEvent } from "./cursor";
import { sseResponse } from "./http";
import {
  chatChunk,
  chatUsageChunk,
  completionCharsFromOutput,
  doneChunk,
  responseCreatedEvents,
  responseDeltaEvent,
  responseDoneEvents,
  responseFailedEvent,
  responseTextStartEvents,
  responseToolCallEvents,
  toOpenAiToolCalls,
  type OpenAiToolCall,
  type OpenAiToolSpec,
  type ToolCallContext
} from "./openai";
import { encodeSse } from "./sse";

export type OpenAiStreamKind = "chat" | "responses";

export interface OpenAiStreamInput {
  id: string;
  created: number;
  model: string;
  promptChars: number;
  includeUsage: boolean;
  metadata?: Record<string, unknown>;
  tools: OpenAiToolSpec[];
  context?: ToolCallContext;
  onBillingError?: (error: unknown) => void | Promise<void>;
  isBillingError?: (error: unknown) => boolean;
  onDone?: (text: string, completionChars: number, toolCalls: OpenAiToolCall[]) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
}

export type StreamTaskScheduler =
  | { waitUntil(task: Promise<unknown>): void }
  | ((task: Promise<void>) => void);

export function streamOpenAiResponse(
  kind: OpenAiStreamKind,
  cursorStream: Response,
  input: OpenAiStreamInput,
  scheduler?: StreamTaskScheduler
): Response {
  return streamOpenAiEvents(kind, streamCursorText(cursorStream), input, scheduler);
}

export function streamOpenAiEvents(
  kind: OpenAiStreamKind,
  cursorEvents: AsyncIterable<CursorTextEvent>,
  input: OpenAiStreamInput,
  scheduler?: StreamTaskScheduler
): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  const pump = async (): Promise<void> => {
    let text = "";
    let toolCallCount = 0;
    let finishReason: "stop" | "tool_calls" = "stop";
    const streamedToolCalls: OpenAiToolCall[] = [];
    let responseNextOutputIndex = 0;
    let responseTextOutputIndex: number | null = null;

    try {
      if (kind === "chat") {
        await writer.write(chatChunk({ id: input.id, created: input.created, model: input.model, role: "assistant" }));
      } else {
        for (const event of responseCreatedEvents(input)) await writer.write(event);
      }

      for await (const event of cursorEvents) {
        if (event.type === "text" && event.text) {
          text += event.text;
          if (kind === "chat") {
            await writer.write(chatChunk({ id: input.id, created: input.created, model: input.model, delta: event.text }));
          } else {
            if (responseTextOutputIndex === null) {
              responseTextOutputIndex = responseNextOutputIndex;
              responseNextOutputIndex += 1;
              for (const chunk of responseTextStartEvents({ id: input.id, outputIndex: responseTextOutputIndex })) {
                await writer.write(chunk);
              }
            }
            await writer.write(responseDeltaEvent({ id: input.id, delta: event.text, outputIndex: responseTextOutputIndex }));
          }
        }

        if (event.type === "tool_call") {
          const [toolCall] = toOpenAiToolCalls({
            toolCalls: [event.toolCall],
            tools: input.tools,
            responseId: input.id,
            startIndex: toolCallCount,
            context: input.context
          });
          if (!toolCall) continue;
          finishReason = "tool_calls";
          streamedToolCalls.push(toolCall);
          if (kind === "chat") {
            await writer.write(
              chatChunk({
                id: input.id,
                created: input.created,
                model: input.model,
                toolCall: { index: toolCallCount, value: toolCall }
              })
            );
          } else {
            for (const chunk of responseToolCallEvents({ id: input.id, toolCall, outputIndex: responseNextOutputIndex })) {
              await writer.write(chunk);
            }
            responseNextOutputIndex += 1;
          }
          toolCallCount += 1;
        }

        if (event.type === "done") text = event.finalText;
      }

      const completionChars = completionCharsFromOutput(text, streamedToolCalls);
      if (kind === "chat") {
        await writer.write(chatChunk({ id: input.id, created: input.created, model: input.model, finish: true, finishReason }));
        if (input.includeUsage) {
          await writer.write(chatUsageChunk({
            id: input.id,
            created: input.created,
            model: input.model,
            promptChars: input.promptChars,
            completionChars
          }));
        }
        await writer.write(doneChunk());
      } else {
        if (responseTextOutputIndex === null && !streamedToolCalls.length) {
          responseTextOutputIndex = responseNextOutputIndex;
          responseNextOutputIndex += 1;
          for (const chunk of responseTextStartEvents({ id: input.id, outputIndex: responseTextOutputIndex })) {
            await writer.write(chunk);
          }
        }
        for (const event of responseDoneEvents({
          ...input,
          text,
          toolCalls: streamedToolCalls,
          textStarted: responseTextOutputIndex !== null,
          textOutputIndex: responseTextOutputIndex ?? 0
        })) {
          await writer.write(event);
        }
      }

      try {
        await input.onDone?.(text, completionChars, streamedToolCalls);
      } catch (callbackError) {
        console.warn(JSON.stringify({
          event: "stream_completion_callback_failed",
          message: callbackError instanceof Error ? callbackError.message : String(callbackError)
        }));
      }
    } catch (error) {
      if (input.onBillingError && input.isBillingError?.(error)) {
        await Promise.resolve(input.onBillingError(error)).catch(() => undefined);
      }
      await Promise.resolve(input.onError?.(error)).catch(() => undefined);
      const message = error instanceof Error ? error.message : "Stream failed";
      const terminal = kind === "responses"
        ? responseFailedEvent({
            id: input.id,
            created: input.created,
            model: input.model,
            message,
            metadata: input.metadata
          })
        : encodeSse({ error: { message, type: "cursor_error", code: "cursor_stream_error" } }, "error");
      await writer.write(terminal).catch(() => undefined);
    } finally {
      await writer.close().catch(() => undefined);
    }
  };

  const task = pump().catch(() => undefined);
  if (typeof scheduler === "function") scheduler(task);
  else if (scheduler) scheduler.waitUntil(task);
  else void task;

  return sseResponse(readable);
}
