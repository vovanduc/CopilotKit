import { ChatCompletionChunk } from "@copilotkit/shared";
import {
  AIMessage,
  BaseMessage,
  BaseMessageChunk,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { IterableReadableStream } from "@langchain/core/utils/stream";
import { CopilotKitServiceAdapter } from "../types";

export type LangChainMessageStream = IterableReadableStream<BaseMessageChunk>;
export type LangChainReturnType = LangChainMessageStream | BaseMessageChunk | string;

export class LangChainAdapter implements CopilotKitServiceAdapter {
  constructor(private chainFn: (forwardedProps: any) => Promise<LangChainReturnType>) {}

  async stream(forwardedProps: any): Promise<ReadableStream<any>> {
    forwardedProps = this.transformProps(forwardedProps);

    const result = await this.chainFn(forwardedProps);

    // We support 3 types of return values from LangChain functions:

    // 1. LangChainMessageStream
    // In this case we get streaming output from LangChain and proxy the stream to the client.
    if (result instanceof IterableReadableStream) {
      return this.streamResult(result);
    }
    // 2. BaseMessageChunk
    // The is a single chunk of output that might contain a function call.
    // We wrap this in a stream and send it to the client.
    else if (result instanceof BaseMessageChunk) {
      return new SingleChunkReadableStream(
        result.lc_kwargs?.content,
        result.lc_kwargs?.function_call,
      );
    }
    // 3. string
    // Just send one chunk with the string as the content.
    else if (typeof result === "string") {
      return new SingleChunkReadableStream(result);
    }

    throw new Error("Invalid return type from LangChain function.");
  }

  /**
   * Transforms the props that are forwarded to the LangChain function.
   * Currently this just transforms the messages to the format that LangChain expects.
   *
   * @param forwardedProps
   * @returns {any}
   */
  private transformProps(forwardedProps: any) {
    const forwardedPropsCopy = Object.assign({}, forwardedProps);

    // map messages to langchain format
    if (forwardedProps.messages && Array.isArray(forwardedProps.messages)) {
      const newMessages: BaseMessage[] = [];
      for (const message of forwardedProps.messages) {
        if (message.role === "user") {
          newMessages.push(new HumanMessage(message.content));
        } else if (message.role === "assistant") {
          newMessages.push(new AIMessage(message.content));
        } else if (message.role === "system") {
          newMessages.push(new SystemMessage(message.content));
        }
      }
      forwardedPropsCopy.messages = newMessages;
    }

    return forwardedPropsCopy;
  }

  /**
   * Reads from the LangChainMessageStream and converts the output to a ReadableStream.
   *
   * @param streamedChain
   * @returns ReadableStream
   */
  streamResult(streamedChain: LangChainMessageStream): ReadableStream<any> {
    let reader = streamedChain.getReader();

    async function cleanup(controller?: ReadableStreamDefaultController<BaseMessageChunk>) {
      if (controller) {
        try {
          controller.close();
        } catch (_) {}
      }
      if (reader) {
        try {
          await reader.cancel();
        } catch (_) {}
      }
    }

    return new ReadableStream<any>({
      async pull(controller) {
        while (true) {
          try {
            const { done, value } = await reader.read();

            if (done) {
              const payload = new TextEncoder().encode("data: [DONE]\n\n");
              controller.enqueue(payload);
              await cleanup(controller);
              return;
            }

            const functionCall = value.lc_kwargs?.additional_kwargs?.function_call;
            const content = value?.lc_kwargs?.content;
            const chunk: ChatCompletionChunk = {
              choices: [
                {
                  delta: {
                    role: "assistant",
                    content: content,
                    ...(functionCall ? { function_call: functionCall } : {}),
                  },
                },
              ],
            };
            const payload = new TextEncoder().encode("data: " + JSON.stringify(chunk) + "\n\n");
            controller.enqueue(payload);
          } catch (error) {
            controller.error(error);
            await cleanup(controller);
            return;
          }
        }
      },
      cancel() {
        cleanup();
      },
    });
  }
}

/**
 * A ReadableStream that only emits a single chunk.
 */
class SingleChunkReadableStream extends ReadableStream<any> {
  constructor(content: string = "", functionCall?: any) {
    super({
      start(controller) {
        const chunk: ChatCompletionChunk = {
          choices: [
            {
              delta: {
                role: "assistant",
                content,
                ...(functionCall ? { function_call: functionCall } : {}),
              },
            },
          ],
        };
        let payload = new TextEncoder().encode("data: " + JSON.stringify(chunk) + "\n\n");
        controller.enqueue(payload);

        payload = new TextEncoder().encode("data: [DONE]\n\n");
        controller.enqueue(payload);

        controller.close();
      },
      cancel() {},
    });
  }
}
