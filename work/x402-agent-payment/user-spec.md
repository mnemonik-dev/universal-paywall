---
feature: x402-agent-payment
status: draft
size: L
created: 2026-06-16
updated: 2026-06-16
---

# x402 Payment Flow for AI Agents

## Что делаем

Реализуем полный цикл оплаты по протоколу **x402 v1** для AI-агентов на Arc Network Testnet. Включает три компонента:

1. **`@universal-paywall/middleware`** — TypeScript npm-пакет. Оборачивает HTTP-хендлер: при запросе без оплаты возвращает 402 с x402 JSON body; при запросе с заголовком `X-PAYMENT` верифицирует подпись off-chain, settles платёж on-chain (middleware ведёт себя как **self-hosted x402 facilitator**), пропускает к ресурсу.

2. **`PaymentSplitter` смарт-контракт (Arc Testnet)** — один контракт для всех разработчиков. Принимает USDC-платежи через `payWithAuthorization(...)` (внутри вызывает `USDC.transferWithAuthorization`), аккумулирует баланс разработчика за вычетом platform fee (configurable owner'ом, default 50 bps, hard cap 1000 bps). Разработчик вызывает `withdraw()` когда хочет вывести средства.

3. **Скрипты деплоя и dev tooling** — Hardhat-проект с деплоем на Arc Testnet, CLI-скрипт регистрации разработчика, локальный форк Arc Testnet для разработки.

**Chain (MVP):** Arc Testnet (chainId 5042002, USDC `0x3600000000000000000000000000000000000000`). Arc Mainnet — post-MVP, когда Circle его запустит. Дизайн chain-agnostic: сеть передаётся параметром, адрес контракта зашит в пакет по network id.

## Зачем

AI-агенты не могут платить за API через Stripe или браузер — им нужен программный, безостановочный путь оплаты. Без x402 разработчик либо открывает API бесплатно, либо выдаёт агенту API-ключ с ручным управлением балансом.

С Universal Paywall разработчик добавляет одну строку кода и получает монетизацию от любого x402 v1-совместимого агента — без регистрации агента, без ручных шагов, без кастодиального сервиса.

## Пользователи

- **AI-агент (плательщик):** любой x402 v1-совместимый клиент (CDP `x402` SDK, Circle SDK, кастомная имплементация). Получает 402, читает требования, подписывает EIP-3009 authorization off-chain, ретраит. **Газа агент не платит** — facilitator (наш middleware) платит газ.
- **Разработчик (получатель):** регистрирует кошелёк через CLI (`scripts/register.ts`), оборачивает свой хендлер в `withPaywall()` или `fastifyPaywall()`, выводит накопленный USDC через `withdraw()`. Запускает middleware с relayer-ключом для оплаты газа на Arc.

## Флоу

### Happy path (агент платит)

```
1. Агент → GET /api/data (без оплаты)

2. Middleware → HTTP 402
   Content-Type: application/json
   Body: {
     "x402Version": 1,
     "accepts": [{
       "scheme": "exact",
       "network": "arc-testnet",
       "maxAmountRequired": "10000",   // micro-USDC (10000 = 0.01 USDC)
       "resource": "https://api.example.com/api/data",
       "description": "Premium data endpoint",
       "mimeType": "application/json",
       "payTo": "0xSplitter...",
       "maxTimeoutSeconds": 60,
       "asset": "0x3600000000000000000000000000000000000000",
       "extra": {
         "assetTransferMethod": "eip3009",
         "name": "USDC",
         "version": "2"
       }
     }]
   }

3. Агент → подписывает EIP-712 typed-data (EIP-3009 authorization) off-chain:
     domain:  { name: "USDC", version: "2", chainId: 5042002, verifyingContract: USDC }
     types:   TransferWithAuthorization
     message: {
       from: agentAddress,
       to: splitterAddress,
       value: "10000",
       validAfter: 0,
       validBefore: now+60,
       nonce: random32bytes
     }

4. Агент → GET /api/data
   X-PAYMENT: base64(JSON({
     "x402Version": 1,
     "scheme": "exact",
     "network": "arc-testnet",
     "payload": {
       "signature": "0x...",
       "authorization": { from, to, value, validAfter, validBefore, nonce },
       "developerId": "0xDev..."   // x402 "extra" / app-level field
     }
   }))

5. Middleware (facilitator):
   a. Декодирует X-PAYMENT, проверяет схему
   b. EIP-712 ecrecover → from матчится с authorization.from
   c. Проверяет: to == splitterAddress, value >= maxAmountRequired, validBefore > now, nonce не использован ранее
   d. Вызывает на Arc Testnet:
        splitter.payWithAuthorization(
          developerId, value, validAfter, validBefore, nonce, v, r, s
        )
      Релэйер middleware платит газ.
   e. Контракт внутри:
        USDC.transferWithAuthorization(from=agent, to=splitter, value, ...) → USDC arrives at splitter
        developers[developerId].balance += value - platformFee
        platformBalance += platformFee
        emit PaymentReceived(developerId, from, value, platformFee, txHash)
   f. Middleware ждёт receipt → success

6. Middleware → HTTP 200 + ресурс
   X-PAYMENT-RESPONSE: base64(JSON({
     "success": true,
     "transaction": "0x...",
     "network": "arc-testnet",
     "payer": agentAddress
   }))
```

### Онбординг разработчика (one-time)

```
1. Получить USDC на Arc Testnet (Circle faucet → faucet.circle.com, выбрать Arc Testnet).
2. Зарегистрироваться:
     npx universal-paywall register --wallet 0xDev... --network arc-testnet
   (Скрипт вызывает splitter.register(wallet) на контракте.)
3. Запустить middleware с relayer-ключом:
     PAYWALL_RELAYER_KEY=0x... node server.js
4. Настроить middleware (Node http):
     withPaywall(handler, {
       price: '0.01',                       // USD-denominated string, → 10000 micro-USDC
       developerId: '0xDev...',             // зарегистрированный адрес
       network: 'arc-testnet',              // optional, default
       facilitator: { mode: 'inline', relayerKey: env('PAYWALL_RELAYER_KEY') }
     })
   Или Fastify:
     server.register(fastifyPaywall({ price, developerId, network, facilitator }))
```

## Критерии приёмки

### Middleware

- [ ] `withPaywall(handler, config)` экспортируется и работает как Node http-обёртка (`(req, res) => Promise<void>`).
- [ ] `fastifyPaywall(opts)` экспортируется как Fastify-плагин.
- [ ] Запрос без `X-PAYMENT` хедера → HTTP 402 с **JSON body** соответствующим x402 v1 спецификации (`x402Version: 1`, `accepts[]` с `scheme: "exact"`, `network`, `maxAmountRequired`, `payTo`, `asset`, `extra: { assetTransferMethod: "eip3009", name, version }`, `resource`, `description`, `mimeType`, `maxTimeoutSeconds`).
- [ ] Запрос с валидным `X-PAYMENT` (base64 JSON с `x402Version`, `scheme: "exact"`, `network`, `payload: { signature, authorization, developerId }`) → middleware:
  - Проверяет EIP-712 подпись (recovered address == `authorization.from`).
  - Проверяет `authorization.to == splitterAddress` для данной сети.
  - Проверяет `authorization.value >= maxAmountRequired`.
  - Проверяет `validBefore > now` и `validAfter <= now`.
  - Проверяет, что `(authorization.from, authorization.nonce)` не использовался ранее в middleware-store (TTL eviction по `validBefore`).
  - Проверяет, что `X-PAYMENT.network == config.network` (cross-network защита).
  - Settles on-chain: вызывает `splitter.payWithAuthorization(developerId, value, validAfter, validBefore, nonce, v, r, s)` с relayer-кошелька.
  - Ждёт `getTransactionReceipt` с `status: success`.
  - Возвращает HTTP 200 с `X-PAYMENT-RESPONSE: base64(JSON({success, transaction, network, payer}))`.
- [ ] Невалидная подпись → HTTP 402 JSON body: `{ "x402Version": 1, "accepts": [...], "error": "invalid_signature" }`.
- [ ] `value < maxAmountRequired` → 402 с `"error": "insufficient_amount"` + поля `required`, `received`.
- [ ] `validBefore <= now` → 402 с `"error": "authorization_expired"`.
- [ ] Повторный `(from, nonce)` в middleware-store → 402 с `"error": "nonce_already_used"`.
- [ ] On-chain `payWithAuthorization` revert (например, USDC nonce уже использован on-chain или developer не зарегистрирован) → 402 с `"error": "settlement_failed"` + `reason` из revert reason.
- [ ] `X-PAYMENT.network != config.network` → 402 с `"error": "network_mismatch"`.
- [ ] Middleware экспортирует `NETWORKS` map с key `arc-testnet` и реальными значениями: chainId 5042002, RPC `https://rpc.testnet.arc.network`, USDC `0x3600000000000000000000000000000000000000`, splitterAddress (заполняется после деплоя).
- [ ] Пакет публикуется на npm как `@universal-paywall/middleware` (initial version `0.1.0-alpha.0`).
- [ ] Price-to-amount conversion: строка `'0.01'` (USD-denominated, USDC привязан 1:1 к USD) → `10000n` (BigInt, micro-USDC, 6 decimals) через integer-математику (`parseUnits`-style), без `parseFloat`.

### PaymentSplitter контракт

- [ ] `register(wallet)` сохраняет `developers[wallet].registered = true`. Регистрация открытая (анyone может вызвать `register(anyAddress)`) — registration это opt-in, не authentication. Повторный вызов того же адреса не ломает (idempotent).
- [ ] `payWithAuthorization(developerId, value, validAfter, validBefore, nonce, v, r, s)` принимает USDC через внутренний вызов `USDC.transferWithAuthorization(...)`, зачисляет `value * (10000 - feeBps) / 10000` на баланс developer, `value * feeBps / 10000` на `platformBalance`, эмитит `PaymentReceived(developerId, from, value, fee, block.timestamp)`.
- [ ] `payWithAuthorization` с незарегистрированным `developerId` → revert `"developer_not_registered"`.
- [ ] `payWithAuthorization` дважды с тем же `(from, nonce)` → revert от USDC (`"FiatTokenV2: authorization is used or canceled"` или аналог). Защита на уровне USDC.
- [ ] `withdraw(amount)` переводит USDC на `msg.sender` (должен быть зарегистрированным разработчиком и иметь `balance >= amount`). Соответствует CEI-паттерну, защищён `nonReentrant`.
- [ ] `withdrawAll()` эквивалент `withdraw(balanceOf(msg.sender))`.
- [ ] `setFee(bps)` доступен только owner; revert если `bps > 1000`; эмитит `PlatformFeeUpdated(oldBps, newBps)`.
- [ ] `withdrawPlatformFees(to)` доступен только owner; переводит `platformBalance` на указанный адрес; эмитит `PlatformFeesWithdrawn(to, amount)`. Не путать с owner-адресом (`to` параметр позволяет указать treasury-кошелёк).
- [ ] `pause()` / `unpause()` доступны только owner. Когда paused: `payWithAuthorization` revert; `register`, `withdraw`, `withdrawAll`, `withdrawPlatformFees` работают (юзеры не заблокированы от собственных средств).
- [ ] `getBalance(developer)` view-функция возвращает текущий баланс developer.
- [ ] Контракт верифицирован на `https://testnet.arcscan.app` после деплоя.
- [ ] Конструктор принимает `usdcAddress`, `initialOwner`, `initialFeeBps`. USDC адрес immutable per deployment.

### Деплой и тестирование

- [ ] `npm run test --workspace=packages/middleware` — vitest unit tests middleware (x402 кодек, verify, errors, replay-store).
- [ ] `cd contracts && npx hardhat test` — Hardhat tests на локальном форке Arc Testnet (100% branch coverage на PaymentSplitter.sol).
- [ ] Скрипт деплоя `cd contracts && npx hardhat run deploy/01_deploy_splitter.ts --network arcTestnet` работает из коробки, выводит deployed address.
- [ ] README с инструкцией: получить тестовый USDC → зарегистрироваться через `scripts/register.ts` → запустить тест агента.
- [ ] Интеграционный тест: тестовый агент (handcrafted EIP-3009 signer, не GatewayClient) делает платёж на Arc Testnet → middleware пропускает запрос → developer balance в контракте увеличился ровно на `value - fee`.

## Что не входит

- Stripe / fiat платежи для людей
- Arc Mainnet (не запущен Circle на момент 2026-06)
- Поддержка других сетей (Base, Solana, Ethereum) — архитектура chain-agnostic, но деплой не входит в эту фичу
- Dashboard для просмотра транзакций
- Автоматическая отправка средств разработчику (только pull через `withdraw()`)
- Refunds
- Подписки / recurring платежи
- Wallet rotation / `unregister()` — если зарегистрированный wallet скомпрометирован, накопленный баланс потерян (defer to post-MVP)
- Multi-tenant facilitator-as-a-service (нашa middleware — facilitator только для собственного API, не предлагаем сторонним)
- x402 schemes кроме `"exact"` (subscription, batched и др.)
- Multi-token (только USDC в MVP)
- Built-in client SDK (агенты используют CDP x402 / Circle / свои)
