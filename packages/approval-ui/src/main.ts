import {
  createWalletClient,
  custom,
  defineChain,
  type Chain,
  type EIP1193Provider,
} from "viem";

/**
 * Production browser approval page for the Universal Paywall exact x402 rail.
 *
 * Part of @universal-paywall/approval-ui. Served by mnemonic-mcp at
 * /approve?operation_id=...&quote_id=...
 *
 * Uses the user's injected MetaMask wallet (window.ethereum) to sign an
 * EIP-3009 TransferWithAuthorization, then submits the signed authorization
 * back to the approval server for settlement.
 *
 * The signing logic is framework-agnostic vanilla JS/TS so it can be wrapped by
 * React/Vue/Svelte consumers later.
 */

declare global {
  interface Window {
    ethereum?: EIP1193Provider & { isMetaMask?: boolean };
  }
}

interface Binding {
  operation_id: string;
  amount: string;
  asset: `0x${string}`;
  pay_to: `0x${string}`;
  network: string;
  nonce: `0x${string}`;
}

interface Quote {
  quote_id: string;
  binding: Binding;
}

interface NativeCurrency {
  name: string;
  symbol: string;
  decimals: number;
}

interface ChainConfig {
  name: string;
  rpc_url: string;
  native_currency: NativeCurrency;
  eip712_name?: string;
  eip712_version?: string;
}

const UI = {
  loading: document.getElementById("loading") as HTMLElement,
  details: document.getElementById("details") as HTMLElement,
  approveBtn: document.getElementById("approve-btn") as HTMLButtonElement,
  status: document.getElementById("status") as HTMLElement,
  operationId: document.getElementById("operation-id") as HTMLElement,
  amount: document.getElementById("amount") as HTMLElement,
  asset: document.getElementById("asset") as HTMLElement,
  payTo: document.getElementById("pay-to") as HTMLElement,
};

const params = new URLSearchParams(window.location.search);
const operationId = params.get("operation_id");
const quoteId = params.get("quote_id");

function showStatus(message: string, isError: boolean) {
  UI.status.textContent = message;
  UI.status.className = isError ? "err" : "ok";
}

function hideLoading() {
  UI.loading.classList.add("hidden");
  UI.details.classList.remove("hidden");
}

function parseChainId(network: string): number {
  // network is expected to be "eip155:<chainId>"
  if (!network || !network.startsWith("eip155:")) {
    throw new Error(`Unsupported network format: ${network}`);
  }
  return Number(network.slice("eip155:".length));
}

async function loadQuote(): Promise<Quote> {
  if (!operationId) {
    throw new Error("missing operation_id");
  }
  const res = await fetch(`/api/quote/${encodeURIComponent(operationId)}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to load quote: ${res.status} ${body}`);
  }
  return (await res.json()) as Quote;
}

function detectEthereumProvider(): EIP1193Provider {
  const provider = window.ethereum;
  if (!provider) {
    throw new Error("No Ethereum wallet detected. Please install MetaMask.");
  }
  if (!provider.isMetaMask) {
    // Some wallets set isMetaMask=true for compatibility; we still allow
    // any EIP-1193 provider, but warn if it is clearly not MetaMask.
    console.warn("Detected a non-MetaMask injected wallet; continuing anyway.");
  }
  return provider;
}

async function loadChainConfig(chainId: number): Promise<ChainConfig | null> {
  const res = await fetch(`/api/chains/${chainId}`);
  if (!res.ok) {
    // For chains MetaMask already knows (mainnet, Base, Arbitrum, etc.) we
    // can switch by chainId only. For local/dev chains the server must
    // provide the metadata.
    return null;
  }
  return (await res.json()) as ChainConfig;
}

async function ensureChain(
  walletClient: ReturnType<typeof createWalletClient>,
  chainId: number,
  chainConfig: ChainConfig | null
): Promise<Chain | undefined> {
  // If the server gave us chain metadata, build a full chain definition so
  // MetaMask can add the network if needed. Otherwise trust the wallet to
  // already know the chain.
  const chain = chainConfig
    ? defineChain({
        id: chainId,
        name: chainConfig.name,
        nativeCurrency: chainConfig.native_currency,
        rpcUrls: { default: { http: [chainConfig.rpc_url] } },
      })
    : undefined;

  // Check current chain.
  const currentChainId = await walletClient.getChainId();
  if (currentChainId === chainId) return chain;

  // Request switch.
  try {
    await walletClient.switchChain({ id: chainId });
  } catch (switchError: unknown) {
    // 4902 = chain not added; try to add it. This requires chain metadata.
    const code = (switchError as { code?: number }).code;
    if (code === 4902) {
      if (!chain) {
        throw new Error(
          `Chain ${chainId} is not in your wallet and the server did not provide chain metadata.`
        );
      }
      await walletClient.addChain({ chain });
      await walletClient.switchChain({ id: chainId });
    } else {
      throw switchError;
    }
  }
  return chain;
}

async function signAndSettle(binding: Binding) {
  const provider = detectEthereumProvider();
  const chainId = parseChainId(binding.network);

  const walletClient = createWalletClient({
    transport: custom(provider),
  });

  const accounts = await walletClient.requestAddresses();
  if (!accounts || accounts.length === 0) {
    throw new Error("No accounts available. Please unlock MetaMask.");
  }
  const account = accounts[0];

  // Ensure the wallet is on the right chain. The RPC URL used here is only
  // for the chain definition metadata; actual signing happens client-side.
  const chainConfig = await loadChainConfig(chainId);
  await ensureChain(walletClient, chainId, chainConfig);

  const value = BigInt(binding.amount);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const validAfter = now - 60n;
  const validBefore = now + 300n;

  // The nonce MUST match the operation binding exactly; the facilitator
  // validates the binding digest on settlement.
  const nonce = binding.nonce;

  // Use EIP-712 domain metadata from the server when available; fall back to
  // common USDC defaults for production mainnet chains.
  const eip712Name = chainConfig?.eip712_name ?? "USD Coin";
  const eip712Version = chainConfig?.eip712_version ?? "2";

  const signature = await walletClient.signTypedData({
    account,
    domain: {
      name: eip712Name,
      version: eip712Version,
      chainId,
      verifyingContract: binding.asset,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: account,
      to: binding.pay_to,
      value,
      validAfter,
      validBefore,
      nonce,
    },
  });

  const authorization = {
    scheme: "exact" as const,
    payer_wallet: account,
    authorization: {
      signature,
      authorization: {
        from: account,
        to: binding.pay_to,
        value: value.toString(),
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    },
  };

  const settleRes = await fetch("/api/settle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operation_id: operationId, binding, authorization }),
  });

  if (!settleRes.ok) {
    const body = await settleRes.text();
    throw new Error(`Settlement failed: ${settleRes.status} ${body}`);
  }
}

async function linkWallet() {
  if (!operationId) throw new Error("missing operation_id");
  const response = await fetch(`/api/wallet-link/${encodeURIComponent(operationId)}`);
  if (!response.ok) throw new Error(`Wallet-link challenge unavailable: ${response.status}`);
  const { message } = (await response.json()) as { message: string };
  const provider = detectEthereumProvider();
  const walletClient = createWalletClient({ transport: custom(provider) });
  const accounts = await walletClient.requestAddresses();
  if (!accounts?.[0]) throw new Error("No accounts available. Please unlock MetaMask.");
  const signature = await walletClient.signMessage({ account: accounts[0], message });
  const verified = await fetch(`/api/wallet-link/${encodeURIComponent(operationId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ signature }),
  });
  if (!verified.ok) throw new Error(`Wallet-link signature rejected: ${verified.status}`);
}

async function init() {
  if (!operationId) {
    showStatus("Missing operation_id in URL.", true);
    return;
  }

  // Before a quote exists, this page proves that the wallet belongs to the
  // authenticated Mnemonic operation. The client then resubmits its same
  // signed artifact to receive the quote bound to this verified address.
  if (!quoteId) {
    try {
      hideLoading();
      UI.operationId.textContent = operationId;
      UI.approveBtn.disabled = false;
      UI.approveBtn.textContent = "Link wallet";
    } catch (err: unknown) {
      showStatus(`Failed to prepare wallet link: ${String(err)}`, true);
    }
    return;
  }

  try {
    const quote = await loadQuote();
    const binding = quote.binding;
    if (!binding) {
      throw new Error("Quote did not include a binding.");
    }
    if (binding.operation_id !== operationId) {
      throw new Error("Operation ID mismatch in quote.");
    }

    UI.operationId.textContent = operationId;
    UI.amount.textContent = binding.amount;
    UI.asset.textContent = binding.asset;
    UI.payTo.textContent = binding.pay_to;

    hideLoading();

    if (!window.ethereum) {
      showStatus("No Ethereum wallet detected. Please install MetaMask.", true);
      return;
    }

    UI.approveBtn.disabled = false;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    showStatus(`Failed to load payment details: ${msg}`, true);
    console.error(err);
  }
}

UI.approveBtn.addEventListener("click", async () => {
  UI.approveBtn.disabled = true;
  UI.approveBtn.textContent = "Confirm in wallet...";

  try {
    if (!quoteId) {
      await linkWallet();
      showStatus("Wallet linked. Return to Mnemonic to continue payment.", false);
      UI.approveBtn.textContent = "Wallet linked";
      return;
    }
    const quote = await loadQuote();
    await signAndSettle(quote.binding);
    showStatus("Payment approved and settled.", false);
    UI.approveBtn.textContent = "Approved";
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    showStatus(`Approval failed: ${msg}`, true);
    UI.approveBtn.disabled = false;
    UI.approveBtn.textContent = "Approve & Pay";
    console.error(err);
  }
});

init();
