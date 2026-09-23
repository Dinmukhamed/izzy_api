import type { GameTemplate, Question } from '../domain/types.js'
import { createId } from '../utils/id.js'
import type { QuizRepository } from '../repositories/quizRepository.js'
import type { createTemplateSchema, updateTemplateSchema } from '../validation/schemas.js'
import type { z } from 'zod'

type CreateTemplateInput = z.infer<typeof createTemplateSchema>
type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>

export class TemplateService {
  constructor(private readonly repository: QuizRepository) {}

  async listTemplates() {
    return this.repository.listTemplates()
  }

  async getTemplate(id: string) {
    return this.repository.getTemplate(id)
  }

  async createTemplate(input: CreateTemplateInput) {
    const template = this.buildTemplate(input)

    return this.repository.createTemplate(template)
  }

  async updateTemplate(id: string, input: UpdateTemplateInput) {
    const existingTemplate = await this.repository.getTemplate(id)
    if (!existingTemplate) throw new Error('Template not found')

    const template = this.buildTemplate(input, id, existingTemplate.createdAt)

    return this.repository.updateTemplate(template)
  }

  async updateTemplateStatus(id: string, status: CreateTemplateInput['status']) {
    const template = await this.repository.getTemplate(id)
    if (!template) throw new Error('Template not found')

    template.status = status
    template.updatedAt = new Date().toISOString()

    return this.repository.updateTemplate(template)
  }

  async deleteTemplate(id: string) {
    const template = await this.repository.getTemplate(id)
    if (!template) throw new Error('Template not found')

    const sessions = await this.repository.listSessions()
    const relatedSessions = sessions.filter((session) => session.templateId === id)

    for (const session of relatedSessions) {
      if (session.templateSnapshot) continue

      session.templateSnapshot = cloneTemplate(template)
      await this.repository.updateSession(session)
    }

    await this.repository.deleteTemplate(id)
  }

  private buildTemplate(input: CreateTemplateInput | UpdateTemplateInput, id: string = createId(), createdAt?: string) {
    const now = new Date().toISOString()
    const template: GameTemplate = {
      id,
      title: input.title,
      status: input.status,
      questions: input.questions.map((questionInput) => {
        const options = questionInput.options.map((optionInput) => ({
          id: createId(),
          text: optionInput.text,
        }))
        const correctOption = options[questionInput.correctOptionIndex]

        if (!correctOption) {
          throw new Error('Correct option index is out of range')
        }

        const question: Question = {
          id: createId(),
          kind: questionInput.kind,
          text: questionInput.text,
          media: questionInput.media,
          options,
          correctOptionId: correctOption.id,
          durationMs: questionInput.durationMs,
          points: questionInput.points,
        }

        return question
      }),
      createdAt: createdAt || now,
      updatedAt: now,
    }

    return template
  }
}

function cloneTemplate(template: GameTemplate) {
  return JSON.parse(JSON.stringify(template)) as GameTemplate
}
