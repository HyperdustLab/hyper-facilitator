# Demo Proxy

This is a universal proxy for demo purposes. **It is not meant for production** It makes any website or API payable via x402.

To run

```
go run proxy_demo.go <config.json>
```

Example of all possible keys can be found in `example_config.json`. The Minimal set of keys are:

```json
{
  "targetURL": "https://httpbin.org",
  "amount": 0.01,
  "payTo": "0x<your address>"
}
```

## Local Facilitator (no-auth, mock)

For local development without external dependencies, a minimal facilitator server is available. It implements the x402 facilitator interface with in-memory, mock semantics (no on-chain settlement):

Endpoints:
- `GET /supported` – returns supported `(scheme, network)` pairs
- `POST /verify` – basic consistency checks; always returns `isValid: true` if request is well-formed
- `POST /settle` – returns a success response with a fake transaction id
- `GET /discovery/resources` – returns an empty paginated list

Run:
```
go run facilitator_local.go
```

Environment variables:
- `FAC_PORT` – listen port (default: `8787`)
- `FAC_SCHEME` – scheme (default: `exact`)
- `FAC_NETWORKS` – comma-separated networks (default: `base-sepolia`)

Wire up examples to use it by pointing facilitator URL to `http://localhost:8787`, e.g.:
- TypeScript examples: set `FACILITATOR_URL=http://localhost:8787`
- Go proxy config (`example_config.json`): set `"facilitatorURL": "http://localhost:8787"`

Note: This facilitator is suitable for interface testing only. Replace with your real Hyper-x402 facilitator once ready.
