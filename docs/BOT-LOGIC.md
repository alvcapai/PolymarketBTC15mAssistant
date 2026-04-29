# BOT-LOGIC — Contratos, Colateral e API L2

Documenta as decisões arquiteturais de integração com a Polymarket após a
migração para USDC Nativo (2026). Claude Code deve ler este arquivo antes de
qualquer refatoração nos scripts de L1 ou nas chamadas de API de L2.

---

## 1. Migração para USDC Nativo (L1)

### 1.1 Endereço do Colateral

| Token | Endereço | Status |
|---|---|---|
| Bridged USDC.e (antigo) | 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174 | **DEPRECIADO — não usar** |
| Native USDC (atual) | 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359 | **ATIVO** |

**Estado atual do código:** executor.js:46 e redeemer.js:8 ainda definem
USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174". A migração para
o Native USDC é uma tarefa prioritária.

### 1.2 Roteadores de Allowance (Native USDC)

A Polymarket agora roteia allowances por múltiplos roteadores. Para evitar falhas de "Insufficient Allowance" na L2, o bot deve aprovar os seguintes endereços:

| Roteador | Endereço Completo | Função |
|---|---|---|
| Router 1 | 0xE111180000d2663C0091e4f400237545B87B996B | Primary Routing |
| Router 2 | 0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296 | Secondary Routing |

> **Nota:** Jamais aprovar a antiga CTF Exchange (0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E) para Native USDC, pois ela não suporta o novo padrão de colateral.

### 1.3 Ação obrigatória para Claude Code

Ao reescrever qualquer script que chame approve() no USDC:
- O token aprovado deve ser o **Native USDC** (0x3c499c...)
- O destinatário (spender) deve ser **ambos os roteadores acima** (Router 1 e Router 2).
- Usar **Ethers v6** com o seguinte shim para compatibilidade com o SDK da Polymarket:
  ```javascript
  signer._signTypedData = (...args) => signer.signTypedData(...args);
  ```

---

## 2. Scripts de L1 — Precisam Ser Criados/Refatorados

| Script | Função |
|---|---|
| scripts/approve_usdc.js | Aprovar os roteadores 0xE111... e 0xd91E... no contrato do Native USDC |
| scripts/deposit_usdc.js | Depositar USDC nativo no CLOB (L2) |
| scripts/redeem.js | Resgate de posições vencedoras via Conditional Tokens Framework |

### Requisitos de Implementação

1. **Proxy Wallet:** O bot opera via uma Proxy Wallet (0x8F7997DaE506b36c1F70bA518F8fD7bF33E1A267). Os scripts de L1 devem garantir que as ações sejam tomadas pela carteira Owner (0xBb0c...) em favor da Proxy.
2. **Network Safety:** Injetar socks-proxy-agent no JsonRpcProvider (ver docs/AGENT-OPS.md).
3. **RPC:** Utilizar RPCs resilientes: https://polygon-bor-rpc.publicnode.com ou https://1rpc.io/matic.

---

## 3. Schema da API L2 — /balance-allowance

O payload do endpoint /balance-allowance da CLOB API retorna o objeto allowances.

```json
{
  "balance": "100.00",
  "allowances": {
    "0xE111180000d2663C0091e4f400237545B87B996B": "unlimited",
    "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296": "unlimited"
  }
}
```

**Refatoração Necessária:** O executor.js deve ser atualizado para verificar se a allowance em pelo menos um dos roteadores ativos é maior que o valor da stake pretendida.

---

## 4. Otimização de Performance (CPU Load)

O bot atualmente consome 100% de CPU em instâncias de 1 core devido ao loop de 1s com cálculos de TA pesados. Claude Code deve aplicar:

1. **Throttling:** Aumentar pollIntervalMs para 5000ms.
2. **Lazy TA:** Recalcular indicadores (RSI, VWAP, MACD) apenas no fechamento de vela (cache) ou a cada 60s, não a cada poll.
3. **I/O:** Renderizar logs e tela a cada 10s.

---

## 5. Referência rápida de endereços

```
Native USDC (Polygon):    0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359  ← USAR
CTF Framework (redeem):   0x4D97DCd97eC945f40cF65F87097ACe5EA0476045  ← USAR (redeemer.js)
CTF Exchange (trading):   0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E  ← MORTA
USDC.e (bridged):         0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174  ← DEPRECIADO
```
