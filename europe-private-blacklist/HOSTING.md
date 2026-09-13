# Europe Private Blacklist — хостинг

Нужен Node 20+. Alpine 22 тоже подходит.

1. Остановите приложение.
2. Удалите все старые файлы, особенно папку `.output`.
3. Залейте этот архив (папка `europe-private-blacklist`).
4. В `.env` укажите токен бота и публичный URL:

```
TELEGRAM_BOT_TOKEN=ваш_токен
PUBLIC_URL=https://europe.bothost.tech
PORT=3000
DATA_DIR=./data
```

5. `npm run build`
6. `npm start`

Без удаления `.output` поднимется старая сборка.
