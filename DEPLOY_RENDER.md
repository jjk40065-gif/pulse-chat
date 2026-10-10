# Публикация Pulse на Render

После публикации Pulse будет работать по обычной постоянной HTTPS-ссылке. Открывать `index.html` или запускать Live Preview больше не потребуется.

## 1. Загрузите проект на GitHub

1. Создайте новый пустой репозиторий на https://github.com/new.
2. Распакуйте архив `Pulse-Render.zip`.
3. Загрузите **содержимое папки `pulse-chat`** в репозиторий.
4. Убедитесь, что в корне репозитория находятся `render.yaml`, `Dockerfile`, `package.json` и `server.js`.

Не загружайте папки `node_modules`, `data` и файл `.env`.

## 2. Создайте Blueprint в Render

1. Откройте https://dashboard.render.com/.
2. Нажмите **New → Blueprint**.
3. Подключите созданный GitHub-репозиторий.
4. Render автоматически прочитает `render.yaml`.
5. Подтвердите создание сервиса `pulse-chat`.

Конфигурация уже включает Docker, проверку `/api/health`, постоянный диск на 1 ГБ и автоматическую генерацию `JWT_SECRET`.

## 3. Необязательные настройки

### Настоящие письма с кодом

В Environment заполните:

- `SMTP_HOST`
- `SMTP_PORT` — обычно `587`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`

Если SMTP не заполнен, проверочный код безопасно показывается прямо в окне регистрации, поэтому создать аккаунт всё равно можно.

### Надёжный голосовой чат

Обычный WebRTC использует два STUN-сервера и часто работает без настройки. Для пользователей за строгим NAT добавьте TURN:

- `TURN_URL`
- `TURN_USERNAME`
- `TURN_CREDENTIAL`

Можно использовать Metered.ca, Twilio Network Traversal или собственный coturn.

### Вход в Pulse через Google

1. Откройте https://console.cloud.google.com/ и создайте проект `Pulse`.
2. Перейдите **APIs & Services → OAuth consent screen** и настройте экран согласия.
3. В **Credentials** нажмите **Create credentials → OAuth client ID**.
4. Выберите тип **Web application**.
5. В `Authorized JavaScript origins` добавьте адрес Render:

   `https://pulse-chat-xxxx.onrender.com`

6. В `Authorized redirect URIs` добавьте точно:

   `https://pulse-chat-xxxx.onrender.com/api/auth/google/callback`

7. Скопируйте Client ID и Client Secret.
8. В Render → Environment добавьте:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `PUBLIC_URL` — адрес Render без завершающего `/`
9. Сохраните настройки и перезапустите сервис. На форме появится кнопка **«Продолжить через Google»**.

Если приложение Google находится в режиме Testing, добавьте свою почту в раздел **Test users**.

### Вход в Pulse через GitHub

1. Откройте https://github.com/settings/developers.
2. Выберите **OAuth Apps → New OAuth App**.
3. В `Homepage URL` укажите адрес Render, например `https://pulse-chat-xxxx.onrender.com`.
4. В `Authorization callback URL` укажите точно:

   `https://pulse-chat-xxxx.onrender.com/api/auth/github/callback`

5. Создайте приложение и скопируйте `Client ID`.
6. Нажмите **Generate a new client secret** и сразу скопируйте секрет.
7. В Render → Environment добавьте:
   - `GITHUB_CLIENT_ID`
   - `GITHUB_CLIENT_SECRET`
   - `PUBLIC_URL` — адрес Render без завершающего `/`
8. Перезапустите сервис. На форме появится кнопка **«Продолжить через GitHub»**.

Важно: callback URL в GitHub должен полностью совпадать с адресом Render, включая `https://` и путь `/api/auth/github/callback`.

## 4. Откройте приложение

После статуса **Live** Render выдаст адрес вида:

`https://pulse-chat-xxxx.onrender.com`

Это и будет постоянная ссылка Pulse. Регистрация, сообщения, вложения, база данных, голосовые комнаты и WebSocket работают через этот адрес.

## 5. Обновления

После изменений отправьте новые файлы в GitHub. Render автоматически пересоберёт приложение без смены адреса.

## Проверка после публикации

1. Откройте `/api/health` — должен появиться JSON с `ok: true`.
2. Зарегистрируйте аккаунт.
3. Откройте сайт в приватном окне и создайте второй аккаунт.
4. Проверьте сообщения и голосовой канал «Лаунж».
5. Разрешите браузеру использовать микрофон.
