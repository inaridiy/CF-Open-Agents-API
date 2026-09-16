import { z } from "zod";

export const programmaticInputSchema = z.strictObject({
  code: z.string().min(1).max(128_000),
  arguments: z.json().optional(),
});
export const programmaticTool = {
  name: "cf_execute",
  description:
    "Run JavaScript in a fresh isolated worker. Call configured tools with await tools.NAME(arguments), use Promise.all for parallel calls, and return a JSON value. No network, filesystem, imports or credentials are available. Tool results contain content and isError. Only the returned value reaches the model. Code and tools have bounded execution time.",
  inputSchema: z.toJSONSchema(programmaticInputSchema, { io: "input" }),
};
