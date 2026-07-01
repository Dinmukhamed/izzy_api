import { randomUUID } from 'node:crypto'

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function createId() {
  return randomUUID()
}

export function createGameCode(length = 6) {
  let code = ''

  for (let i = 0; i < length; i += 1) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  }

  return code
}
