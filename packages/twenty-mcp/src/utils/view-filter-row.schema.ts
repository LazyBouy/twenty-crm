import { z } from 'zod';

/**
 * Runtime Zod schema for a single row from Twenty's view_filters response.
 *
 * Uses z.string().uuid() for fieldMetadataId (not z.string()) so that a UUID
 * rename producing a non-UUID value fails loudly rather than passing silently
 * via undefined.
 *
 * Uses default passthrough mode (not .strict()) so extra properties returned
 * by Twenty (e.g., displayValue, createdAt) are silently accepted — the schema
 * only validates the two fields the integration test asserts on.
 */
export const viewFilterRowSchema = z.object({
  fieldMetadataId: z.string().uuid(),
  operand: z.string().min(1),
});

export type ViewFilterRow = z.infer<typeof viewFilterRowSchema>;
