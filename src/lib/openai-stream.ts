export type OpenAIResponse = {
  status: string;
  output: {
    type: string;
    name?: string;
    namespace?: string;
    arguments?: string;
  }[];
  error?: { code?: string };
};
export async function completedResponse(
  response: Response,
): Promise<OpenAIResponse> {
  if (!response.body) throw Error("OpenAI returned an empty stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "",
    bytes = 0;
  // Some ChatGPT-plan streams omit `response.output` from the final completed
  // event even though they send the completed function-call item earlier in
  // the stream. Preserve those items as they arrive.
  const output: OpenAIResponse["output"] = [];
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      buffer = buffer.replace(/\r\n/g, "\n");
      bytes += chunk.value?.length || 0;
      if (bytes > 16 * 1024 * 1024)
        throw Error("OpenAI stream exceeded the local response limit.");
      if (chunk.done && buffer.trim()) buffer += "\n\n";
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data || data === "[DONE]") continue;
        const event = JSON.parse(data) as {
          type: string;
          response?: OpenAIResponse;
          item?: OpenAIResponse["output"][number];
          name?: string;
          arguments?: string;
        };
        if (event.type === "response.output_item.done" && event.item)
          output.push(event.item);
        if (
          event.type === "response.function_call_arguments.done" &&
          event.name &&
          event.arguments
        )
          output.push({
            type: "function_call",
            name: event.name,
            arguments: event.arguments,
          });
        if (event.type === "response.completed") {
          if (
            event.response?.status !== "completed" ||
            !Array.isArray(event.response.output)
          )
            throw Error("OpenAI completion was invalid.");
          const finalOutput = event.response.output.length
            ? event.response.output
            : output;
          const uniqueOutput = finalOutput.filter(
            (item, index) =>
              finalOutput.findIndex(
                (other) =>
                  other.type === item.type &&
                  other.name === item.name &&
                  other.namespace === item.namespace &&
                  other.arguments === item.arguments,
              ) === index,
          );
          return {
            ...event.response,
            output: uniqueOutput,
          };
        }
        if (
          ["response.failed", "response.incomplete", "error"].includes(
            event.type,
          )
        ) {
          const code = event.response?.error?.code;
          if (code === "subscription_sharing_usage_limit_exceeded")
            throw Error(
              "Your ChatGPT plan usage limit was reached. Manage usage in ChatGPT Settings.",
            );
          if (code === "subscription_sharing_usage_unavailable")
            throw Error(
              "ChatGPT plan usage is unavailable for this account. Review app access in ChatGPT Settings.",
            );
          throw Error(
            event.type === "response.incomplete"
              ? "OpenAI response was incomplete."
              : "OpenAI response failed. Check connection access and usage limits in Settings.",
          );
        }
      }
      if (chunk.done)
        throw Error("OpenAI stream ended without a completed response.");
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
