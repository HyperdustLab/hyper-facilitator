import { describe, expect, it } from "vitest";

import {
  ChainIdToNetwork,
  EvmNetworkToChainId,
  SupportedEVMNetworks,
  SupportedSVMNetworks,
  SvmNetworkToChainId,
} from "./network";

describe("ChainIdToNetwork", () => {
  it("maps every supported EVM chain id to its network", () => {
    SupportedEVMNetworks.forEach(network => {
      const chainId = EvmNetworkToChainId.get(network);
      expect(chainId).toBeDefined();
      expect(ChainIdToNetwork[chainId!]).toBe(network);
    });
  });

  it("maps every supported SVM chain id to its network", () => {
    SupportedSVMNetworks.forEach(network => {
      const chainId = SvmNetworkToChainId.get(network);
      expect(chainId).toBeDefined();
      expect(ChainIdToNetwork[chainId!]).toBe(network);
    });
  });
});
