import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { Effect, Schema } from "effect";

export class Model extends Effect.Service<Model>()("Model", {
  effect: Effect.gen(function* (_) {
    const key = yield* Schema.Config("GEMINI_API_KEY", Schema.NonEmptyString);
    const model = createGoogleGenerativeAI({
      apiKey: key,
    })("gemini-2.5-pro-exp-03-25");

    return model;
  }),
}) {}
