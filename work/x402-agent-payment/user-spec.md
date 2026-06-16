---
feature: x402-agent-payment
status: draft
created: 2026-06-16
---

# x402 Payment Flow для AI-агентов

## Что делаем

Реализуем полный цикл оплаты по протоколу x402 для AI-агентов — от 402 ответа до верификации транзакции. Включает три компонента:

1. **`@universal-paywall/middleware`** — TypeScript npm-пакет с функцией `withPaywall()`. Оборачивает любой HTTP-хендлер: при запросе без оплаты возвращает 402 с требованиями платежа; при запросе с заголовком `X-Payment` верифицирует транзакцию в контракте и пропускает к ресурсу.

2. **`PaymentSplitter` смарт-контракт (Arc)** — один контракт для всех разработчиков. Принимает USDC-платежи, аккумулирует баланс разработчика за вычетом platform fee (настраивается owner'ом в basis points). Разработчик вызывает `withdraw()` когда хочет вывести средства.

3. **Скрипты деплоя** (Hardhat/Foundry) — деплой контракта на Arc Testnet и Arc Mainnet, форк Arc Testnet для локальной разработки.

**Chain:** Arc Network (Testnet для разработки → Mainnet для MVP). Дизайн chain-agnostic: сеть передаётся параметром, адрес контракта зашит в пакет по network id.

## Зачем

AI-агенты не могут платить за API через Stripe или браузер — им нужен программный, безостановочный путь оплаты. Без x402 разработчик либо открывает API бесплатно, либо выдаёт агенту API-ключ с ручным управлением балансом.

С Universal Paywall разработчик добавляет одну строку кода и получает монетизацию от любого x402-совместимого агента — без регистрации агента, без ручных шагов, без кастодиального сервиса.

## Пользователи

- **AI-агент (плательщик):** любой x402-совместимый клиент (GatewayClient, собственная реализация). Получает 402, читает требования, платит, ретраит.
- **Разработчик (получатель):** регистрирует кошелёк в контракте, оборачивает свой хендлер в `withPaywall()`, выводит накопленный USDC через `withdraw()`.

## Флоу

### Happy path (агент платит)

```
1. Агент → GET /api/data (без оплаты)
2. Middleware → HTTP 402
   PAYMENT-REQUIRED: base64({
     asset: "USDC",
     network: "arc-mainnet",
     amount: "10000",         // micro-USDC
     payTo: "0xSplitter...", // контракт
     developerId: "0xDev..."
   })
3. Агент → подписывает USDC-транзакцию → отправляет в PaymentSplitter
4. Контракт → проверяет сумму, developerId, nonce → зачисляет баланс
5. Агент → GET /api/data
   X-Payment: base64({ tx_sig: "0xABC...", network: "arc-mainnet" })
6. Middleware → верифицирует tx_sig через Arc RPC
7. Middleware → HTTP 200 + ресурс
   PAYMENT-RESPONSE: base64({ success: true, tx_sig, amount })
```

### Онбординг разработчика (one-time)

```
1. Вызвать register(walletAddress) на PaymentSplitter контракте
2. Получить USDC на Arc (Testnet faucet / Mainnet покупка)
3. Настроить middleware:
   withPaywall(handler, {
     price: '0.01',
     developerId: '0xDev...',
     network: 'arc-mainnet'  // опционально, дефолт
   })
```

## Критерии приёмки

### Middleware

- [ ] `withPaywall(handler, { price, developerId })` работает как framework-agnostic враппер (возвращает `(req, res) => Promise<void>`)
- [ ] Запрос без `X-Payment` хедера → HTTP 402 с корректным `PAYMENT-REQUIRED` заголовком (base64 JSON с asset, network, amount в micro-USDC, payTo, developerId)
- [ ] Запрос с валидным `X-Payment` → верификация tx через Arc RPC → HTTP 200
- [ ] Запрос с невалидным tx_sig → HTTP 402 `{ error: "payment_failed", reason: "tx_not_found" }`
- [ ] Сумма в tx меньше требуемой → HTTP 402 `{ error: "payment_failed", reason: "insufficient_amount", required, received }`
- [ ] Повторный tx_sig (replay) → HTTP 402 `{ error: "payment_failed", reason: "tx_already_used" }`
- [ ] Незарегистрированный developerId → HTTP 402 `{ error: "payment_failed", reason: "developer_not_registered" }`
- [ ] `network: 'arc-testnet'` и `network: 'arc-mainnet'` используют разные адреса контракта (зашиты в пакет)
- [ ] Пакет публикуется на npm как `@universal-paywall/middleware`

### PaymentSplitter контракт

- [ ] `register(wallet)` регистрирует разработчика; повторная регистрация того же адреса не ломает (idempotent)
- [ ] `pay(developerId, amount, txSig)` — принимает USDC, зачисляет `amount * (1 - fee/10000)` на баланс developer, `amount * fee/10000` на баланс платформы, записывает txSig в `usedTxSigs`
- [ ] Повторный вызов с тем же `txSig` → revert "tx_already_used"
- [ ] `pay()` с незарегистрированным `developerId` → revert "developer_not_registered"
- [ ] `withdraw(amount)` переводит USDC на кошелёк вызывающего (должен быть зарегистрированным разработчиком)
- [ ] `setFee(bps)` доступен только owner; максимум 1000 bps (10%)
- [ ] `getBalance(developer)` возвращает текущий баланс
- [ ] Контракт верифицирован на Arc block explorer после деплоя

### Деплой и тестирование

- [ ] `npm run test` запускает полный тест-сьют на локальном форке Arc Testnet
- [ ] Скрипт деплоя на Arc Testnet работает из коробки (`npx hardhat run deploy/PaymentSplitter.ts --network arcTestnet`)
- [ ] README с инструкцией: получить тестовый USDC → зарегистрироваться → запустить тест агента
- [ ] Интеграционный тест: реальный агент (GatewayClient) делает платёж на Arc Testnet → middleware пропускает запрос

## Что не входит

- Stripe / fiat платежи для людей
- Поддержка других сетей (Base, Solana, Ethereum) — архитектура готова, но деплой не входит в эту фичу
- Dashboard для просмотра транзакций
- Автоматическая отправка средств разработчику (только pull через `withdraw()`)
- Refunds
- Подписки / recurring платежи
