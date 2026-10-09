export const streamEvents = (events: unknown[]) =>
  new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
export const streamResult = (input: unknown) =>
  streamEvents([
    {
      type: "response.completed",
      response: {
        status: "completed",
        output: [
          {
            type: "function_call",
            namespace: "job_finder",
            name: "structured_result",
            arguments: JSON.stringify(input),
          },
        ],
      },
    },
  ]);
