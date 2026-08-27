# Europe Private Blacklist — выкладка на хостинг

Сайт: **https://europe.bothost.tech**

Токен бота в архиве **не лежит**. Укажите его в панели хостинга:

`TELEGRAM_BOT_TOKEN` = токен от BotFather

## Node

**22 LTS** или **20.20**. Alpine — ок, с `libc6-compat`.

## Команды

```bash
unzip europe-private-blacklist.zip
cd europe-private-blacklist
npm install
npm run build
npm start
```

| Поле | Значение |
|---|---|
| Node | **22** или **20.20** |
| Сборка | `npm run build` |
| Запуск | `npm start` |
| Домен | `https://europe.bothost.tech` |

## Переменные окружения (панель хостинга)

```
TELEGRAM_BOT_TOKEN=          ← ваш токен
TELEGRAM_ARBITER_CHAT_ID=-1003904954808
TELEGRAM_CHANNEL_ID=-1003958415589
PUBLIC_URL=https://europe.bothost.tech
PORT=3000
DATA_DIR=./data
```

Webhook: `https://europe.bothost.tech/api/telegram/webhook`  
Mini App: `https://europe.bothost.tech`
