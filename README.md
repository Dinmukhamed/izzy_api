# Izzy API

Lightweight realtime backend for Izzy Quiz live games.

## What is inside

- Fastify HTTP API for admin and player actions.
- Socket.IO realtime updates for lobby, questions, answers and scoreboard.
- SQLite repository in `data/izzy.sqlite`, isolated behind `QuizRepository` so PostgreSQL can be added later if needed.
- Speed-based scoring: correct answers get more points when answered faster.

## Local start

```bash
cp .env.example .env
npm run dev
```

Default API URL: `http://127.0.0.1:4010`

Default admin token in development: `dev-admin-token`

Local media uploads are stored in `data/uploads`.

Production env example behind nginx:

```env
PORT=4010
HOST=127.0.0.1
ADMIN_TOKEN=change-me
CORS_ORIGIN=https://izzyquiz.kz,https://www.izzyquiz.kz
DATA_DIR=data
PUBLIC_BASE_URL=https://izzyquiz.kz
```

## Main HTTP endpoints

Admin endpoints need:

```http
Authorization: Bearer dev-admin-token
```

- `POST /admin/templates` - create quiz template with questions.
- `GET /admin/templates` - list templates.
- `POST /admin/sessions` - create live session from template.
- `GET /admin/sessions/:code` - full host state.
- `POST /admin/sessions/:code/lock-lobby` - stop new joins.
- `POST /admin/sessions/:code/start` - start game.
- `POST /admin/sessions/:code/next-question` - open next question.
- `POST /admin/sessions/:code/close-question` - stop answers.
- `POST /admin/sessions/:code/show-answer` - reveal answer on host screen.
- `POST /admin/sessions/:code/finish` - finish session.
- `GET /sessions/:code` - public player state.
- `POST /sessions/:code/join` - join as player.
- `POST /sessions/:code/answer` - submit answer.

## Socket events

Client receives:

- `session:state` - safe public state for players.
- `host:state` - full state for admin/host screen.

Client sends:

- `host:join` with `{ code, token }`
- `host:open-lobby`, `host:lock-lobby`, `host:start`, `host:next-question`, `host:close-question`, `host:show-answer`, `host:finish`
- `player:join-room` with `{ code, playerId }`
- `player:answer` with `{ code, playerId, optionId }`

Every socket event supports an acknowledgement callback:

```ts
socket.emit('host:start', { code, token }, (response) => {
  if (!response.ok) console.log(response.error)
})
```

## Next backend step

Replace `InMemoryQuizRepository` with a DB-backed repository. The services and routes should not need major changes.
