import type { TemplateService } from '../services/templateService.js'

export async function seedDemoTemplate(templateService: TemplateService) {
  const existingTemplates = await templateService.listTemplates()
  if (existingTemplates.length > 0) return existingTemplates[0]

  return templateService.createTemplate({
    title: 'Izzy Quiz Demo',
    status: 'active',
    questions: [
      {
        kind: 'text',
        text: 'Какой город является столицей Казахстана?',
        options: [{ text: 'Алматы' }, { text: 'Астана' }, { text: 'Шымкент' }, { text: 'Караганда' }],
        correctOptionIndex: 1,
        durationMs: 20000,
        points: 1000,
      },
      {
        kind: 'text',
        text: 'Сколько нот в классической музыкальной октаве?',
        options: [{ text: '5' }, { text: '6' }, { text: '7' }, { text: '8' }],
        correctOptionIndex: 2,
        durationMs: 15000,
        points: 1000,
      },
    ],
  })
}
