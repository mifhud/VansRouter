// Barrel: PROVIDERS now built from providers/registry (transport co-located with models)
import { PROVIDERS, PROVIDER_MODELS } from "../providers/index.js";
export { PROVIDERS, PROVIDER_OAUTH, PROVIDER_MODELS } from "../providers/index.js";

export const OLLAMA_LOCAL_DEFAULT_HOST = "http://localhost:11434";

export function resolveOllamaLocalHost(credentials) {
  const raw = credentials?.providerSpecificData?.baseUrl?.trim();
  return (raw || OLLAMA_LOCAL_DEFAULT_HOST).replace(/\/$/, "");
}

// Region URLs single-source from registry xiaomi-tokenplan.transport
export const XIAOMI_TOKENPLAN_REGIONS = PROVIDERS["xiaomi-tokenplan"]?.regions || {};
export const XIAOMI_TOKENPLAN_DEFAULT_REGION = PROVIDERS["xiaomi-tokenplan"]?.defaultRegion;

export function resolveXiaomiTokenplanBaseUrl(credentials) {
  const region = credentials?.providerSpecificData?.region;
  return XIAOMI_TOKENPLAN_REGIONS[region] || XIAOMI_TOKENPLAN_REGIONS[XIAOMI_TOKENPLAN_DEFAULT_REGION];
}

// Kiro endpoint variants — switchable per connection via providerSpecificData.kiroEndpoint
// Each entry defines the URL, agent-mode header, and user-agent strings.
export const KIRO_ENDPOINTS = {
  codewhisperer: {
    label: "CodeWhisperer",
    url: "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse",
    agentMode: "spec",
    userAgent: "aws-sdk-js/1.0.34 ua/2.1 os/linux#6.18.33 lang/js md/nodejs#22.22.0 api/codewhispererstreaming#1.0.34 m/E KiroIDE-0.12.155-9829e9bba998c546f1ff5bf320b55582283ff7529f40580133990794255fd260",
    xAmzUserAgent: "aws-sdk-js/1.0.34 KiroIDE 0.12.155 9829e9bba998c546f1ff5bf320b55582283ff7529f40580133990794255fd260",
  },
  amazonq: {
    label: "AmazonQ",
    url: "https://q.us-east-1.amazonaws.com/generateAssistantResponse",
    agentMode: "spec",
    userAgent: "aws-sdk-js/1.0.34 ua/2.1 os/linux#6.18.33 lang/js md/nodejs#22.22.0 api/codewhispererstreaming#1.0.34 m/E KiroIDE-0.12.155-9829e9bba998c546f1ff5bf320b55582283ff7529f40580133990794255fd260",
    xAmzUserAgent: "aws-sdk-js/1.0.34 KiroIDE 0.12.155 9829e9bba998c546f1ff5bf320b55582283ff7529f40580133990794255fd260",
  },
  "amazonq-cli": {
    label: "AmazonQ CLI",
    url: "https://q.us-east-1.amazonaws.com/SendMessageStreaming",
    agentMode: "vibe",
    userAgent: "aws-sdk-rust/1.3.9 os/linux lang/rust/1.87.0",
    xAmzUserAgent: "aws-sdk-rust/1.3.9 ua/2.1 api/ssooidc/1.88.0 os/linux lang/rust/1.87.0 m/E app/AmazonQ-For-CLI",
  },
};

export const KIRO_DEFAULT_ENDPOINT = "codewhisperer";

export function resolveKiroEndpoint(credentials) {
  const key = credentials?.providerSpecificData?.kiroEndpoint || KIRO_DEFAULT_ENDPOINT;
  return { key, ...(KIRO_ENDPOINTS[key] || KIRO_ENDPOINTS[KIRO_DEFAULT_ENDPOINT]) };
}

export function getStaticProviderModels(providerId) {
  return PROVIDER_MODELS[providerId] || [];
}
