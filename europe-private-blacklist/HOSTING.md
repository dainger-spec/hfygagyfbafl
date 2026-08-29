# Europe Private Blacklist — хостинг

Нужен Node 20+. Alpine 22 тоже подходит.

1. Остановите приложение.
2. Удалите старые файлы приложения, **особенно папку `.output`**.
   Папку `data` лучше не трогать — в ней заявки, ID и доказательства.
3. Залейте этот архив (папка `europe-private-blacklist`).
4. В `.env` или в панели хоста укажите:

```
TELEGRAM_BOT_TOKEN=ваш_токен
PUBLIC_URL=https://europe.bothost.tech
PORT=3000
HOST=0.0.0.0
DATA_DIR=./data
```

5. `npm run build`
6. `npm start`

Без удаления `.output` может подняться старая сборка.
Папка `data` должна быть доступна на запись.
`PUBLIC_URL` — тот адрес, с которого открывается Mini App и вебхук бота.
