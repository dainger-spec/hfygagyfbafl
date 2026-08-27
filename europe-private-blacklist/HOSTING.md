# Europe Private Blacklist — выкладка на хостинг

Сайт: **https://europe.bothost.tech**

Токен в архиве нет. В панели: `TELEGRAM_BOT_TOKEN`

## Node

**22** или **20.20**. Alpine: пакет `libc6-compat`.

Папка без пробелов: `europe-private-blacklist`, не `europe-private-blacklist 2`.

## Команды в панели

| Поле | Значение |
|---|---|
| Установка | `npm install --include=dev` |
| Сборка | `npm run build` |
| Запуск | `npm start` |

Если панель ставит `NODE_ENV=production` до install — обязательно `--include=dev`, иначе не появится `vite`.

```bash
cd europe-private-blacklist
npm install --include=dev
npm run build
npm start
```

## Переменные

```
TELEGRAM_BOT_TOKEN=
TELEGRAM_ARBITER_CHAT_ID=-1003904954808
TELEGRAM_CHANNEL_ID=-1003958415589
PUBLIC_URL=https://europe.bothost.tech
PORT=3000
DATA_DIR=./data
```
