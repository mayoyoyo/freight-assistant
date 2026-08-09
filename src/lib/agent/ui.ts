import type { InferUITools, UIDataTypes, UIMessage } from "ai";
import type { freightTools } from "./tools";

/**
 * The message type shared by the route and the client. Type-only import of the
 * tool registry, so the client bundle never pulls in Drizzle or `pg`.
 */
export type FreightUIMessage = UIMessage<
  never,
  UIDataTypes,
  InferUITools<typeof freightTools>
>;
