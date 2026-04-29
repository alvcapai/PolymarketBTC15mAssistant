# BOT-LOGIC — Contratos, Colateral e API L2

Documenta as decisões arquiteturais de integração com a Polymarket após a
migração para USDC Nativo (2026). Claude Code deve ler este arquivo antes de
qualquer refatoração nos scripts de L1 ou nas chamadas de API de L2.

---

## 1. Migração para USDC Nativo (L1)

### 1.1 Endereço do Colateral

| Token | Endereço | Status |
|---|---|---|
| Bridged USDC.e (antigo) | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` | **DEPRECIADO — não usar** |
| Native USDC (atual) | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` | **ATIVO** |

**Estado atual do código:** `executor.js:46` e `redeemer.js:8` ainda definem
`USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"`. A migração para
o Native USDC é uma tarefa pendente nesses dois arquivos.

Todos os approvals e transfers de L1 devem referenciar exclusivamente o
endereço do Native USDC.

### 1.2 Depreciação da CTF Exchange de Trading

O contrato de **exchange para trading** da Polymarket
(`0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E`) está morto. A Polymarket agora
roteia allowances por múltiplos roteadores:

| Roteador | Endereço completo |
|---|---|
| Router 1 | `0xE111...` *(endereço completo a confirmar)* |
| Router 2 | `0xd91E...` *(endereço completo a confirmar)* |
| Router 3 | `0xe222...` *(endereço completo a confirmar)* |

> **Nota:** Os endereços acima estão truncados. Antes de qualquer script de
> approve, confirmar os endereços completos na documentação oficial da Polymarket
> ou no contrato on-chain.

> **Não confundir com o CTF de redemption:** o contrato
> `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` usado em `redeemer.js` é o
> **Conditional Tokens Framework** (resgate de posições vencedoras) — esse
> contrato é diferente e continua válido.

### 1.3 Ação obrigatória para Claude Code

Ao reescrever qualquer script que chame `approve()` no USDC:
- O token aprovado deve ser o **Native USDC** (`0x3c499c...`)
- O destinatário (`spender`) deve ser **cada um dos três roteadores acima**
- Jamais aprovar a CTF Exchange `0x4bFb...`

---

## 2. Scripts de L1 — Precisam Ser Criados

Os scripts de L1 listados abaixo **não existem no repositório**. Precisam ser
criados do zero (não há versão antiga a recuperar):

| Script | Função |
|---|---|
| `scripts/approve_usdc.js` | Aprovar os três roteadores da Polymarket a gastar USDC |
| `scripts/deposit_usdc.js` | Depositar USDC nativo no CLOB |
| `scripts/redeem.js` | Script manual de resgate de posições vencedoras |

### Requisitos para implementação

1. Usar o endereço do **Native USDC** (`0x3c499c...`)
2. Aprovar os **três roteadores** individualmente com `approve(router, amount)`
3. Usar **ethers v6** (versão instalada no projeto — importar de `"ethers"`)
4. Injetar `socks-proxy-agent` no `JsonRpcProvider` (ver `AGENT-OPS.md` — RPCs de Polygon vazam pelo IP real sem isso)
5. Carregar `PK` via `dotenv` (mesmo padrão de `executor.js` e `redeemer.js`)

---

## 3. Schema da API L2 — `/balance-allowance`

O payload do endpoint `/balance-allowance` da CLOB API **mudou**:

### Formato antigo (não usar em código novo)

```json
{
  "balance": "100.00",
  "allowance": "50.00"
}
```

### Formato atual

```json
{
  "balance": "100.00",
  "allowances": {
    "0xE111...": "50.00",
    "0xd91E...": "50.00",
    "0xe222...": "50.00"
  }
}
```

O campo singular `"allowance"` foi substituído pelo objeto `"allowances"` que
mapeia cada roteador ao seu saldo permitido.

**Estado atual do código:** `executor.js:fetchUsdcBalance()` lê apenas
`body.balance` e ignora o campo de allowance. Isso é suficiente para a operação
atual do bot. Código futuro que precise verificar allowances por roteador deve
iterar `body.allowances`.

---

## 4. Referência rápida de endereços

```
Native USDC (Polygon):    0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359  ← USAR
CTF Framework (redeem):   0x4D97DCd97eC945f40cF65F87097ACe5EA0476045  ← USAR (redeemer.js)
CTF Exchange (trading):   0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E  ← MORTA, nunca usar
USDC.e (bridged):         0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174  ← DEPRECIADO, nunca usar
```
