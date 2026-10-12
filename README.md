# Hof

Небольшой набор веб-приложений для себя, семьи или небольшой группы людей на своём сервере.
Что это и зачем — [PRODUCT.md](PRODUCT.md), как устроено — [ARCHITECTURE.md](ARCHITECTURE.md).

## Разработка

Нужны Node.js 24.12 или новее с npm и Docker с Compose (на macOS — например, colima).
Сборки нет: Node запускает `.ts` напрямую, удаляя типы.

Один раз — конфигурация и база для разработки:

```sh
cp .env.example .env && chmod 600 .env   # заполнить пароли: openssl rand -hex 24
docker compose -f compose.dev.yaml up -d # PostgreSQL 18 на 127.0.0.1:5433
```

Контейнер создаёт базы `hof` (для `npm run dev`) и `hof_test` (для тестов), роли `hof_core` и
`hof_saeckel` и их схемы — скриптом `deploy/postgres-init.sh`. Скрипт выполняется только на
пустом томе; после его изменения том пересоздают:

```sh
docker compose -f compose.dev.yaml down -v && docker compose -f compose.dev.yaml up -d
```

Порт 5433 выбран, чтобы не мешать локально установленному PostgreSQL на 5432. Сервер и тесты
находят его через стандартную переменную `PGPORT` из `.env`.

```sh
npm ci          # зависимости строго по package-lock.json
npm run dev     # сервер на http://localhost:3000, перезапуск при изменении файлов
npm run check   # prettier --check, eslint, tsc --noEmit, node --test, docker compose build
npm run format  # отформатировать всё через prettier
```

`npm run check` должен проходить перед каждым коммитом; тестам нужна запущенная база.

При старте сервер применяет новые миграции (`src/<модуль>/migrations/NNN_*.sql`) к базе `hof` и
только потом открывает порт. Тесты работают с `hof_test` и выполняются последовательно.

### Первый запуск в браузере (localhost)

Пока Хозяина нет, сервер при старте пишет в лог строку `info gate_key key=XXXXX-XXXXX-XXXXX-XXXXX`.
Любой адрес ведёт на `/setup`; после основания двора `/` открывает Двор.

Cookie сессии — `__Host-hof` с `Secure`. По HTTP её принимают только браузеры, которые считают
`http://localhost` безопасным, а форма работает, только если браузер присылает на POST заголовок
`Origin`. Как проверить браузер: `npm run dev`, открыть `http://localhost:3000`, ввести ключ из лога,
логин и пароль.

- Открылся Двор — `Origin` пришёл, cookie принята.
- «Запрос отклонён» (403) — браузер не прислал `Origin`.
- Переход на `/login` после основания — cookie не принята.

Чтобы пройти первый запуск заново, Хозяина и сессии в dev-базе удаляют:

```sh
docker compose -f compose.dev.yaml exec postgres psql -U postgres -d hof -c 'TRUNCATE core.sessions, core.users RESTART IDENTITY'
```

| Браузер                                          | Дата       | `Origin` на POST | `__Host-hof` Secure на `http://localhost`        |
| ------------------------------------------------ | ---------- | ---------------- | ------------------------------------------------ |
| Chromium 152 (встроенный браузер Claude Desktop) | 2026-10-12 | приходит         | принимается; из JavaScript не видна (`HttpOnly`) |
| Google Chrome 154                                | —          | не проверено     | не проверено                                     |
| Safari 26.3                                      | —          | не проверено     | не проверено                                     |
| Firefox                                          | —          | не установлен    | не установлен                                    |

### Production compose локально

`compose.yaml` — то, что будет работать на сервере: `postgres` и `hof` из образа по `Dockerfile`.
Пароли берутся из того же `.env`; каждый контейнер получает только свои.

```sh
docker compose up -d --build  # собрать образ hof и запустить оба контейнера
docker compose logs hof       # строка `info start` и применённые миграции
docker compose down           # остановить; с -v — удалить и том с данными
```

Наружу порты пока не открыты, сервер виден только внутри сети compose. Данные лежат в томе
`hof_pgdata`, отдельно от dev-тома `hof-dev_pgdata`, так что обе базы могут работать одновременно.

Код сервера — в `src/`, тесты лежат рядом с кодом (`*.test.ts`). В TypeScript допустим только
синтаксис, который Node может просто стереть: без `enum`, `namespace` с кодом, parameter
properties и декораторов (ARCHITECTURE.md §7) — `tsc` такие конструкции отклоняет.

`design/` — утверждённый визуальный эталон и исходники картинок и звуков, а не код сервера.
