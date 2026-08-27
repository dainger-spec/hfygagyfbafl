# Europe Private Blacklist — выкладка на хостинг

## Какой Node выбирать

**Node.js 22 LTS.**

Если 22 нет в списке — берите **20** (не ниже 20.19).  
18 и ниже не подойдут: Vite 8 и сборка не заведутся.

## Что загрузить

Архив `europe-private-blacklist.zip` — исходники без `node_modules`.

## Команды на хостинге

```bash
unzip europe-private-blacklist.zip
cd europe-private-blacklist
cp .env.example .env
# отредактируйте .env — обязательно PUBLIC_URL = ваш https-домен
npm install
npm run build
npm start
```

Если панель спрашивает отдельно:

| Поле | Значение |
|---|---|
| Node | **22** |
| Команда сборки | `npm run build` |
| Команда запуска | `npm start` |
| Порт | как даёт хостинг (`PORT`) |

Нужен **HTTPS-домен**. Telegram Mini App и webhook без https не работают.

## Файл `.env`

```
TELEGRAM_BOT_TOKEN=8812183706:AAEHr2RTyW-pdMLDYF9E_91Fs3XJxnH_br4
TELEGRAM_ARBITER_CHAT_ID=-1003904954808
TELEGRAM_CHANNEL_ID=-1003958415589
PUBLIC_URL=https://ВАШ-ДОМЕН
PORT=3000
DATA_DIR=./data
```

`PUBLIC_URL` — полный адрес сайта, без `/` в конце.

## Telegram

1. Добавьте [@EuBlackList_bot](https://t.me/EuBlackList_bot) **админом** в чат арбитров и в канал.
2. После запуска сайта бот сам поставит webhook на `https://ВАШ-ДОМЕН/api/telegram/webhook`.
3. Напишите боту `/start` — должна прийти картинка и кнопка «Открыть приложение».

Если `/start` молчит: проверьте, что процесс `npm start` живой и `PUBLIC_URL` совпадает с доменом.

## Папка `data/`

Там хранятся заявки и кэш ID. Не удаляйте её при обновлениях — можно перезалить код поверх.
