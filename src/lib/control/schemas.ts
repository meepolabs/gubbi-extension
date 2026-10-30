import { z } from "zod";

import { PlatformSchema } from "../schema/ingest";

// Runtime validation of control payloads at the background boundary. Strict
// objects: an unknown extra field is a malformed message, not ignored data.
//
// Background-only (zod).

export const ControlMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("SYNC_START"), platform: PlatformSchema.optional() }),
  z.strictObject({ type: z.literal("STATUS_REQUEST") }),
  z.strictObject({ type: z.literal("PAIR_START") }),
  z.strictObject({ type: z.literal("UNPAIR") }),
  z.strictObject({
    type: z.literal("SET_PLATFORM_ENABLED"),
    platform: PlatformSchema,
    enabled: z.boolean(),
  }),
]);

export type ParsedControlMessage = z.infer<typeof ControlMessageSchema>;
