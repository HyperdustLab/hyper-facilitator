import { ref, computed } from 'vue';
import { createSignerFromProvider, type EIP1193Provider, type Signer } from 'x402-axios';
import axios from 'axios';
import { withPaymentInterceptor } from 'x402-axios';

// Wallet state
const isConnected = ref<boolean>(false);
const address = ref<string | null>(null);
const network = ref<string>('base-sepolia');
const isConnecting = ref<boolean>(false);
const walletError = ref<string | null>(null);
const signer = ref<Signer | null>(null);
const apiClient = ref<ReturnType<typeof withPaymentInterceptor> | null>(null);

// Check if running in browser environment
declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: any[] }) => Promise<any>;
      on: (event: string, handler: (...args: any[]) => void) => void;
      removeListener: (event: string, handler: (...args: any[]) => void) => void;
      isMetaMask?: boolean;
      isCoinbaseWallet?: boolean;
    };
  }
}

// Switch network
async function switchToBaseSepolia(): Promise<void> {
  if (!window.ethereum) return;

  const baseSepoliaChainId = '0x14a34'; // 84532 in hex

  try {
    // Try to switch to Base Sepolia
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: baseSepoliaChainId }],
    });
  } catch (switchError: any) {
    // If network doesn't exist, add it
    if (switchError.code === 4902) {
      try {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [
            {
              chainId: baseSepoliaChainId,
              chainName: 'Base Sepolia',
              nativeCurrency: {
                name: 'Ethereum',
                symbol: 'ETH',
                decimals: 18,
              },
              rpcUrls: ['https://sepolia.base.org'],
              blockExplorerUrls: ['https://sepolia.basescan.org'],
            },
          ],
        });
      } catch (addError) {
        throw new Error('Unable to add Base Sepolia network');
      }
    } else {
      throw switchError;
    }
  }
}

// Connect wallet
export async function connectWallet(): Promise<void> {
  if (typeof window === 'undefined' || !window.ethereum) {
    throw new Error('Please install MetaMask or another Ethereum wallet');
  }

  isConnecting.value = true;
  walletError.value = null;

  try {
    // Request account access
    const accounts = (await window.ethereum.request({
      method: 'eth_requestAccounts',
    })) as string[];

    if (accounts.length === 0) {
      throw new Error('No accounts found');
    }

    // Switch to Base Sepolia network
    await switchToBaseSepolia();

    // Get current network
    const chainId = (await window.ethereum.request({
      method: 'eth_chainId',
    })) as string;

    // Create signer
    const provider = window.ethereum as unknown as EIP1193Provider;
    const walletSigner = await createSignerFromProvider(network.value, provider, accounts[0] as `0x${string}`);

    // Create axios instance with payment interceptor
    const baseClient = axios.create({
      baseURL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    const clientWithPayment = withPaymentInterceptor(baseClient, walletSigner);

    // Update state
    signer.value = walletSigner;
    apiClient.value = clientWithPayment;
    address.value = accounts[0];
    isConnected.value = true;

    // Listen for account changes
    window.ethereum.on('accountsChanged', handleAccountsChanged);
    window.ethereum.on('chainChanged', handleChainChanged);
  } catch (error: any) {
    walletError.value = error.message || 'Wallet connection failed';
    throw error;
  } finally {
    isConnecting.value = false;
  }
}

// Handle account changes
function handleAccountsChanged(newAccounts: string[]) {
  if (newAccounts.length === 0) {
    disconnectWallet();
  } else if (newAccounts[0] !== address.value) {
    address.value = newAccounts[0];
  }
}

// Handle network changes
function handleChainChanged() {
  window.location.reload();
}

// Disconnect wallet
export function disconnectWallet(): void {
  if (window.ethereum) {
    window.ethereum.removeListener('accountsChanged', handleAccountsChanged);
    window.ethereum.removeListener('chainChanged', handleChainChanged);
  }

  isConnected.value = false;
  address.value = null;
  signer.value = null;
  apiClient.value = null;
  walletError.value = null;
}

// Get API client
export function getApiClient() {
  if (!apiClient.value) {
    throw new Error('Please connect wallet first');
  }
  return apiClient.value;
}

// Export composable
export function useWallet() {
  return {
    isConnected: computed(() => isConnected.value),
    address: computed(() => address.value),
    network: computed(() => network.value),
    isConnecting: computed(() => isConnecting.value),
    walletError: computed(() => walletError.value),
    signer: computed(() => signer.value),
    connectWallet,
    disconnectWallet,
    getApiClient,
  };
}

