import { z } from 'zod';

export const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._:-]{1,79}$/, 'Use 2–80 lowercase letters, digits, dots, underscores, colons, or hyphens.');
export const shortText = z.string().trim().min(1).max(500);
export const longText = z.string().trim().min(1).max(40_000);
export const capability = z.string().trim().min(1).max(80);
export const capabilities = z.array(capability).max(32);
export const priority = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export const leaseSeconds = z.number().int().min(60).max(86_400);
export const details = z.string().trim().max(2_000);
export const taskStatus = z.enum(['queued', 'claimed', 'blocked', 'completed', 'cancelled']);

export const agentProfile = z.object({
  slug,
  displayName: shortText,
  modelSlug: shortText,
  capabilities: capabilities.min(1),
  details: details.optional(),
});

export const newTask = z.object({
  recipientSlug: slug,
  title: shortText,
  instructions: longText,
  requiredCapabilities: capabilities.default([]),
  priority: priority.default(2),
});
