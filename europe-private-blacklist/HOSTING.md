# Europe Private Blacklist

Сайт: **https://europe.bothost.tech**

В архиве уже есть готовая сборка (`dist-output.tgz`). **vite на хостинге не нужен.**

## Панель

| Поле | Значение |
|---|---|
| Node | 20.20 или 22 |
| Установка | `true` (или `npm install`, не обязательно) |
| Сборка | `npm run build` |
| Запуск | `npm start` |

Папка: `europe-private-blacklist` без пробелов.

`npm run build` просто распакует готовую сборку. Не должен искать vite.

## Переменные

```
TELEGRAM_BOT_TOKEN=
TELEGRAM_ARBITER_CHAT_ID=-1003904954808
TELEGRAM_CHANNEL_ID=-1003958415589
PUBLIC_URL=https://europe.bothost.tech
PORT=3000
DATA_DIR=./data
```
