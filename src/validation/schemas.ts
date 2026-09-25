import { z } from 'zod'

export const gameCodeSchema = z.string().trim().min(4).max(12).transform((value) => value.toUpperCase())

export const answerOptionSchema = z.object({
  text: z.string().trim().min(1).max(180),
})

export const questionSchema = z.object({
  kind: z.enum(['text', 'image', 'audio']).default('text'),
  text: z.string().trim().min(1).max(500),
  media: z
    .object({
      type: z.enum(['image', 'audio']),
      url: z.string().trim().min(1).max(2048),
    })
    .optional(),
  options: z.array(answerOptionSchema).length(4, 'A question must have exactly four answers'),
  correctOptionIndex: z.number().int().min(0).max(3),
  durationMs: z.number().int().min(5000).max(120000).default(20000),
  points: z.number().int().min(100).max(5000).default(1000),
})

export const createTemplateSchema = z.object({
  title: z.string().trim().min(1).max(120),
  status: z.enum(['draft', 'active', 'archived']).default('draft'),
  questions: z.array(questionSchema).min(1).max(100),
})

export const updateTemplateSchema = createTemplateSchema

export const updateTemplateStatusSchema = z.object({
  status: z.enum(['draft', 'active', 'archived']),
})

export const createSessionSchema = z.object({
  templateId: z.string().min(1),
})

export const joinSessionSchema = z.object({
  name: z.string().trim().min(2).max(32),
})

export const answerSchema = z.object({
  optionId: z.string().min(1),
  requestId: z.string().uuid(),
})

export const playerTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
