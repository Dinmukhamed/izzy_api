import { z } from 'zod'

export const answerOptionSchema = z.object({
  text: z.string().min(1),
})

export const questionSchema = z.object({
  kind: z.enum(['text', 'image', 'audio']).default('text'),
  text: z.string().min(1),
  media: z
    .object({
      type: z.enum(['image', 'audio']),
      url: z.string().min(1),
    })
    .optional(),
  options: z.array(answerOptionSchema).length(4, 'A question must have exactly four answers'),
  correctOptionIndex: z.number().int().min(0).max(3),
  durationMs: z.number().int().min(5000).max(120000).default(20000),
  points: z.number().int().min(100).max(5000).default(1000),
})

export const createTemplateSchema = z.object({
  title: z.string().min(1),
  status: z.enum(['draft', 'active', 'archived']).default('draft'),
  questions: z.array(questionSchema).min(1),
})

export const updateTemplateSchema = createTemplateSchema

export const updateTemplateStatusSchema = z.object({
  status: z.enum(['draft', 'active', 'archived']),
})

export const createSessionSchema = z.object({
  templateId: z.string().min(1),
})

export const joinSessionSchema = z.object({
  name: z.string().min(1).max(32),
})

export const answerSchema = z.object({
  playerId: z.string().min(1),
  optionId: z.string().min(1),
})
