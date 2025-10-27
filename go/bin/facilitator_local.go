package main

import (
    "encoding/json"
    "fmt"
    "log"
    "net/http"
    "os"
    "strconv"
    "time"
)

// Types aligned with typescript/packages/x402/src/types/verify/x402Specs.ts

type SupportedKind struct {
    X402Version int               `json:"x402Version"`
    Scheme      string            `json:"scheme"`
    Network     string            `json:"network"`
    Extra       map[string]any    `json:"extra,omitempty"`
}

type SupportedKindsResponse struct {
    Kinds []SupportedKind `json:"kinds"`
}

type ExactEvmAuthorization struct {
    From        string `json:"from"`
    To          string `json:"to"`
    Value       string `json:"value"`
    ValidAfter  string `json:"validAfter"`
    ValidBefore string `json:"validBefore"`
    Nonce       string `json:"nonce"`
}

type ExactEvmPayload struct {
    Signature     string                `json:"signature"`
    Authorization *ExactEvmAuthorization `json:"authorization"`
}

type PaymentPayload struct {
    X402Version int              `json:"x402Version"`
    Scheme      string           `json:"scheme"`
    Network     string           `json:"network"`
    // Support either EVM or an opaque payload; keep it generic here
    Payload     json.RawMessage  `json:"payload"`
}

type PaymentRequirements struct {
    Scheme            string           `json:"scheme"`
    Network           string           `json:"network"`
    MaxAmountRequired string           `json:"maxAmountRequired"`
    Resource          string           `json:"resource"`
    Description       string           `json:"description"`
    MimeType          string           `json:"mimeType"`
    OutputSchema      *json.RawMessage `json:"outputSchema,omitempty"`
    PayTo             string           `json:"payTo"`
    MaxTimeoutSeconds int              `json:"maxTimeoutSeconds"`
    Asset             string           `json:"asset"`
    Extra             *json.RawMessage `json:"extra,omitempty"`
}

type VerifyRequest struct {
    X402Version        int                 `json:"x402Version"`
    PaymentPayload     PaymentPayload      `json:"paymentPayload"`
    PaymentRequirements PaymentRequirements `json:"paymentRequirements"`
}

type VerifyResponse struct {
    IsValid      bool    `json:"isValid"`
    InvalidReason *string `json:"invalidReason,omitempty"`
    Payer        *string `json:"payer,omitempty"`
}

type SettleRequest struct {
    X402Version        int                 `json:"x402Version"`
    PaymentPayload     PaymentPayload      `json:"paymentPayload"`
    PaymentRequirements PaymentRequirements `json:"paymentRequirements"`
}

type SettleResponse struct {
    Success     bool    `json:"success"`
    ErrorReason *string `json:"errorReason,omitempty"`
    Payer       *string `json:"payer,omitempty"`
    Transaction string  `json:"transaction"`
    Network     string  `json:"network"`
}

type DiscoveryListResponse struct {
    X402Version int `json:"x402Version"`
    Items       []any `json:"items"`
    Pagination  struct {
        Limit  int `json:"limit"`
        Offset int `json:"offset"`
        Total  int `json:"total"`
    } `json:"pagination"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    _ = json.NewEncoder(w).Encode(v)
}

func parseExactEvmFrom(raw json.RawMessage) *ExactEvmPayload {
    var evm ExactEvmPayload
    if err := json.Unmarshal(raw, &evm); err != nil {
        return nil
    }
    if evm.Authorization == nil {
        return nil
    }
    return &evm
}

func handleSupported(supported []SupportedKind) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        writeJSON(w, http.StatusOK, SupportedKindsResponse{Kinds: supported})
    }
}

func handleVerify(w http.ResponseWriter, r *http.Request) {
    var req VerifyRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, fmt.Sprintf("invalid json: %v", err), http.StatusBadRequest)
        return
    }

    if req.PaymentPayload.Scheme != req.PaymentRequirements.Scheme || req.PaymentPayload.Network != req.PaymentRequirements.Network {
        reason := "invalid_payment_requirements"
        writeJSON(w, http.StatusOK, VerifyResponse{IsValid: false, InvalidReason: &reason})
        return
    }

    var payer *string
    // If EVM payload, extract payer from authorization.from
    if evm := parseExactEvmFrom(req.PaymentPayload.Payload); evm != nil && evm.Authorization != nil {
        payer = &evm.Authorization.From
    }

    writeJSON(w, http.StatusOK, VerifyResponse{IsValid: true, Payer: payer})
}

func handleSettle(w http.ResponseWriter, r *http.Request) {
    var req SettleRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, fmt.Sprintf("invalid json: %v", err), http.StatusBadRequest)
        return
    }

    // Basic consistency check similar to verify
    if req.PaymentPayload.Scheme != req.PaymentRequirements.Scheme || req.PaymentPayload.Network != req.PaymentRequirements.Network {
        reason := "invalid_payment_requirements"
        writeJSON(w, http.StatusOK, SettleResponse{Success: false, ErrorReason: &reason, Transaction: "0x0000000000000000000000000000000000000000", Network: req.PaymentPayload.Network})
        return
    }

    var payer *string
    if evm := parseExactEvmFrom(req.PaymentPayload.Payload); evm != nil && evm.Authorization != nil {
        payer = &evm.Authorization.From
    }

    // Return a fake address-like transaction id (passes MixedAddressRegex)
    tx := "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    resp := SettleResponse{
        Success:     true,
        Payer:       payer,
        Transaction: tx,
        Network:     req.PaymentPayload.Network,
    }
    writeJSON(w, http.StatusOK, resp)
}

func handleDiscovery(w http.ResponseWriter, r *http.Request) {
    limit := 0
    offset := 0
    if v := r.URL.Query().Get("limit"); v != "" {
        if n, err := strconv.Atoi(v); err == nil {
            limit = n
        }
    }
    if v := r.URL.Query().Get("offset"); v != "" {
        if n, err := strconv.Atoi(v); err == nil {
            offset = n
        }
    }

    resp := DiscoveryListResponse{X402Version: 1, Items: []any{}}
    resp.Pagination.Limit = limit
    resp.Pagination.Offset = offset
    resp.Pagination.Total = 0
    writeJSON(w, http.StatusOK, resp)
}

func main() {
    // Config via env vars
    // FAC_PORT: port to listen on (default 8787)
    // FAC_SCHEME: default scheme (default "exact")
    // FAC_NETWORKS: comma-separated list of networks (default "base-sepolia")
    port := os.Getenv("FAC_PORT")
    if port == "" {
        port = "8787"
    }
    scheme := os.Getenv("FAC_SCHEME")
    if scheme == "" {
        scheme = "exact"
    }
    networks := os.Getenv("FAC_NETWORKS")
    if networks == "" {
        networks = "base-sepolia"
    }

    // Build supported kinds
    supported := []SupportedKind{}
    for _, n := range splitAndTrim(networks) {
        supported = append(supported, SupportedKind{
            X402Version: 1,
            Scheme:      scheme,
            Network:     n,
        })
    }

    mux := http.NewServeMux()
    mux.HandleFunc("/supported", handleSupported(supported))
    mux.HandleFunc("/verify", handleVerify)
    mux.HandleFunc("/settle", handleSettle)
    mux.HandleFunc("/discovery/resources", handleDiscovery)

    srv := &http.Server{
        Addr:              ":" + port,
        Handler:           logRequests(mux),
        ReadHeaderTimeout: 5 * time.Second,
    }

    log.Printf("x402 local facilitator listening on :%s (scheme=%s networks=%s)\n", port, scheme, networks)
    if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
        log.Fatalf("server error: %v", err)
    }
}

func logRequests(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        log.Printf("%s %s", r.Method, r.URL.String())
        next.ServeHTTP(w, r)
    })
}

func splitAndTrim(s string) []string {
    out := []string{}
    cur := ""
    for _, ch := range s {
        if ch == ',' {
            if t := trimSpace(cur); t != "" {
                out = append(out, t)
            }
            cur = ""
            continue
        }
        cur += string(ch)
    }
    if t := trimSpace(cur); t != "" {
        out = append(out, t)
    }
    return out
}

func trimSpace(s string) string {
    i := 0
    j := len(s)
    for i < j && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r') {
        i++
    }
    for j > i && (s[j-1] == ' ' || s[j-1] == '\t' || s[j-1] == '\n' || s[j-1] == '\r') {
        j--
    }
    return s[i:j]
}

