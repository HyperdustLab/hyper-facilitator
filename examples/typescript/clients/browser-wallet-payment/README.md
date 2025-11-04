# x402 Browser Wallet Payment Example - Vue3

This is a frontend example built with Vue3 framework that demonstrates how to use browser wallets (e.g., MetaMask) for x402 payments.

## Features

- ✅ Browser wallet connection (MetaMask, Coinbase Wallet, etc.)
- ✅ Automatic network switching (Base Sepolia)
- ✅ Create signer using `createSignerFromProvider`
- ✅ Automatic handling of 402 payment responses
- ✅ Real-time operation logs
- ✅ Responsive design

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables (Optional)

Create a `.env` file:

```env
VITE_API_BASE_URL=http://localhost:3001
```

If not configured, it defaults to `http://localhost:3001`.

### 3. Start Development Server

```bash
npm run dev
```

This will start the development server and open the browser at `http://localhost:5173` by default.

### 4. Build for Production

```bash
npm run build
```

The built files will be output to the `dist` directory.

### 5. Preview Production Build

```bash
npm run preview
```

## Usage

### 1. Connect Wallet

1. Ensure MetaMask or another Ethereum wallet extension is installed
2. Click the "Connect Wallet" button
3. Confirm the connection request in the wallet
4. If the current network is not Base Sepolia, the system will automatically prompt to switch networks

### 2. Make Payment Request

1. Enter the API endpoint in the input box in the "Make Payment Request" section
   - Example: `/api/premium-content`
   - Or: `/api/pay/session`
2. Click the "Make Request" button
3. If the server returns 402 Payment Required, the system will automatically:
   - Create payment signature
   - Request user signature in the wallet
   - Add payment header to the request
   - Retry the request

### 3. View Results

- Request results will be displayed in the "Request Result" area
- All operations will be recorded in the "Operation Logs"

## Project Structure

```
browser-wallet-payment/
├── src/
│   ├── composables/
│   │   ├── useWallet.ts      # Wallet connection logic
│   │   └── usePayment.ts      # Payment request logic
│   ├── utils/
│   │   └── logger.ts          # Logging utility
│   ├── App.vue                # Main component
│   ├── main.ts                # Application entry
│   ├── style.css              # Global styles
│   └── vite-env.d.ts          # Type definitions
├── index.html                 # HTML template
├── package.json               # Project configuration
├── tsconfig.json              # TypeScript configuration
├── vite.config.ts             # Vite configuration
└── README.md                   # Documentation
```

## Tech Stack

- **Vue 3**: Progressive JavaScript framework
- **TypeScript**: Type-safe JavaScript
- **Vite**: Next-generation frontend build tool
- **x402-axios**: x402 payment protocol client
- **viem**: Ethereum TypeScript interface

## Important Notes

1. **Network Requirements**: Ensure your wallet is connected to the **Base Sepolia** test network
2. **Token Requirements**: You need to have USDC tokens on the Base Sepolia network to complete payments
3. **Test Tokens**: 
   - ETH: [Coinbase Faucet](https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet)
   - USDC: [Circle Faucet](https://faucet.circle.com/)

## Development

### Core Functionality

#### 1. Wallet Connection (`src/composables/useWallet.ts`)

Use the `createSignerFromProvider` function to create a signer:

```typescript
const walletSigner = await createSignerFromProvider(
  network.value,
  provider,
  accounts[0] as `0x${string}`
);
```

#### 2. Payment Request (`src/composables/usePayment.ts`)

Wrap axios instance with `withPaymentInterceptor` to automatically handle 402 responses:

```typescript
const clientWithPayment = withPaymentInterceptor(baseClient, walletSigner);
```

### Custom Configuration

#### Modify API Base URL

Set in the `.env` file:

```env
VITE_API_BASE_URL=https://your-api-server.com
```

#### Modify Default Network

Modify in `src/composables/useWallet.ts`:

```typescript
const network = ref<string>('base-sepolia'); // Change to other supported networks
```

## Troubleshooting

### Wallet Connection Failed

- Ensure wallet extension (MetaMask, etc.) is installed
- Check if wallet is unlocked
- Check browser console for error messages

### Payment Failed

- Ensure wallet is connected to Base Sepolia network
- Ensure account has sufficient USDC tokens
- Check if API server is running normally
- Check error messages in operation logs

### Network Switch Failed

- Manually add Base Sepolia network in wallet
- Network configuration:
  - Chain ID: 84532
  - RPC URL: https://sepolia.base.org
  - Block Explorer: https://sepolia.basescan.org

## License

This example code follows the project's license.
