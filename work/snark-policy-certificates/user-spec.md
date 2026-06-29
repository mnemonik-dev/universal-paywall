---
feature: snark-policy-certificates
status: approved
created: 2026-06-29
---

# SNARK Policy Certificates для AI-агентов

## Что делаем

Реализуем end-to-end pipeline: декларативная политика → SNARK-доказательство → верифицируемый сертификат. Агент прикладывает к своему действию криптографическое доказательство того, что оно соответствует объявленной политике — без повторного выполнения и без доверия оператору.

**Scope Phase 1 (этот спек):** новый пакет `packages/policy-certs/` + опциональный хук в `withPaywall()`.

**Конкретная политика (Phase 1):**
```
spend ≤ budget_B  ∧  recipient ∈ allowlist  ∧  tool_args satisfy schema_S
```

**Стек:** circom 2.x + snarkjs (Groth16). Никакой новой инфраструктуры — только npm.

**Три компонента:**

1. **`circuits/payment_policy_v1.circom`** — арифметическая схема, кодирующая политику через полиномиальные ограничения (по методу из arxiv:2606.23768):
   - `spend ≤ B` → range check гаджет
   - `recipient ∈ allowlist` → Merkle inclusion proof
   - `schema check` → field equality constraints

2. **`packages/policy-certs/`** — TypeScript npm-пакет:
   - `generateCertificate(action, witness) → Certificate` — prover
   - `verifyCertificate(action, cert, vk) → boolean` — verifier
   - Verifying key (`vk`) поставляется статическим ассетом в пакете

3. **Хук в middleware** — опциональное расширение `withPaywall({ policyProof: true })`: middleware дополнительно требует заголовок `X-Policy-Proof` и верифицирует сертификат наряду с x402 платежом.

## Зачем

AI-агенты в trustless-экономике должны доказывать соответствие политике без того, чтобы верификатор повторно выполнял вычисление или доверял оператору. SNARK-сертификат проверяется за сублинейное время — независимо от стоимости исходного вычисления.

Прямое применение в Universal Paywall: разработчик получает **портативное, машинопроверяемое доказательство** того, что агент действительно соблюдал политику платежа — а не просто прошёл проверку транзакции.

## Пользователи

- **AI-агент (prover):** генерирует `Certificate` перед запросом; прикладывает к `X-Policy-Proof` заголовку
- **Разработчик (verifier):** вызывает `verifyCertificate()` или включает `policyProof: true` в `withPaywall()`
- **Universal Paywall middleware:** опциональная верификация сертификата поверх x402

## Флоу

### Happy path (агент с сертификатом)

```
1. Агент → формирует witness:
   { spend: 10000, recipient: "0xABC...", args: { model: "gpt-4" } }

2. Агент → generateCertificate(action, witness)
   → Circuit: проверяет spend ≤ budget, recipient в Merkle дереве, args валидны
   → Certificate {
       policyId: "payment_policy_v1",
       actionHash: blake3(action_manifest),  // привязка к конкретному действию
       pubInputs: { merkleRoot, schemaHash, maxSpend },
       vk: "...",
       proof: "0x..."
     }

3. Агент → POST /api/resource
   X-Payment: base64(x402_payment)
   X-Policy-Proof: base64(certificate)

4. Middleware → verifyCertificate(action, cert, vk) → true
   Middleware → верифицирует x402 транзакцию
   → HTTP 200 + ресурс

5. Агент → нарушает политику (spend > budget)
   → generateCertificate() не может найти валидный witness
   → Certificate не создаётся → запрос не отправляется
```

### Верификация без повторного выполнения

```
verifier:
  1. Проверяет actionHash == blake3(action) — proof привязан к этому действию
  2. Проверяет proof по vk и pubInputs — sublinear time, ~constant
  3. Не знает witness (spend, recipient, args) — только то, что они удовлетворяют схеме
```

### Middleware хук

```typescript
withPaywall(handler, {
  price: '0.01',
  developerId: '0xDev...',
  policyProof: true  // включает требование X-Policy-Proof заголовка
})
```

## Типы и API

```typescript
// packages/policy-certs/src/types.ts
interface Certificate {
  policyId: string;
  actionHash: string;       // blake3(action_manifest)
  pubInputs: {
    merkleRoot: string;     // root allowlist дерева
    schemaHash: string;     // hash объявленной схемы
    maxSpend: number;       // верхняя граница spend
  };
  proof: string;            // Groth16 proof (base64)
}

interface PaymentPolicy {
  maxSpend: number;
  allowlist: string[];      // hex адреса
  schemaFields: string[];   // обязательные поля args
}

// prover
function generateCertificate(
  action: AgentAction,
  witness: PolicyWitness,
  policy: PaymentPolicy
): Promise<Certificate>

// verifier
function verifyCertificate(
  action: AgentAction,
  cert: Certificate,
  vk?: object             // опционально; по умолчанию — bundled vk
): Promise<boolean>
```

## Критерии приёмки

### Circuit & proving

- [ ] `circuits/payment_policy_v1.circom` компилируется без ошибок (`circom --r1cs --wasm`)
- [ ] Trusted setup завершён: `ptau` файл + `zkey` файл сгенерированы и закоммичены в репо
- [ ] `generateCertificate()` возвращает валидный `Certificate` для корректного witness (spend ≤ budget, recipient в allowlist, args содержат schemaFields)
- [ ] `generateCertificate()` бросает исключение для некорректного witness (невозможно построить witness → нет доказательства)

### Верификатор

- [ ] `verifyCertificate(action, cert)` возвращает `true` для всех корректных сертификатов
- [ ] `verifyCertificate()` возвращает `false` при spend > budget (crafted non-compliant proof)
- [ ] `verifyCertificate()` возвращает `false` при recipient не из allowlist
- [ ] `verifyCertificate()` возвращает `false` при нарушении schema (отсутствует обязательное поле)
- [ ] `verifyCertificate()` возвращает `false` при `actionHash` mismatch (proof из другого действия)
- [ ] Время верификации ≤ 100ms и ~constant (не зависит от размера witness или allowlist)

### Привязка к действию (anti-replay)

- [ ] `cert.actionHash = blake3(action_manifest)` — вычисляется детерминированно
- [ ] Подстановка другого действия при той же proof → `false` (hash не совпадает)

### Middleware интеграция

- [ ] `withPaywall(handler, { policyProof: true })` при отсутствии `X-Policy-Proof` → HTTP 402 `{ reason: "proof_required" }`
- [ ] Невалидная proof → HTTP 402 `{ error: "policy_violation", reason: "invalid_proof" }`
- [ ] Hash mismatch → HTTP 402 `{ reason: "action_hash_mismatch" }`
- [ ] Валидная proof + валидная x402 → HTTP 200

### Пакет

- [ ] `@universal-paywall/policy-certs` публикуется на npm
- [ ] Bundled `vk` поставляется в пакете; кастомный `vk` принимается опционально
- [ ] README: инструкция "запустить prover → получить сертификат → верифицировать"

## Что не входит

- **zkVM general path** (RISC Zero / SP1) — Phase 2, отдельный спек
- **ZK private witness variant** — Phase 3, отдельный спек
- **On-chain верификатор** (Solidity contract для proof verification) — post-MVP
- **Произвольная компиляция политик** — только конкретная 3-clause payment policy
- **Продакшн интеграция в middleware** — PoC хук, не production-ready
- **Поддержка других proof систем** (PLONK, STARKs) — только Groth16 в Phase 1
