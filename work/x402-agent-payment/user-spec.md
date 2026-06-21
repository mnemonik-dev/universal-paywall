---
feature: x402-agent-payment
status: approved
size: L
created: 2026-06-16
updated: 2026-06-16
---

# x402 Payment Flow for AI Agents

## Что делаем

Реализуем полный цикл оплаты по протоколу **x402 v1** для AI-агентов на Arc Network Testnet. Архитектура: **factory + per-developer vault**. Включает три компонента:

1. **`@universal-paywall/middleware`** — TypeScript npm-пакет. Оборачивает HTTP-хендлер: при запросе без оплаты возвращает 402 с x402 JSON body (`payTo` = адрес vault разработчика, вычисляемый детерминированно от EOA); при запросе с заголовком `X-PAYMENT` верифицирует EIP-712 подпись off-chain, settles платёж on-chain вызовом `USDC.transferWithAuthorization` (middleware действует как **self-hosted x402 facilitator**, платит газ в USDC), пропускает к ресурсу. Два adapter'а: Node http (`withPaywall`) и Fastify (`fastifyPaywall`). Core (`paywall(req, opts)`) framework-agnostic.

2. **`PaymentSplitterFactory.sol` + `PaymentVaultImpl.sol` (Arc Testnet)** — фабрика и реализация vault'а через **EIP-1167 minimal proxy** (`Clones.cloneDeterministic`). Разработчик вызывает `factory.register()` со своего EOA → получает свой vault по детерминированному адресу. Vault — пассивный приёмник USDC. При `vault.withdraw()` (только developer) USDC делится: `(gross - fee)` → developer, `fee` → `factory.platformTreasury()`. Fee configurable owner'ом factory (default 50 bps, hard cap 1000 bps).

3. **Скрипты деплоя и dev tooling** — Hardhat-проект с деплоем factory на Arc Testnet, CLI-скрипт регистрации (`scripts/register.ts` зовёт `factory.register()` с EOA), Wave 1 spike для верификации `USDC.transferWithAuthorization` на Arc Testnet, README.

**Chain (MVP):** Arc Testnet (chainId 5042002, CAIP-2 `eip155:5042002`, USDC `0x3600000000000000000000000000000000000000`). Arc Mainnet — post-MVP, когда Circle его запустит. Дизайн chain-agnostic: сеть передаётся параметром, адреса контрактов зашиты в пакет по network id.

## Зачем

AI-агенты не могут платить за API через Stripe или браузер — им нужен программный, безостановочный путь оплаты. Без x402 разработчик либо открывает API бесплатно, либо выдаёт агенту API-ключ с ручным управлением балансом.

С Universal Paywall разработчик добавляет одну строку кода и получает монетизацию от любого x402 v1-совместимого агента — без регистрации агента, без ручных шагов, без кастодиального сервиса. Per-developer vault гарантирует, что подписанный платёж криптографически привязан к получателю (нельзя «перенаправить» подпись на чужой счёт).

## Пользователи

- **AI-агент (плательщик):** любой x402 v1-совместимый клиент (CDP `x402` SDK, Circle SDK, кастомная имплементация). Получает 402, подписывает EIP-3009 authorization off-chain (`to` = vault address разработчика), ретраит. **Газа агент не платит.**
- **Разработчик (получатель):** регистрирует свой EOA через `factory.register()` (получает vault по детерминированному адресу), оборачивает свой хендлер в `withPaywall()` или `fastifyPaywall()`, выводит накопленный USDC через `vault.withdraw()`. Запускает middleware с relayer-ключом для оплаты газа на Arc.

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
       "network": "eip155:5042002",  // CAIP-2; alias "arc-testnet" тоже принимается
       "maxAmountRequired": "10000",  // micro-USDC (0.01 USDC at 6 decimals)
       "resource": "https://api.example.com/api/data",
       "description": "Premium data endpoint",
       "mimeType": "application/json",
       "payTo": "0xDevVault...",       // factory.computeVaultAddress(developerEOA)
       "maxTimeoutSeconds": 60,
       "asset": "0x3600000000000000000000000000000000000000",
       "extra": {
         "assetTransferMethod": "eip3009",
         "name": "USD Coin",   // verified from USDC.name() at deploy time
         "version": "2"
       }
     }]
   }

3. Агент → подписывает EIP-712 typed-data off-chain (no gas):
     domain  = { name: "USD Coin", version: "2",
                 chainId: 5042002,
                 verifyingContract: 0x3600...0000 }
     types   = TransferWithAuthorization
     message = {
       from: agentAddress,
       to: 0xDevVault...,   // дет. адрес vault'а разработчика
       value: "10000",
       validAfter: 0,
       validBefore: now+60,
       nonce: random32bytes
     }

4. Агент → GET /api/data
   X-PAYMENT: base64(JSON({
     "x402Version": 1,
     "scheme": "exact",
     "network": "eip155:5042002",
     "payload": {              // строго {signature, authorization} — никаких extra полей
       "signature": "0x...",
       "authorization": { from, to, value, validAfter, validBefore, nonce }
     }
   }))

5. Middleware (facilitator):
   a. Декодирует X-PAYMENT (size <= 4 KB, иначе HTTP 400 header_too_large)
   b. EIP-712 ecrecover → recovered == authorization.from
   c. Проверяет: to == computeVaultAddress(developerEOA), value >= maxAmountRequired,
                 validBefore > now + 5s, validAfter <= now
   d. NonceStore: синхронно has({from, nonce}) -> false → insert
   e. Проверяет factory.paused() == false (off-chain read)
   f. Вызывает USDC.transferWithAuthorization(
        from, to=vault, value, validAfter, validBefore, nonce, v, r, s
      ) с relayer-кошелька. waitForTransactionReceipt({timeout: 30s})
   g. USDC внутри проверяет EIP-3009 (nonce не использован on-chain) → переводит USDC: agent → vault

6. Middleware → HTTP 200 + ресурс
   X-PAYMENT-RESPONSE: base64(JSON({
     "success": true,
     "transaction": "0x...",
     "network": "eip155:5042002",
     "payer": agentAddress
   }))
```

### Онбординг разработчика (one-time)

```
1. Получить USDC на Arc Testnet (Circle faucet → faucet.circle.com, выбрать Arc Testnet).
2. Зарегистрироваться:
     npx universal-paywall register --network arc-testnet
   (Скрипт подписывает tx с локального ключа REGISTER_KEY → factory.register().
    Vault деплоится по детерминированному адресу, msg.sender становится immutable developer.)
3. Запустить middleware с relayer-ключом:
     PAYWALL_RELAYER_KEY=0x... node server.js
4. Настроить middleware (Node http):
     withPaywall(handler, {
       price: '0.01',                       // USD-denominated string, → 10000n micro-USDC
       developerEoa: '0xDev...',            // EOA, чей vault будет получать платежи
       network: 'arc-testnet',              // или CAIP-2 'eip155:5042002'
       facilitator: { mode: 'inline', relayerKey: env('PAYWALL_RELAYER_KEY') }
     })
   Или Fastify:
     server.register(fastifyPaywall({ price, developerEoa, network, facilitator }))
```

### Вывод средств

```
Developer EOA → vault.withdraw()  (msg.sender-gated, nonReentrant)
  Vault internally:
    gross = USDC.balanceOf(vault)
    require gross > 0
    fee = gross * factory.feeBps() / 10000
    net = gross - fee
    USDC.transfer(developer, net)
    if fee > 0: USDC.transfer(factory.platformTreasury(), fee)
    emit Withdrawal(developer, gross, fee)
```

## Критерии приёмки

### Middleware

- [ ] `withPaywall(handler, config)` экспортируется и работает как Node http-обёртка (`(req, res) => Promise<void>`).
- [ ] `fastifyPaywall(opts)` экспортируется как Fastify-плагин.
- [ ] Запрос без `X-PAYMENT` хедера → HTTP 402 с **JSON body** соответствующим x402 v1 спецификации (`x402Version: 1`, `accepts[]` с `scheme: "exact"`, `network`, `maxAmountRequired`, `payTo` = computed vault address, `asset`, `resource`, `description`, `mimeType`, `maxTimeoutSeconds`, `extra: { assetTransferMethod: "eip3009", name, version }`). Body шейп валидируется ajv против vendored x402 v1 JSON Schema в тестах.
- [ ] Запрос с валидным `X-PAYMENT` (base64 JSON со строго `payload: { signature, authorization }` — без extra полей) → middleware:
  - EIP-712 ecrecover, recovered == `authorization.from`.
  - `authorization.to == factory.computeVaultAddress(developerEoa)` для данной сети.
  - `authorization.value >= maxAmountRequired`.
  - `validBefore > now + 5s` и `validAfter <= now`.
  - NonceStore: синхронный has + insert (`(from, nonce)` пара); TTL eviction по `validBefore`; cap 100k entries.
  - `X-PAYMENT.network == config.network` (CAIP-2 и alias сравниваются после нормализации).
  - `factory.paused() == false` (off-chain read; если paused → 402 `"error": "paused"`).
  - Vault EOA задеплоен (`factory.vaults[developerEoa] != 0`); если нет → 402 `"error": "vault_not_deployed"` + инструкция запустить `register`.
  - Settles: `USDC.transferWithAuthorization(from, to=vault, value, validAfter, validBefore, nonce, v, r, s)` с relayer-кошелька.
  - `waitForTransactionReceipt({hash, timeout: 30_000})` с `status: success`.
  - HTTP 200 с `X-PAYMENT-RESPONSE: base64(JSON({success, transaction, network, payer}))`.
- [ ] Невалидная подпись (любой tampering: `chainId`, `verifyingContract`, `name`, `version`, message fields) → HTTP 402 `"error": "invalid_signature"`.
- [ ] `value < maxAmountRequired` → 402 `"error": "insufficient_amount"` + `required`, `received`.
- [ ] `validBefore <= now + 5s` → 402 `"error": "authorization_expired"`.
- [ ] `validAfter > now` → 402 `"error": "authorization_not_yet_valid"`.
- [ ] Повторный `(from, nonce)` в middleware-store → 402 `"error": "nonce_already_used"`.
- [ ] On-chain settle failure (USDC nonce already used, vault revert, RPC issue) → 402 `"error": "settlement_failed"` + конкретный `reason` (один из `rpc_timeout`, `rpc_5xx`, `gas_estimate_revert`, `mine_timeout`, `receipt_reverted`, `relayer_no_balance`, `authorization_already_used_onchain`).
- [ ] `X-PAYMENT.network != config.network` → 402 `"error": "network_mismatch"`.
- [ ] X-PAYMENT header > 4 KB → HTTP **400** `"error": "header_too_large"`.
- [ ] Malformed base64/JSON в X-PAYMENT → HTTP **400** `"error": "malformed_payment_header"` (protocol violation, не payment-required).
- [ ] Middleware экспортирует `NETWORKS` map с key'ями `'arc-testnet'` (alias) и `'eip155:5042002'` (CAIP-2 canonical), оба указывают на один `NetworkConfig`: chainId 5042002, RPC `https://rpc.testnet.arc.network`, USDC `0x3600000000000000000000000000000000000000`, factoryAddress (заполняется после деплоя), vaultImplAddress.
- [ ] Middleware при старте делает `client.getChainId()` и сравнивает с `NETWORKS[id].chainId`; mismatch → throw `NetworkMismatchError`.
- [ ] Relayer key: тип-обёртка делает поле non-enumerable; не появляется в `JSON.stringify(config)`; не логируется при ошибках; стек ошибок проходит redaction.
- [ ] Пакет публикуется на npm как `@universal-paywall/middleware` (initial version `0.1.0-alpha.0`), ESM-only (`"type": "module"`, exports map без CJS).
- [ ] Price-to-amount conversion: `'0.01'` → `10000n` через integer-математику (`parseUnits`-style); negative, zero, scientific (`"1e2"`), whitespace, `>6 decimals` отвергаются с `InvalidPriceError`.

### Contracts: PaymentSplitterFactory

- [ ] Constructor: `(IERC20 _usdc, address _platformTreasury, uint16 _initialFeeBps)`. Revert if `_usdc == 0`, `_platformTreasury == 0`, `_initialFeeBps > 1000`.
- [ ] Inherits `Ownable2Step` (OZ 5.x) — двух-шаговая передача ownership.
- [ ] Inherits `Pausable`.
- [ ] В конструкторе деплоит `vaultImpl = new PaymentVaultImpl()`.
- [ ] `register()`:
  - `whenNotPaused`
  - `require vaults[msg.sender] == address(0)` (already registered)
  - Использует `Clones.cloneDeterministic(vaultImpl, bytes32(uint256(uint160(msg.sender))))`
  - Вызывает `IPaymentVault(vault).initialize(msg.sender)`
  - Сохраняет `vaults[msg.sender] = vault`
  - Emits `VaultDeployed(developer, vault)`
- [ ] `computeVaultAddress(address developer) view returns (address)` — детерминированный адрес, согласованный с `Clones.predictDeterministicAddress`.
- [ ] `setFeeBps(uint16 _bps)`: owner-only, revert `_bps > 1000`, emits `FeeBpsUpdated(oldBps, newBps)`.
- [ ] `setPlatformTreasury(address _to)`: owner-only, revert `_to == 0`, emits `PlatformTreasuryUpdated(oldTo, newTo)`.
- [ ] `pause()` / `unpause()`: owner-only.
- [ ] View getters: `usdc()`, `feeBps()`, `platformTreasury()`, `vaultImpl()`, `vaults(address)`.
- [ ] Контракт верифицирован на `https://testnet.arcscan.app` после деплоя.

### Contracts: PaymentVaultImpl

- [ ] Inherits `Initializable` (OZ 5.x) + `ReentrancyGuard` (storage-based, not transient; Arc support for transient storage unverified).
- [ ] `initialize(address _developer)`: `initializer` modifier; `require _developer != 0`; sets `developer = _developer`, `factory = msg.sender` (factory storage assigned at clone time).
- [ ] `withdraw()`: `nonReentrant`, `msg.sender == developer`, reads `gross = IERC20(factory.usdc()).balanceOf(address(this))`, `require gross > 0` (revert `"no_balance"`), `fee = gross * factory.feeBps() / 10000`, `net = gross - fee`, `SafeERC20.safeTransfer(usdc, developer, net)`, if `fee > 0` then `SafeERC20.safeTransfer(usdc, factory.platformTreasury(), fee)`, emits `Withdrawal(developer, gross, fee)`.
- [ ] Withdraw работает **независимо** от `factory.paused()` (developers не блокируются от своих средств).
- [ ] Нет setter'ов для `developer` или `factory` — оба immutable post-initialize.
- [ ] Vault не имеет `receive()` payable (native не должен случайно приходить).

### Деплой и тестирование

- [ ] `npm test --workspace=@universal-paywall/middleware` — vitest unit tests (≥85% line coverage).
- [ ] `cd contracts && npx hardhat test` — Hardhat tests с mock USDC (EIP-3009 implementation), ≥95% branch coverage для обоих контрактов.
- [ ] **Hardhat-fork integration test** в `contracts/test/integration/forked-e2e.test.ts` — runs in CI **без** env флага: разворачивает локальную сеть с mock USDC, деплоит factory + vault, запускает middleware in-process, делает реальный end-to-end платёжный цикл. Покрывает оба адаптера (Node http + Fastify).
- [ ] **Live Arc Testnet integration test** в `packages/middleware/src/__tests__/integration/arc-testnet-e2e.test.ts` — gated `ARC_TESTNET_E2E=1` (nightly job, не блокирует PR).
- [ ] Скрипт деплоя `cd contracts && npx hardhat run deploy/01_deploy_factory.ts --network arcTestnet` работает из коробки, выводит factory address и `vaultImpl` address.
- [ ] README с инструкцией: получить тестовый USDC → запустить `npx universal-paywall register` → запустить middleware → проверить агентом (hand-crafted EIP-3009 signer).

## Что не входит

- Stripe / fiat платежи для людей
- Arc Mainnet (не запущен Circle на момент 2026-06)
- Поддержка других сетей (Base, Solana, Ethereum) — архитектура chain-agnostic, но деплой не входит в эту фичу
- Dashboard для просмотра транзакций
- Автоматическая отправка средств разработчику (только pull через `vault.withdraw()`)
- Refunds
- Подписки / recurring платежи
- Wallet rotation / `unregister` / `vault.rotateDeveloper(newDev)` — если зарегистрированный EOA скомпрометирован, накопленный баланс в vault'е под угрозой (defer to post-MVP)
- Multi-tenant facilitator-as-a-service (нашa middleware — facilitator только для собственного API, не предлагаем сторонним)
- Multi-instance NonceStore (Redis-backed) — defer to post-MVP, MVP single-process
- x402 schemes кроме `"exact"`, multi-token (только USDC)
- Built-in client SDK (агенты используют CDP x402 / Circle / свои)
- Settle rate-limiting / back-pressure — defer post-MVP
- Auto-refill relayer wallet USDC — defer (operational monitoring)
